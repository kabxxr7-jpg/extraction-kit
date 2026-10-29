import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { DEFAULT_REVIEW_THRESHOLD } from "./extract";
import { parseSamples, renderReport, runEval } from "./eval";
import { createGeminiProvider } from "./providers/gemini";
import { createMockProvider } from "./providers/mock";
import type { FieldHooks, Provider } from "./types";

export interface CliArgs {
  samples: string;
  schema: string;
  provider: "gemini" | "mock";
  mockResponses?: string;
  threshold: number;
  out: string;
  model?: string;
}

export const USAGE = [
  "Usage: npm run eval -- --samples <file.jsonl> --schema <module.ts> --provider gemini|mock [options]",
  "",
  "  --samples <file>          JSONL, one {id, input, expected} per line (required)",
  "  --schema <module>         TS module exporting `schema` (Zod object); optional `instructions` (string) and `hooks` (required)",
  "  --provider gemini|mock    gemini reads GEMINI_API_KEY from the environment (default: gemini)",
  "  --mock-responses <file>   JSON map of sample id to a list of scripted answers (mock provider only)",
  "  --threshold <0-1>         review threshold (default 0.7)",
  "  --out <file>              report path (default ./eval-report.md)",
  "  --model <name>            Gemini model (default gemini-flash-lite-latest)",
].join("\n");

const VALUE_FLAGS = ["samples", "schema", "provider", "mock-responses", "threshold", "out", "model"];

export function parseCliArgs(argv: string[]): CliArgs {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!VALUE_FLAGS.includes(key)) throw new Error(`unknown option --${key}`);
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
      throw new Error(`--${key} needs a value`);
    }
    raw.set(key, value);
  }

  const samples = raw.get("samples");
  const schema = raw.get("schema");
  if (!samples) throw new Error("--samples is required");
  if (!schema) throw new Error("--schema is required");

  const provider = raw.get("provider") ?? "gemini";
  if (provider !== "gemini" && provider !== "mock") throw new Error(`--provider must be gemini or mock, got "${provider}"`);
  const mockResponses = raw.get("mock-responses");
  if (provider === "mock" && !mockResponses) throw new Error("--provider mock needs --mock-responses <file>");

  const thresholdText = raw.get("threshold");
  const threshold = thresholdText === undefined ? DEFAULT_REVIEW_THRESHOLD : Number(thresholdText);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("--threshold must be a number from 0 to 1");

  return { samples, schema, provider, mockResponses, threshold, out: raw.get("out") ?? "eval-report.md", model: raw.get("model") };
}

interface Io {
  log: (message: string) => void;
  error: (message: string) => void;
}

export async function runCli(argv: string[], io: Io = { log: console.log, error: console.error }): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  if (args.provider === "gemini" && !process.env.GEMINI_API_KEY) {
    io.error("GEMINI_API_KEY is not set. Export it in your shell (do not commit it), or run with --provider mock.");
    return 1;
  }

  try {
    const samples = parseSamples(await readFile(resolve(args.samples), "utf8"));
    if (samples.length === 0) throw new Error("the samples file has no samples");

    const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve(args.schema)).href)) as {
      schema?: z.ZodType;
      instructions?: unknown;
      hooks?: FieldHooks;
    };
    if (!mod.schema || typeof mod.schema.safeParse !== "function") {
      throw new Error(`${args.schema} must export \`schema\` (a Zod schema)`);
    }
    const instructions =
      typeof mod.instructions === "string" ? mod.instructions : "Extract the fields described by the schema.";

    let providerFor: (sampleId: string) => Provider;
    let providerLabel: string;
    if (args.provider === "mock") {
      const responses = JSON.parse(await readFile(resolve(args.mockResponses as string), "utf8")) as Record<string, unknown[]>;
      providerFor = (id) => {
        const script = responses[id];
        if (!Array.isArray(script)) throw new Error(`no scripted mock responses for sample "${id}"`);
        return createMockProvider(script);
      };
      providerLabel = `mock (scripted answers from ${args.mockResponses}; no model was called)`;
    } else {
      const gemini = createGeminiProvider({ model: args.model });
      providerFor = () => gemini;
      providerLabel = gemini.name;
    }

    const report = await runEval({
      samples,
      schema: mod.schema,
      instructions,
      providerFor: (sample) => providerFor(sample.id),
      options: { reviewThreshold: args.threshold, hooks: mod.hooks },
    });

    await writeFile(resolve(args.out), renderReport(report, {
      provider: providerLabel,
      reviewThreshold: args.threshold,
      generatedAt: new Date().toISOString(),
    }), "utf8");

    const s = report.summary;
    io.log(`Fully correct samples: ${s.fullyCorrect} of ${s.totalSamples}`);
    io.log(`Correct fields: ${s.fieldsCorrect} of ${s.fieldsTotal}`);
    io.log(`Flagged for human review: ${s.flagged} of ${s.totalSamples}`);
    io.log(`Wrong or missing values not flagged: ${s.silentErrors} of ${s.totalSamples}`);
    io.log(`Report written to ${args.out}`);
    return 0;
  } catch (err) {
    io.error(`eval failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await runCli(process.argv.slice(2));
}
