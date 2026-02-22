import { readFileSync, statSync, readdirSync } from "fs";
import { join, extname, relative, basename } from "path";
import { contentHash } from "../utils/paths.js";
import { log } from "../utils/config.js";

export interface Chunk {
  id: string;
  content: string;
  filePath: string;
  language: string | null;
  chunkType: "code" | "docs";
  summary: string;
  lineStart: number;
  lineEnd: number;
}

export interface DiscoveredFile {
  fullPath: string;
  relPath: string;
  mtimeMs: number;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdc": "markdown",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".prisma": "prisma",
  ".graphql": "graphql",
  ".proto": "protobuf",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
};

const SUPPORTED_EXTS = new Set(Object.keys(EXT_TO_LANG));

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".cache", "coverage", ".turbo", ".output",
  ".vscode", ".cursor", ".idea", ".fleet", ".zed", ".windsurf",
  ".claude",
]);

const SKIP_FILES = new Set([
  "claude.md", "claude.local.md", "agents.md", "opencode.md",
  "conventions.md", ".cursorrules", ".windsurfrules",
]);

const DOC_EXTS = new Set([".md", ".mdc"]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".7z",
  ".pdf", ".exe", ".dll", ".so", ".dylib",
  ".wasm", ".bin",
]);

const MAX_FILE_BYTES = 100 * 1024;

const NOISE_LINE = /^\s*(\/\/|\/\*|\*|#|import\s|from\s|require\(|use\s|export\s\{|export\s\*|[\[\]{}();,]?\s*$)/;

function extractSummary(lines: string[], name: string, lineStart: number, lineEnd: number) {
  const meaningful = lines.find((l) => l.trim().length > 0 && !NOISE_LINE.test(l));
  const loc = lineStart === 1 && lineEnd === lines.length
    ? `${name} (${lines.length}L)`
    : `${name}:${lineStart}-${lineEnd}`;
  return meaningful ? `${loc} — ${meaningful.trim().slice(0, 100)}` : loc;
}

function parseGitignore(projectPath: string): (rel: string) => boolean {
  const rules: { re: RegExp; negate: boolean }[] = [];

  try {
    const raw = readFileSync(join(projectPath, ".gitignore"), "utf-8");
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      let negate = false;
      let pat = line;
      if (pat.startsWith("!")) {
        negate = true;
        pat = pat.slice(1);
      }

      let regex = pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "{{STAR2}}")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\{\{STAR2\}\}/g, ".*");

      if (pat.endsWith("/")) {
        regex = regex.slice(0, -1);
        regex = `(^|/)${regex}(/|$)`;
      } else {
        regex = `(^|/)${regex}($|/)`;
      }

      try {
        rules.push({ re: new RegExp(regex), negate });
      } catch {
        /* skip invalid */
      }
    }
  } catch {
    /* no .gitignore */
  }

  return (rel: string) => {
    let ignored = false;
    for (const { re, negate } of rules) {
      if (re.test(rel)) ignored = !negate;
    }
    return ignored;
  };
}

export function discoverFiles(
  projectPath: string,
  patterns?: string[],
): DiscoveredFile[] {
  const isIgnored = parseGitignore(projectPath);
  const customExts = patterns
    ? new Set(patterns.map((p) => (p.startsWith(".") ? p : `.${p}`)))
    : null;
  const files: DiscoveredFile[] = [];

  function walk(cur: string) {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const full = join(cur, e.name);
      const rel = relative(projectPath, full);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || isIgnored(rel)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name.toLowerCase())) continue;
        const ext = extname(e.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (!(customExts ?? SUPPORTED_EXTS).has(ext)) continue;
        if (isIgnored(rel)) continue;

        try {
          const st = statSync(full);
          if (st.size > MAX_FILE_BYTES) continue;
          files.push({ fullPath: full, relPath: rel, mtimeMs: st.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  }

  walk(projectPath);
  return files;
}

export function chunkFile(file: DiscoveredFile) {
  const content = readFileSync(file.fullPath, "utf-8");
  const lines = content.split("\n");
  const ext = extname(file.fullPath).toLowerCase();
  const language = EXT_TO_LANG[ext] ?? null;
  const chunkType = DOC_EXTS.has(ext) ? "docs" as const : "code" as const;
  const name = basename(file.fullPath);
  const chunks: Chunk[] = [];

  if (lines.length <= 200) {
    chunks.push({
      id: contentHash(`${file.relPath}:full`),
      content,
      filePath: file.relPath,
      language,
      chunkType,
      summary: extractSummary(lines, name, 1, lines.length),
      lineStart: 1,
      lineEnd: lines.length,
    });
  } else {
    const size = 150;
    const overlap = 30;
    let start = 0;
    let idx = 0;

    while (start < lines.length) {
      const end = Math.min(start + size, lines.length);
      const chunkLines = lines.slice(start, end);
      chunks.push({
        id: contentHash(`${file.relPath}:${start}-${end}`),
        content: chunkLines.join("\n"),
        filePath: file.relPath,
        language,
        chunkType,
        summary: extractSummary(chunkLines, name, start + 1, end),
        lineStart: start + 1,
        lineEnd: end,
      });
      start += size - overlap;
      idx++;
    }
  }

  return chunks;
}
