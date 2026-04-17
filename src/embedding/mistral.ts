import { config, log } from "../utils/config.js";

interface EmbedResponse {
  data: { embedding: number[] }[];
}

export async function embed(texts: string[]) {
  const truncated = texts.map((t) => t.slice(0, config.mistral.maxInputChars));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(config.mistral.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.mistral.apiKey}`,
        },
        body: JSON.stringify({
          model: config.mistral.model,
          input: truncated,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 429) {
        lastError = new Error(`Rate limited by Mistral (attempt ${attempt + 1}/3)`);
        const wait = Math.pow(2, attempt) * 1000;
        log("warn", `Rate limited, retrying in ${wait}ms (attempt ${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Mistral API ${response.status}: ${body}`);
      }

      const data = (await response.json()) as EmbedResponse;
      return data.data.map((d) => d.embedding);
    } catch (err) {
      lastError = err as Error;
      if (attempt < 2) {
        const wait = Math.pow(2, attempt) * 1000;
        log("warn", `Embed failed, retrying in ${wait}ms: ${lastError.message}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw lastError ?? new Error("Embedding failed after 3 retries");
}

export async function embedSingle(text: string) {
  const [result] = await embed([text]);
  if (!result) throw new Error("Mistral returned no embedding for input");
  return result;
}
