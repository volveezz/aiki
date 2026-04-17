import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server-factory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeAll,
  deleteFromCollection, deleteByFilter,
  deleteGlobal, deleteGlobalByFilter,
  purgeProject, purgeGlobal, getStats,
} from "./store/collection.js";
import { config, log } from "./utils/config.js";

const transports = new Map<string, StreamableHTTPServerTransport>();

function collectBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function jsonError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse) {
  const body = await collectBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonError(res, 400, "Invalid JSON");
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, parsed);
    return;
  }

  if (!sessionId && isInitializeRequest(parsed)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        log("info", `Session initialized: ${sid}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        log("info", `Session closed: ${sid}`);
      }
    };

    let cachedRoot: string | undefined;
    let mcpServer: McpServer;

    /** Resolve workspace root via listRoots with a 3s timeout to avoid blocking tool calls. */
    const resolveRoot = async () => {
      if (cachedRoot) return cachedRoot;
      try {
        const rootsPromise = mcpServer.server.listRoots();
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("listRoots timed out")), 3000),
        );
        const { roots } = await Promise.race([rootsPromise, timeout]);
        const uri = roots[0]?.uri;
        if (uri) {
          const pathname = decodeURIComponent(new URL(uri).pathname);
          cachedRoot = pathname.startsWith("/") && pathname[2] === ":"
            ? pathname.slice(1).replace(/\//g, "\\")
            : pathname;
          log("info", `Session root: ${cachedRoot}`);
        }
      } catch (err) {
        log("warn", `Failed to resolve roots: ${(err as Error).message}`);
      }
      return cachedRoot;
    };

    mcpServer = createServer(resolveRoot);
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      const sid = transport.sessionId;
      if (sid && transports.has(sid)) {
        transports.delete(sid);
      }
      await mcpServer.close().catch(() => {});
      transport.close().catch(() => {});
      throw err;
    }
    return;
  }

  if (sessionId) {
    jsonError(res, 404, "Session not found");
  } else {
    jsonError(res, 400, "Bad Request: No valid session ID provided");
  }
}

async function handleMcpGetOrDelete(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    jsonError(res, 400, "Invalid or missing session ID");
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

function jsonOk(res: ServerResponse, data: Record<string, unknown>) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleAdminDelete(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await collectBody(req));
  } catch {
    jsonError(res, 400, "Invalid JSON");
    return;
  }
  const { scope, project_path, ids, filter } = body as {
    scope?: string; project_path?: string; ids?: string[]; filter?: string;
  };

  if (scope === "global") {
    if (ids?.length) {
      const statuses = deleteGlobal(ids);
      jsonOk(res, { deleted: statuses.filter((s) => s.ok).length, statuses });
    } else if (filter) {
      const status = deleteGlobalByFilter(filter);
      jsonOk(res, { filter, status });
    } else {
      jsonError(res, 400, "Provide ids or filter");
    }
    return;
  }

  if (!project_path) {
    jsonError(res, 400, "project_path required for project scope");
    return;
  }

  if (ids?.length) {
    const statuses = deleteFromCollection(project_path, ids);
    jsonOk(res, { deleted: statuses.filter((s) => s.ok).length, statuses });
  } else if (filter) {
    const status = deleteByFilter(project_path, filter);
    jsonOk(res, { filter, status });
  } else {
    jsonError(res, 400, "Provide ids or filter");
  }
}

async function handleAdminPurge(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await collectBody(req));
  } catch {
    jsonError(res, 400, "Invalid JSON");
    return;
  }
  const { scope, project_path } = body as { scope?: string; project_path?: string };

  if (scope === "global") {
    const purged = purgeGlobal();
    jsonOk(res, { purged, scope: "global" });
    return;
  }

  if (!project_path) {
    jsonError(res, 400, "project_path required for project scope");
    return;
  }

  const purged = purgeProject(project_path);
  jsonOk(res, { purged, project_path });
}

function handleAdminStats(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const projectPath = url.searchParams.get("project_path") ?? undefined;
  const scope = url.searchParams.get("scope") ?? "project";

  if (scope !== "global" && !projectPath) {
    jsonError(res, 400, "project_path required for project scope");
    return;
  }

  const stats = getStats(scope === "global" ? undefined : projectPath);
  if (!stats) {
    jsonOk(res, { exists: false });
    return;
  }
  jsonOk(res, { exists: true, ...stats });
}

function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    sessions: transports.size,
    uptime: process.uptime(),
  }));
}

const httpServer = createHttpServer(async (req, res) => {
  const method = req.method;
  const path = new URL(req.url!, `http://localhost`).pathname;

  try {
    if (path === "/health" && method === "GET") {
      handleHealth(req, res);
    } else if (path === "/mcp" && method === "POST") {
      await handleMcpPost(req, res);
    } else if (path === "/mcp" && (method === "GET" || method === "DELETE")) {
      await handleMcpGetOrDelete(req, res);
    } else if (path === "/admin/delete" && method === "POST") {
      await handleAdminDelete(req, res);
    } else if (path === "/admin/purge" && method === "POST") {
      await handleAdminPurge(req, res);
    } else if (path === "/admin/stats" && method === "GET") {
      handleAdminStats(req, res);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  } catch (err) {
    log("error", `Request error: ${(err as Error).message}`);
    if (!res.headersSent) {
      jsonError(res, 500, "Internal server error");
    }
  }
});

async function shutdown() {
  log("info", "Shutting down...");
  for (const [sid, transport] of transports) {
    try {
      await transport.close();
      log("info", `Closed transport: ${sid}`);
    } catch (err) {
      log("error", `Failed to close transport ${sid}: ${(err as Error).message}`);
    }
  }
  transports.clear();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  closeAll();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  log("fatal", `Uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("fatal", `Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  process.exit(1);
});

const { port } = config.server;
httpServer.listen(port, "0.0.0.0", () => {
  log("info", `Aiki HTTP server listening on 0.0.0.0:${port}`);
});
