import type { JsonSchema, Provider } from "../types";

// Same model opsflow's lib/ai.ts uses.
export const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  /** Defaults to the GEMINI_API_KEY environment variable, read when the first call is made. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_configured" | "rate_limit" | "api_error" | "invalid_output",
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/**
 * Calls Gemini's generateContent REST endpoint with a JSON response schema, as opsflow does through
 * the @google/genai SDK. The key goes in the x-goog-api-key header (never the URL) and is never
 * logged or put in an error message. NOT run against the live API in this build: the request shape
 * is covered by tests against a fake fetch only.
 */
export function createGeminiProvider(options: GeminiOptions = {}): Provider {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    name: `gemini (${model})`,
    async generate(prompt: string, jsonSchema: JsonSchema): Promise<unknown> {
      const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new GeminiError("GEMINI_API_KEY is not set.", "not_configured");
      }
      const doFetch = options.fetch ?? fetch;

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: jsonSchema,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.name : "unknown error";
        throw new GeminiError(`Gemini request failed (${reason}).`, "api_error");
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new GeminiError("Gemini is rate-limited right now. Try again shortly.", "rate_limit");
        }
        if (response.status === 503) {
          throw new GeminiError("Gemini is temporarily overloaded. Try again in a moment.", "api_error");
        }
        throw new GeminiError(`Gemini API error (${response.status}).`, "api_error");
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GeminiError("Gemini returned a body that was not JSON.", "invalid_output");
      }

      const text = readText(body);
      if (!text) {
        throw new GeminiError("Gemini did not return any output.", "invalid_output");
      }
      // Hand back the raw text: `extract` parses it and treats bad JSON like any other validation failure.
      return text;
    },
  };
}

function readText(body: unknown): string {
  const candidates = (body as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)
    ?.candidates;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}
