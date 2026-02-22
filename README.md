<div align="center">

# A I K I

**Semantic memory for AI agents.**

*AI Knowledge Interface — persistent, searchable, context that survives between sessions.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-8B5CF6?style=flat-square)](https://modelcontextprotocol.io/)
[![Zvec](https://img.shields.io/badge/Zvec-HNSW-FF6B35?style=flat-square)](https://github.com/alibaba/zvec)
[![Mistral](https://img.shields.io/badge/Mistral-Codestral_Embed-000?style=flat-square)](https://mistral.ai/)

---

</div>

## The Problem

AI agents lose all context between sessions. Every conversation restarts from scratch — re-exploring codebases, re-discovering patterns, re-learning architectural decisions. Flat-file memory is limited and not semantically searchable.

## The Solution

Aiki is an [MCP server](https://modelcontextprotocol.io/) that gives AI agents persistent semantic memory. It stores knowledge as high-dimensional vectors and retrieves it by meaning, not keywords.

```
Agent asks: "how does auth work in this project?"
Aiki returns: the actual auth middleware code, relevant config, and past decisions about JWT vs sessions
```

## Architecture

```
Claude Code / AI Agent
    │ stdio (JSON-RPC)
    ▼
Aiki MCP Server (Node.js, WSL)
    │
    ├── Mistral Codestral Embed (1536-dim, code-optimized)
    │   └── REST: POST /v1/embeddings
    │
    └── Zvec (in-process HNSW, native C++)
        ├── ~/aiki/collections/<project-hash>/  (per-project)
        └── ~/aiki/global/                      (cross-project)
```

## Tools

### `index` — Scan and embed a codebase

```
index({ project_path: "C:\Users\you\project" })
→ "Indexed 668 chunks from 593 files in 87s"
```

- Recursive file discovery with `.gitignore` support
- Chunks files intelligently (whole file if <200 lines, overlapping chunks otherwise)
- Batch embeds 16 chunks per API call
- **Incremental** — skips unchanged files by mtime comparison

### `search` — Semantic retrieval

```
search({ query: "database connection handling", project_path: "..." })
→ Top results with full source code, ranked by cosine similarity
```

- Embeds query, searches HNSW index, returns ranked results
- Top 3 results include full content; rest are previewed
- Cross-scope: search project code, global knowledge, or both
- Supports Zvec filter expressions for field-level filtering

### `remember` — Store knowledge

```
remember({ content: "We use JWT with 24h expiry, refresh tokens in httpOnly cookies", scope: "project" })
→ "Stored in project collection (id: a788607a6ec27940)"
```

- Embeds and stores with content-hash deduplication
- Project scope: code patterns, decisions, bugs, designs
- Global scope: cross-project preferences, style rules, solutions

## Setup

### Prerequisites

- WSL with Debian (or any Linux distro with Node.js 22+)
- [Mistral API key](https://console.mistral.ai/) (for Codestral Embed)
- [pnpm](https://pnpm.io/)

### Install

```bash
# In WSL
cd /mnt/c/path/to/aiki
pnpm install
pnpm build
```

### Register with Claude Code

```bash
claude mcp add -s user aiki -- \
  wsl -d Debian -- \
  env MISTRAL_API_KEY=your_key_here \
  node /mnt/c/path/to/aiki/dist/server.js
```

### Verify

```bash
# Should respond with MCP initialize handshake
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | wsl -d Debian -- env MISTRAL_API_KEY=... node /mnt/c/path/to/aiki/dist/server.js
```

## Design Decisions

**Why Zvec over Chroma/Pinecone/Qdrant?** — In-process native C++ with zero network overhead. Collections are memory-mapped files on ext4. No server to manage.

**Why Mistral Codestral Embed?** — 1536-dim, optimized for code understanding. Handles TypeScript, Rust, Python, SQL, Vue, and natural language queries against all of them.

**Why WSL?** — Zvec's native bindings require Linux. The stdio MCP transport bridges Windows (Claude Code) to Linux (Aiki) transparently.

**Why content-hash IDs?** — Deterministic deduplication. Re-indexing unchanged code is a no-op at the vector DB level. Re-remembering the same knowledge updates rather than duplicates.

## Storage

Collections live on WSL-native ext4 at `~/aiki/` for I/O performance (not on `/mnt/c/` which is 9P with 10-100x slower random I/O).

| What | Where |
|---|---|
| Per-project vectors + metadata | `~/aiki/collections/<sha256-hash>/` |
| Cross-project knowledge | `~/aiki/global/` |
| Zvec logs | `~/aiki/logs/` |
| Mtime cache (incremental indexing) | `~/aiki/collections/<hash>/mtimes.json` |

## License

MIT
