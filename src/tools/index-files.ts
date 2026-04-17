import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { embed } from "../embedding/mistral.js";
import { getProjectCollection, collectionPath } from "../store/collection.js";
import { toWslPath } from "../utils/paths.js";
import { config, log } from "../utils/config.js";
import { discoverFiles, chunkFile } from "../indexer/chunker.js";
import type { ProjectPathResolver } from "../server-factory.js";

type MtimeCache = Record<string, number>;

const loadMtimeCache = (cachePath: string) => {
  try {
    return JSON.parse(readFileSync(cachePath, "utf-8")) as MtimeCache;
  } catch {
    return {} as MtimeCache;
  }
};

const saveMtimeCache = (cachePath: string, cache: MtimeCache) => {
  writeFileSync(cachePath, JSON.stringify(cache));
};

export function registerIndexTool(server: McpServer, resolveRoot: ProjectPathResolver) {
  server.tool(
    "index",
    "Index source files from a project directory for semantic search. Always does a full scan; unchanged content is deduplicated by content hash.",
    {
      project_path: z.string().optional().describe("Windows project path to index (defaults to client workspace root)"),
      patterns: z.array(z.string()).optional().describe('File extensions to include (e.g. [".ts", ".py"])'),
    },
    async ({ project_path, patterns }) => {
      try {
        const effectivePath = project_path ?? await resolveRoot();
        if (!effectivePath) {
          return {
            content: [{ type: "text" as const, text: "project_path is required (no workspace root detected)" }],
            isError: true,
          };
        }
        const t0 = Date.now();
        const wslPath = toWslPath(effectivePath);
        const colPath = collectionPath(wslPath);
        const cachePath = `${colPath}/mtimes.json`;

        log("info", `Indexing: ${wslPath}`);
        const allFiles = discoverFiles(wslPath, patterns);

        if (allFiles.length === 0) {
          return { content: [{ type: "text" as const, text: "No files found to index." }] };
        }

        const oldCache = loadMtimeCache(cachePath);
        const newCache: MtimeCache = {};
        const changedFiles = allFiles.filter((f) => {
          newCache[f.relPath] = f.mtimeMs;
          return oldCache[f.relPath] !== f.mtimeMs;
        });

        if (changedFiles.length === 0) {
          return { content: [{ type: "text" as const, text: `All ${allFiles.length} files unchanged, nothing to index.` }] };
        }

        log("info", `${changedFiles.length}/${allFiles.length} files changed`);

        const chunks = changedFiles.flatMap((f) => {
          try {
            return chunkFile(f);
          } catch (err) {
            log("warn", `Chunk failed for ${f.relPath}: ${(err as Error).message}`);
            return [];
          }
        });

        const col = getProjectCollection(wslPath);
        const batchSize = config.mistral.batchSize;
        let indexed = 0;

        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const embeddings = await embed(batch.map((c) => c.content));

          const docs = batch.map((chunk, j) => ({
            id: chunk.id,
            vectors: { embedding: embeddings[j] },
            fields: {
              file_path: chunk.filePath,
              chunk_type: chunk.chunkType,
              language: chunk.language ?? "",
              content: chunk.content,
              summary: chunk.summary,
              tags: [] as string[],
              last_modified: Date.now(),
            },
          }));

          col.upsertSync(docs);
          indexed += batch.length;
          log("info", `Batch ${Math.floor(i / batchSize) + 1}: ${indexed}/${chunks.length} chunks`);
        }

        col.optimizeSync();

        mkdirSync(colPath, { recursive: true });
        saveMtimeCache(cachePath, newCache);

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const uniqueFiles = new Set(chunks.map((c) => c.filePath)).size;
        const summary = `Indexed ${indexed} chunks from ${uniqueFiles} changed files (${allFiles.length - changedFiles.length} unchanged, skipped) in ${elapsed}s`;
        log("info", summary);

        return { content: [{ type: "text" as const, text: summary }] };
      } catch (err) {
        const msg = (err as Error).message;
        log("error", `Index failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Index error: ${msg}` }], isError: true };
      }
    },
  );
}
