import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiProvider, DEFAULT_GEMINI_MODEL, GeminiError } from "../src/providers/gemini";
import { createMockProvider } from "../src/providers/mock";
import { createOpenAIProvider } from "../src/providers/openai";

const KEY = "test-key-should-never-leak";
const SCHEMA = { type: "object" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gemini provider (fake fetch, no network)", () => {
  it("posts the prompt and JSON schema in the expected shape and returns the text", async () => {
    const { impl, calls } = fakeFetch(200, {
      candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] } }],
    });
    const provider = createGeminiProvider({ apiKey: KEY, fetch: impl });
    const out = await provider.generate("hello", SCHEMA);

    expect(out).toBe('{"a":1}');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: SCHEMA },
    });
    expect(provider.name).toBe(`gemini (${DEFAULT_GEMINI_MODEL})`);
  });

  it("reads the key from GEMINI_API_KEY when none is passed, at call time", async () => {
    vi.stubEnv("GEMINI_API_KEY", KEY);
    const { impl, calls } = fakeFetch(200, { candidates: [{ content: { parts: [{ text: "{}" }] } }] });
    await createGeminiProvider({ fetch: impl }).generate("p", SCHEMA);
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it("fails without a key and does not call the network", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { impl, calls } = fakeFetch(200, {});
    await expect(createGeminiProvider({ fetch: impl }).generate("p", SCHEMA)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps 429, 503 and other statuses, without the key or the response body in the message", async () => {
    const cases: [number, string, string][] = [
      [429, "rate_limit", "rate-limited"],
      [503, "api_error", "overloaded"],
      [500, "api_error", "Gemini API error (500)."],
    ];
    for (const [status, kind, text] of cases) {
      const { impl } = fakeFetch(status, `server said ${KEY}`);
      const err = await createGeminiProvider({ apiKey: KEY, fetch: impl })
        .generate("p", SCHEMA)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GeminiError);
      expect((err as GeminiError).kind).toBe(kind);
      expect((err as GeminiError).message).toContain(text);
      expect((err as GeminiError).message).not.toContain(KEY);
    }
  });

  it("reports an empty candidate list as invalid_output", async () => {
    const { impl } = fakeFetch(200, { candidates: [] });
    await expect(createGeminiProvider({ apiKey: KEY, fetch: impl }).generate("p", SCHEMA)).rejects.toMatchObject({
      kind: "invalid_output",
    });
  });

  it("does not put the key in the message when the request itself fails", async () => {
    const impl = (async () => {
      throw new TypeError(`connect failed for ${KEY}`);
    }) as unknown as typeof fetch;
    const err = await createGeminiProvider({ apiKey: KEY, fetch: impl })
      .generate("p", SCHEMA)
      .catch((e: unknown) => e);
    expect((err as GeminiError).kind).toBe("api_error");
    expect((err as GeminiError).message).not.toContain(KEY);
  });
});

describe("stub providers", () => {
  it("the OpenAI stub refuses to run", async () => {
    await expect(createOpenAIProvider().generate("p", SCHEMA)).rejects.toThrow(
      "not implemented: wire to the client's key",
    );
    expect(createOpenAIProvider().name).toContain("stub");
  });
});

describe("mock provider", () => {
  it("returns steps in order, throws Errors, runs functions, and fails when the script runs out", async () => {
    const mock = createMockProvider(["one", new Error("two"), (p: string) => `echo:${p}`]);
    await expect(mock.generate("a", SCHEMA)).resolves.toBe("one");
    await expect(mock.generate("b", SCHEMA)).rejects.toThrow("two");
    await expect(mock.generate("c", SCHEMA)).resolves.toBe("echo:c");
    await expect(mock.generate("d", SCHEMA)).rejects.toThrow("script exhausted after 3 call(s)");
    expect(mock.calls.map((c) => c.prompt)).toEqual(["a", "b", "c", "d"]);
  });
});
