import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, runCli } from "../src/cli";

const EX = resolve(__dirname, "../examples");

describe("parseCliArgs", () => {
  it("parses --flag value and --flag=value, with defaults", () => {
    const a = parseCliArgs(["--samples", "s.jsonl", "--schema=schema.ts", "--provider", "mock", "--mock-responses", "m.json"]);
    expect(a).toMatchObject({
      samples: "s.jsonl",
      schema: "schema.ts",
      provider: "mock",
      mockResponses: "m.json",
      threshold: 0.7,
      out: "eval-report.md",
    });
  });

  it("defaults to gemini and accepts a threshold and output path", () => {
    const a = parseCliArgs(["--samples", "s", "--schema", "x", "--threshold", "0.5", "--out", "r.md"]);
    expect(a.provider).toBe("gemini");
    expect(a.threshold).toBe(0.5);
    expect(a.out).toBe("r.md");
  });

  it("rejects missing, unknown and invalid options", () => {
    expect(() => parseCliArgs(["--schema", "x"])).toThrow("--samples is required");
    expect(() => parseCliArgs(["--samples", "s"])).toThrow("--schema is required");
    expect(() => parseCliArgs(["--samples", "s", "--schema", "x", "--bogus", "1"])).toThrow("unknown option --bogus");
    expect(() => parseCliArgs(["--samples", "s", "--schema", "x", "--provider", "openai"])).toThrow(
      "gemini or mock",
    );
    expect(() => parseCliArgs(["--samples", "s", "--schema", "x", "--provider", "mock"])).toThrow(
      "--mock-responses",
    );
    expect(() => parseCliArgs(["--samples", "s", "--schema", "x", "--threshold", "2"])).toThrow("0 to 1");
    expect(() => parseCliArgs(["--samples", "--schema", "x"])).toThrow("--samples needs a value");
  });
});

describe("runCli with the example files and the mock provider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "extraction-kit-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const argv = (out: string) => [
    "--samples", join(EX, "samples.jsonl"),
    "--schema", join(EX, "invoice-schema.ts"),
    "--provider", "mock",
    "--mock-responses", join(EX, "mock-responses.json"),
    "--out", out,
  ];

  it("writes the report and prints the hand-checked numbers for the 5 example samples", async () => {
    // Worked out by hand from examples/mock-responses.json:
    //   inv-1 right. inv-2 total 400 instead of 476 with a real quote (wrong, not flagged).
    //   inv-3 right values, fabricated quote (flagged). inv-4 two invalid answers (schema failure).
    //   inv-5 right values at confidence 0.55 (low confidence, flagged).
    // Fully correct 3 of 5 (inv-1, 3, 5). Fields 23 of 30. Flagged 3 (inv-3, 4, 5). Silent errors 1 (inv-2).
    const out = join(dir, "report.md");
    const logs: string[] = [];
    const code = await runCli(argv(out), { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) });

    expect(code).toBe(0);
    expect(logs).toContain("Fully correct samples: 3 of 5");
    expect(logs).toContain("Correct fields: 23 of 30");
    expect(logs).toContain("Flagged for human review: 3 of 5");
    expect(logs).toContain("Wrong or missing values not flagged: 1 of 5");

    const md = await readFile(out, "utf8");
    expect(md).toContain("# Extraction eval report");
    expect(md).toContain("Provider: mock (scripted answers from");
    expect(md).toContain("no model was called");
    expect(md).toContain("- Fully correct samples: 3 of 5");
    expect(md).toContain("| total | 3 | 5 | 60% |");
    expect(md).toContain("| inv-2 | wrong_value | total | expected 476, got 400 |");
    expect(md).toContain("| inv-3 | fabricated_quote | total |");
    expect(md).toContain("| inv-4 | schema_failure |");
    expect(md).toContain("| inv-5 | low_confidence |");
  });

  it("fails with a clear message and exit code 1 when no Gemini key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const logs: string[] = [];
    const code = await runCli(
      ["--samples", join(EX, "samples.jsonl"), "--schema", join(EX, "invoice-schema.ts"), "--provider", "gemini", "--out", join(dir, "x.md")],
      { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    );
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("GEMINI_API_KEY is not set");
  });

  it("returns 2 and prints usage for bad arguments", async () => {
    const logs: string[] = [];
    const code = await runCli(["--samples"], { log: () => {}, error: (m) => logs.push(m) });
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("Usage:");
  });
});
