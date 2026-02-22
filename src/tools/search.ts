import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import zvec from "@zvec/zvec";
const { ZVecIndexType } = zvec;
import { embedSingle } from "../embedding/mistral.js";
import { getProjectCollection, getGlobalCollection } from "../store/collection.js";
import { toWslPath } from "../utils/paths.js";
import { log } from "../utils/config.js";

const formatResult = (r: { score: number; fields: Record<string, unknown>; source: string }, i: number) => {
  const f = r.fields;
  const fullContent = i < 3;
  const parts = [`${i + 1}. [${r.source}] score=${r.score.toFixed(4)}`];
  if (f.file_path) parts.push(`   file: ${f.file_path}`);
  if (f.summary) parts.push(`   summary: ${f.summary}`);
  if (f.chunk_type) parts.push(`   type: ${f.chunk_type}`);
  if (f.category) parts.push(`   category: ${f.category}`);
  if (f.topic) parts.push(`   topic: ${f.topic}`);
  const tags = f.tags as string[] | undefined;
  if (tags?.length) parts.push(`   tags: ${tags.join(", ")}`);
  if (f.content) {
    const raw = String(f.content);
    const content = fullContent ? raw : raw.slice(0, 300);
    parts.push(`   content: ${content}${!fullContent && raw.length > 300 ? "..." : ""}`);
  }
  return parts.join("\n");
};

export function registerSearchTool(server: McpServer) {
  server.tool(
    "search",
    "Semantic search across stored knowledge and indexed code",
    {
      query: z.string().describe("The search query text"),
      scope: z.enum(["project", "global", "both"]).default("both").describe("Search scope"),
      limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
      filter: z.string().optional().describe("Zvec filter expression"),
      project_path: z.string().optional().describe("Windows project path (required when scope includes project)"),
    },
    async ({ query, scope, limit, filter, project_path }) => {
      try {
        if ((scope === "project" || scope === "both") && !project_path) {
          return {
            content: [{ type: "text" as const, text: "project_path is required when scope includes project" }],
            isError: true,
          };
        }

        const vec = await embedSingle(query);
        const hits: { id: string; score: number; fields: Record<string, unknown>; source: string }[] = [];

        const baseQuery = {
          fieldName: "embedding",
          vector: vec,
          topk: limit,
          includeVector: false,
          params: { indexType: ZVecIndexType.HNSW, ef: 300 },
        };

        if ((scope === "project" || scope === "both") && project_path) {
          const col = getProjectCollection(toWslPath(project_path));
          const q = filter ? { ...baseQuery, filter } : baseQuery;
          const docs = col.querySync(q);
          for (const d of docs) hits.push({ id: d.id, score: d.score, fields: d.fields, source: "project" });
        }

        if (scope === "global" || scope === "both") {
          const col = getGlobalCollection();
          const docs = col.querySync(baseQuery);
          for (const d of docs) hits.push({ id: d.id, score: d.score, fields: d.fields, source: "global" });
        }

        hits.sort((a, b) => b.score - a.score);
        const top = hits.slice(0, limit);

        if (top.length === 0) {
          return { content: [{ type: "text" as const, text: "No results found." }] };
        }

        return { content: [{ type: "text" as const, text: top.map(formatResult).join("\n\n") }] };
      } catch (err) {
        const msg = (err as Error).message;
        log("error", `Search failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Search error: ${msg}` }], isError: true };
      }
    },
  );
}
