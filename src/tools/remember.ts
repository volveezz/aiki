import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { embedSingle } from "../embedding/mistral.js";
import { getProjectCollection, getGlobalCollection } from "../store/collection.js";
import { toWslPath, contentHash } from "../utils/paths.js";
import { log } from "../utils/config.js";

export function registerRememberTool(server: McpServer) {
  server.tool(
    "remember",
    "Store knowledge for future retrieval — decisions, patterns, bugs, preferences",
    {
      content: z.string().describe("The knowledge to store"),
      scope: z.enum(["project", "global"]).default("project").describe("Storage scope"),
      chunk_type: z
        .enum(["code", "decision", "pattern", "bug", "design"])
        .default("decision")
        .describe("Knowledge type (project scope)"),
      tags: z.array(z.string()).default([]).describe("Freeform tags for filtering"),
      project_path: z.string().optional().describe("Windows project path (required for project scope)"),
      category: z
        .enum(["style", "pattern", "preference", "solution"])
        .optional()
        .describe("Category (required for global scope)"),
      topic: z.string().optional().describe('Topic like "typescript", "react" (required for global scope)'),
    },
    async ({ content, scope, chunk_type, tags, project_path, category, topic }) => {
      try {
        const id = contentHash(content);
        const embedding = await embedSingle(content);

        if (scope === "project") {
          if (!project_path) {
            return {
              content: [{ type: "text" as const, text: "project_path is required for project scope" }],
              isError: true,
            };
          }

          const col = getProjectCollection(toWslPath(project_path));
          col.upsertSync({
            id,
            vectors: { embedding },
            fields: {
              file_path: "",
              chunk_type,
              language: "",
              content,
              summary: content.slice(0, 200),
              tags,
              last_modified: Date.now(),
            },
          });
          col.optimizeSync();

          log("info", `Stored project memory: ${id}`);
          return { content: [{ type: "text" as const, text: `Stored in project collection (id: ${id})` }] };
        }

        if (!category || !topic) {
          return {
            content: [{ type: "text" as const, text: "category and topic are required for global scope" }],
            isError: true,
          };
        }

        const col = getGlobalCollection();
        col.upsertSync({
          id,
          vectors: { embedding },
          fields: {
            category,
            topic,
            content,
            confidence: 1,
            source_project: project_path ? toWslPath(project_path) : "",
          },
        });
        col.optimizeSync();

        log("info", `Stored global memory: ${id}`);
        return {
          content: [
            { type: "text" as const, text: `Stored in global collection (id: ${id}, ${category}/${topic})` },
          ],
        };
      } catch (err) {
        const msg = (err as Error).message;
        log("error", `Remember failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Remember error: ${msg}` }], isError: true };
      }
    },
  );
}
