import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTool } from "./tools/search.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerIndexTool } from "./tools/index-files.js";

export type ProjectPathResolver = () => Promise<string | undefined>;

export function createServer(resolveRoot: ProjectPathResolver) {
  const server = new McpServer({ name: "aiki", version: "1.0.0" });
  registerSearchTool(server, resolveRoot);
  registerRememberTool(server, resolveRoot);
  registerIndexTool(server, resolveRoot);
  return server;
}
