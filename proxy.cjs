/**
 * Stdio↔HTTP bridge for Aiki MCP daemon.
 *
 * Session recovery is per-request: 404 triggers inline re-init + retry,
 * promise mutex prevents duplicate sessions from concurrent calls.
 * SSE is best-effort — failures never cascade to tool calls.
 */
const http = require("http");
const { createInterface } = require("readline");
const { execFile } = require("child_process");

const HOST = "127.0.0.1";
const PORT = 4242;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const STARTUP_TIMEOUT_MS = 30000;
const REINIT_TIMEOUT_MS = 15000;
const HEALTH_POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 120000;

let sessionId = null;
let cachedInitLine = null;
let negotiatedProtocolVersion = null;
/** @type {Promise<boolean>|null} */
let reinitLock = null;
let sseReq = null;
let exiting = false;

function exitProxy(code = 0) {
  if (exiting) return;
  exiting = true;
  closeSse();
  process.exit(code);
}

/** @returns {string|null} */
function headerString(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * Why: Node can surface network failures as Error, AggregateError, or nested causes.
 * What: Produces a stable, user-visible message and optional retry classification.
 * How: Recursively inspects common error shapes (`code`, `cause`, `errors`).
 */
function errorDetails(err) {
  const seen = new Set();
  const codes = new Set();
  const messages = [];

  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const code = typeof value.code === "string" ? value.code : null;
    if (code) codes.add(code);

    if (typeof value.message === "string" && value.message.trim()) {
      messages.push(value.message.trim());
    }

    if (Array.isArray(value.errors)) {
      for (const nested of value.errors) visit(nested);
    }

    if (value.cause && typeof value.cause === "object") {
      visit(value.cause);
    }
  };

  if (err && typeof err === "object") {
    visit(err);
  } else if (typeof err === "string" && err.trim()) {
    messages.push(err.trim());
  }

  const codeList = Array.from(codes);
  const message = messages[0] || (codeList[0] ? `network error (${codeList[0]})` : "request failed");
  return { message, codes: codeList };
}

function isTransientNetworkError(err) {
  const { message, codes } = errorDetails(err);
  const transientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);
  if (codes.some((c) => transientCodes.has(c))) return true;
  return /ECONNREFUSED|ECONNRESET|socket hang up|connect ETIMEDOUT/i.test(message);
}

function writeStdoutLine(line) {
  if (exiting) return;
  try {
    process.stdout.write(`${line}\n`);
  } catch (err) {
    const { codes } = errorDetails(err);
    if (codes.includes("EPIPE") || codes.includes("ERR_STREAM_DESTROYED")) {
      exitProxy(0);
      return;
    }
    throw err;
  }
}

function log(msg) {
  if (exiting) return;
  try {
    process.stderr.write(`aiki-proxy: ${msg}\n`);
  } catch {}
}

function handlePipeError(err) {
  const { codes } = errorDetails(err);
  if (codes.includes("EPIPE") || codes.includes("ERR_STREAM_DESTROYED")) {
    exitProxy(0);
  }
}

process.stdout.on("error", handlePipeError);
process.stderr.on("error", handlePipeError);

/* ── Health ──────────────────────────────────────────────────────────── */

const checkHealth = () =>
  new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });

async function pollHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

/* ── HTTP ────────────────────────────────────────────────────────────── */

/** Reads sessionId at call-time so retries after re-init use the fresh session. */
function postMcp(body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (negotiatedProtocolVersion) headers["mcp-protocol-version"] = negotiatedProtocolVersion;

    let settled = false;
    let hardTimer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      fn(value);
    };

    const req = http.request(
      { hostname: HOST, port: PORT, path: "/mcp", method: "POST", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", (err) => settle(reject, err));
        res.on("end", () =>
          settle(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    hardTimer = setTimeout(() => {
      req.destroy();
      const err = new Error("request timeout");
      err.code = "ERR_REQUEST_TIMEOUT";
      settle(reject, err);
    }, timeoutMs);
    req.on("error", (err) => settle(reject, err));
    req.write(body);
    req.end();
  });
}

/** Retries only transient connection failures (ECONNREFUSED/ECONNRESET), not timeouts or HTTP errors. */
async function postRetrying(body, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await postMcp(body);
    } catch (err) {
      lastErr = err;
      if (isTransientNetworkError(err) && i < maxRetries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/* ── Session re-initialization ───────────────────────────────────────── */

function reinitSession() {
  if (reinitLock) return reinitLock;
  reinitLock = performReinit().finally(() => { reinitLock = null; });
  return reinitLock;
}

async function performReinit() {
  if (!cachedInitLine) return false;
  sessionId = null;
  closeSse();

  if (!(await pollHealth(REINIT_TIMEOUT_MS))) {
    log("daemon unreachable during re-init");
    return false;
  }

  try {
    const res = await postMcp(cachedInitLine, 10000);
    const sid = res.status >= 200 && res.status < 300
      ? headerString(res.headers["mcp-session-id"]) : null;
    if (!sid) { log(`re-init HTTP ${res.status}`); return false; }
    negotiatedProtocolVersion = headerString(res.headers["mcp-protocol-version"]) ?? negotiatedProtocolVersion;
    sessionId = sid;
  } catch (err) {
    log(`re-init failed: ${errorDetails(err).message}`);
    return false;
  }

  try {
    await postMcp(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      5000,
    );
  } catch {}

  log(`re-initialized (${sessionId})`);
  openSse();
  return true;
}

/* ── SSE (best-effort, needed for listRoots) ─────────────────────────── */

function closeSse() {
  if (sseReq) { sseReq.destroy(); sseReq = null; }
}

function scheduleSseReconnect(delayMs, sid) {
  setTimeout(async () => {
    if (exiting) return;
    if (reinitLock) {
      try { await reinitLock; } catch {}
    }
    if (sessionId !== sid) return;
    openSse();
  }, delayMs);
}

function openSse() {
  closeSse();
  if (!sessionId) return;

  const sid = sessionId;
  let reconnectQueued = false;
  const queueReconnect = (delayMs) => {
    if (reconnectQueued) return;
    reconnectQueued = true;
    if (sessionId === sid) scheduleSseReconnect(delayMs, sid);
  };
  const req = http.request(
    {
      hostname: HOST, port: PORT, path: "/mcp", method: "GET",
      headers: {
        Accept: "text/event-stream",
        "mcp-session-id": sid,
        ...(negotiatedProtocolVersion ? { "mcp-protocol-version": negotiatedProtocolVersion } : {}),
      },
    },
    (res) => {
      /* Session gone — null it so next tool POST triggers re-init via pre-flight
         instead of wasting a roundtrip to discover the 404. */
      if (res.statusCode === 400 || res.statusCode === 404) {
        res.resume();
        if (sessionId === sid) sessionId = null;
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 409 || res.statusCode >= 500) queueReconnect(1000);
        return;
      }

      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const ln of lines) {
          const t = ln.trimEnd();
          if (t.startsWith("data: ") && t.length > 6) {
            writeStdoutLine(t.slice(6));
          }
        }
      });
      res.on("end", () => {
        queueReconnect(500);
      });
      res.on("close", () => {
        queueReconnect(500);
      });
    },
  );

  req.on("error", () => {
    if (sseReq !== req) return;
    queueReconnect(2000);
  });

  sseReq = req;
  req.end();
}

