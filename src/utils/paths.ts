import { createHash } from "crypto";

export function toWslPath(winPath: string) {
  if (!winPath || winPath.startsWith("/")) return winPath;

  const normalized = winPath.replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):(.*)/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}${match[2]}`;
  }
  return normalized;
}

export function projectHash(path: string) {
  const normalized = toWslPath(path).toLowerCase().replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function projectCollectionPath(basePath: string, projectPath: string) {
  return `${basePath}/${projectHash(projectPath)}`;
}

export function contentHash(content: string) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
