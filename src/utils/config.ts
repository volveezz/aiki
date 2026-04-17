import { homedir } from "os";
import { join } from "path";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
if (!MISTRAL_API_KEY) {
  process.stderr.write("[aiki:fatal] MISTRAL_API_KEY environment variable is required\n");
  process.exit(1);
}

const AIKI_PORT = parseInt(process.env.AIKI_PORT ?? "4242", 10);
if (Number.isNaN(AIKI_PORT)) {
  process.stderr.write("[aiki:fatal] AIKI_PORT must be a valid integer\n");
  process.exit(1);
}

export const config = {
  mistral: {
    apiKey: MISTRAL_API_KEY,
    model: "codestral-embed-2505",
    dimension: 1536,
    endpoint: "https://api.mistral.ai/v1/embeddings",
    maxInputChars: 8000,
    batchSize: 16,
  },
  paths: {
    collectionsBase: join(homedir(), "aiki", "collections"),
    globalBase: join(homedir(), "aiki", "global"),
    logDir: join(homedir(), "aiki", "logs"),
  },
  server: {
    port: AIKI_PORT,
  },
} as const;

export function log(level: "debug" | "info" | "warn" | "error" | "fatal", msg: string) {
  process.stderr.write(`[aiki:${level}] ${msg}\n`);
}
