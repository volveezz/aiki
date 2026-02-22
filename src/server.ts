import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchTool } from "./tools/search.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerIndexTool } from "./tools/index-files.js";
import { closeAll } from "./store/collection.js";
import { log } from "./utils/config.js";

const server = new McpServer({
  name: "aiki",
  version: "1.0.0",
});

registerSearchTool(server);
registerRememberTool(server);
registerIndexTool(server);

function shutdown() {
  log("info", "Shutting down...");
  closeAll();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "Aiki MCP server started");