/* ── Request forwarding ──────────────────────────────────────────────── */

const rpcError = (id, msg) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: msg } });

function emitResponse(res) {
  const ct = res.headers["content-type"] || "";
  if (ct.includes("text/event-stream")) {
    for (const ln of res.body.split("\n")) {
      const t = ln.trimEnd();
      if (t.startsWith("data: ") && t.length > 6) {
        writeStdoutLine(t.slice(6));
      }
    }
  } else if (res.body.length > 0) {
    writeStdoutLine(res.body);
  }
}

async function forward(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return; }
  if (!parsed || typeof parsed !== "object") return;

  const single = Array.isArray(parsed) ? null : parsed;
  const id = single?.id;
  const method = single?.method;
  if (method === "initialize") {
    cachedInitLine = line;
    negotiatedProtocolVersion =
      typeof single?.params?.protocolVersion === "string" ? single.params.protocolVersion : negotiatedProtocolVersion;
    if (sessionId) {
      sessionId = null;
      closeSse();
    }
  }

  if (!sessionId && method !== "initialize" && method !== "notifications/initialized") {
    if (!cachedInitLine) {
      if (id != null) writeStdoutLine(rpcError(id, "aiki: no session"));
      return;
    }
    if (!(await reinitSession())) {
      if (id != null) writeStdoutLine(rpcError(id, "aiki: session recovery failed"));
      return;
    }
  }

  let res;
  try {
    res = await postRetrying(line);
  } catch (err) {
    if (id != null) writeStdoutLine(rpcError(id, `aiki: ${errorDetails(err).message}`));
    return;
  }

  if (res.status === 404 && method !== "initialize" && cachedInitLine) {
    log("session expired, recovering...");
    if (await reinitSession()) {
      try { res = await postRetrying(line, 1); } catch (err) {
        if (id != null) writeStdoutLine(rpcError(id, `aiki: ${errorDetails(err).message}`));
        return;
      }
      if (res.status === 404) {
        if (id != null) writeStdoutLine(rpcError(id, "aiki: session recovery failed"));
        return;
      }
    } else {
      if (id != null) writeStdoutLine(rpcError(id, "aiki: session recovery failed"));
      return;
    }
  }

  const sid = headerString(res.headers["mcp-session-id"]);
  const protocol = headerString(res.headers["mcp-protocol-version"]);
  if (protocol) negotiatedProtocolVersion = protocol;
  if (sid) {
    const changed = sid !== sessionId;
    sessionId = sid;
    if (changed || !sseReq) openSse();
  }

  if (res.status === 202) return;

  if (res.status >= 400) {
    log(`HTTP ${res.status}: ${res.body}`);
    if (id != null) writeStdoutLine(rpcError(id, `aiki: HTTP ${res.status}`));
    return;
  }

  emitResponse(res);
}

/* ── Main ────────────────────────────────────────────────────────────── */

/** Boots WSL2 VM if not running. Idempotent — exits in ~100ms if already up. */
function bootWsl() {
  return new Promise((resolve) => {
    execFile("wsl", ["-d", "Debian", "--", "true"], { timeout: 30000 }, (err) => {
      if (err) log(`WSL boot failed (${err.code ?? "unknown"}): ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  if (!(await checkHealth())) {
    log("daemon unreachable, booting WSL...");
    await bootWsl();
    if (!(await pollHealth(STARTUP_TIMEOUT_MS))) {
      log("daemon unreachable after WSL boot");
      exitProxy(1);
      return;
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("close", () => exitProxy(0));

  for await (const line of rl) {
    if (exiting) break;
    if (!line.trim()) continue;
    if (sessionId) {
      forward(line).catch((e) => log(`unhandled: ${e.message}`));
    } else {
      await forward(line);
    }
  }
}

main().catch((err) => {
  log(`fatal: ${errorDetails(err).message}`);
  exitProxy(1);
});
