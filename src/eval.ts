import type { z } from "zod";
import { extract } from "./extract";
import type { ExtractOptions, ExtractResult, Provider, ReasonCode } from "./types";

export interface Sample {
  id: string;
  input: string;
  expected: Record<string, unknown>;
}

export type FieldStatus = "correct" | "wrong_value" | "missing";
export type FailureKind = ReasonCode | "wrong_value" | "missing" | "provider_error";

export interface FieldOutcome {
  field: string;
  status: FieldStatus;
  expected: unknown;
  actual: unknown;
}

export interface Failure {
  sampleId: string;
  kind: FailureKind;
  field?: string;
  detail: string;
}

export interface SampleScore {
  id: string;
  fieldOutcomes: FieldOutcome[];
  /** Every expected field matched. Says nothing about whether the sample was flagged for review. */
  fullyCorrect: boolean;
  needsReview: boolean;
  /** Not fully correct and not flagged: a wrong answer a reviewer would never see. */
  silentError: boolean;
  confidence: number;
  attempts: number;
  failures: Failure[];
  error?: string;
}

export interface FieldSummary {
  field: string;
  correct: number;
  total: number;
  accuracy: number;
}

export interface EvalSummary {
  totalSamples: number;
  fullyCorrect: number;
  flagged: number;
  silentErrors: number;
  fieldsCorrect: number;
  fieldsTotal: number;
  perField: FieldSummary[];
}

export interface EvalReport {
  scores: SampleScore[];
  failures: Failure[];
  summary: EvalSummary;
}

export function parseSamples(jsonl: string): Sample[] {
  const samples: Sample[] = [];
  const seen = new Set<string>();
  jsonl.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `samples line ${index + 1}`;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const r = row as { id?: unknown; input?: unknown; expected?: unknown };
    if (typeof r.id !== "string" || r.id === "") throw new Error(`${where}: "id" must be a non-empty string`);
    if (typeof r.input !== "string") throw new Error(`${where}: "input" must be a string`);
    if (typeof r.expected !== "object" || r.expected === null || Array.isArray(r.expected)) {
      throw new Error(`${where}: "expected" must be an object`);
    }
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id "${r.id}"`);
    seen.add(r.id);
    samples.push({ id: r.id, input: r.input, expected: r.expected as Record<string, unknown> });
  });
  return samples;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Exact comparison. Strings ignore leading/trailing space and whitespace runs but stay
 * case-sensitive; numbers and booleans must be identical; null and undefined are the same;
 * arrays and objects compare element by element.
 */
export function valuesEqual(expected: unknown, actual: unknown): boolean {
  if ((expected === null || expected === undefined) && (actual === null || actual === undefined)) return true;
  if (typeof expected === "string" && typeof actual === "string") return collapse(expected) === collapse(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.length === actual.length && expected.every((v, i) => valuesEqual(v, actual[i]));
  }
  if (
    typeof expected === "object" && expected !== null &&
    typeof actual === "object" && actual !== null &&
    !Array.isArray(expected) && !Array.isArray(actual)
  ) {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    return [...keys].every((k) => valuesEqual(e[k], a[k]));
  }
  return expected === actual;
}

function show(v: unknown): string {
  return v === undefined ? "nothing" : JSON.stringify(v);
}

export function scoreSample(
  sample: Sample,
  result: ExtractResult<Record<string, unknown>> | null,
  error?: string,
): SampleScore {
  const data = result?.data ?? null;
  const fieldOutcomes: FieldOutcome[] = Object.keys(sample.expected).map((field) => {
    const expected = sample.expected[field];
    if (!data) return { field, status: "missing", expected, actual: undefined };
    const actual = data[field];
    if (valuesEqual(expected, actual)) return { field, status: "correct", expected, actual };
    const gone = actual === undefined || actual === null;
    const wanted = expected !== undefined && expected !== null;
    return { field, status: gone && wanted ? "missing" : "wrong_value", expected, actual };
  });

  const failures: Failure[] = [];
  if (error) {
    failures.push({ sampleId: sample.id, kind: "provider_error", detail: error });
  } else if (result) {
    // A null result is reported once as its schema failure, not as one "missing" row per field.
    if (data) {
      for (const o of fieldOutcomes) {
        if (o.status === "wrong_value") {
          failures.push({ sampleId: sample.id, kind: "wrong_value", field: o.field, detail: `expected ${show(o.expected)}, got ${show(o.actual)}` });
        } else if (o.status === "missing") {
          failures.push({ sampleId: sample.id, kind: "missing", field: o.field, detail: `expected ${show(o.expected)}, got ${show(o.actual)}` });
        }
      }
    }
    for (const issue of result.issues) {
      failures.push({ sampleId: sample.id, kind: issue.code, field: issue.field, detail: issue.message });
    }
  }

  const fullyCorrect = data !== null && fieldOutcomes.every((o) => o.status === "correct");
  const needsReview = result?.needsReview ?? true;
  return {
    id: sample.id,
    fieldOutcomes,
    fullyCorrect,
    needsReview,
    silentError: !fullyCorrect && !needsReview,
    confidence: result?.confidence ?? 0,
    attempts: result?.attempts ?? 0,
    failures,
    error,
  };
}

export function summarize(scores: SampleScore[]): EvalSummary {
  const perField = new Map<string, { correct: number; total: number }>();
  let fieldsCorrect = 0;
  let fieldsTotal = 0;
  for (const s of scores) {
    for (const o of s.fieldOutcomes) {
      const entry = perField.get(o.field) ?? { correct: 0, total: 0 };
      entry.total += 1;
      fieldsTotal += 1;
      if (o.status === "correct") {
        entry.correct += 1;
        fieldsCorrect += 1;
      }
      perField.set(o.field, entry);
    }
  }
  return {
    totalSamples: scores.length,
    fullyCorrect: scores.filter((s) => s.fullyCorrect).length,
    flagged: scores.filter((s) => s.needsReview).length,
    silentErrors: scores.filter((s) => s.silentError).length,
    fieldsCorrect,
    fieldsTotal,
    perField: [...perField.entries()].map(([field, v]) => ({
      field,
      correct: v.correct,
      total: v.total,
      accuracy: v.total === 0 ? 0 : v.correct / v.total,
    })),
  };
}

/** Runs the samples one at a time (free-tier rate limits) and scores each against its expected values. */
export async function runEval<S extends z.ZodType>(args: {
  samples: Sample[];
  schema: S;
  instructions: string;
  providerFor: (sample: Sample) => Provider;
  options?: ExtractOptions;
}): Promise<EvalReport> {
  const scores: SampleScore[] = [];
  for (const sample of args.samples) {
    try {
      const result = await extract({
        text: sample.input,
        schema: args.schema,
        instructions: args.instructions,
        provider: args.providerFor(sample),
        options: args.options,
      });
      scores.push(scoreSample(sample, result as ExtractResult<Record<string, unknown>>));
    } catch (err) {
      scores.push(scoreSample(sample, null, err instanceof Error ? err.message : String(err)));
    }
  }
  return { scores, failures: scores.flatMap((s) => s.failures), summary: summarize(scores) };
}

function cell(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

export function renderReport(
  report: EvalReport,
  meta: { provider: string; reviewThreshold: number; generatedAt: string },
): string {
  const { summary: s } = report;
  const lines: string[] = [
    "# Extraction eval report",
    "",
    `Generated: ${meta.generatedAt}`,
    `Provider: ${meta.provider}`,
    `Review threshold: ${meta.reviewThreshold} (flagged when confidence is below it)`,
    "",
    "## Summary",
    "",
    `- Fully correct samples: ${s.fullyCorrect} of ${s.totalSamples}`,
    `- Correct fields: ${s.fieldsCorrect} of ${s.fieldsTotal} (${pct(s.fieldsCorrect, s.fieldsTotal)})`,
    `- Flagged for human review: ${s.flagged} of ${s.totalSamples}`,
    `- Wrong or missing values that were not flagged: ${s.silentErrors} of ${s.totalSamples}`,
    "",
    "## Per-field accuracy",
    "",
    "| Field | Correct | Total | Accuracy |",
    "|---|---|---|---|",
    ...s.perField.map((f) => `| ${cell(f.field)} | ${f.correct} | ${f.total} | ${pct(f.correct, f.total)} |`),
    "",
    "## Failures and flags",
    "",
  ];
  if (report.failures.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Sample | Kind | Field | Detail |", "|---|---|---|---|");
    for (const f of report.failures) {
      lines.push(`| ${cell(f.sampleId)} | ${f.kind} | ${f.field ? cell(f.field) : ""} | ${cell(f.detail)} |`);
    }
  }
  lines.push(
    "",
    "## How to read this",
    "",
    "- Scores compare the output with the expected values supplied in the samples file. They describe these samples only and are not a benchmark of the model or of production accuracy.",
    "- A value that is wrong but backed by a quote that really appears in the text is not caught by the quote check. Such a sample shows up only as a `wrong_value` failure, and under \"not flagged\" when the model was confident.",
    "- `fabricated_quote`: a quote the model cited is not in the source text. `schema_failure`: the answer did not match the schema after one retry. `low_confidence`: confidence was below the review threshold. `no_evidence` and `sanity_check` come from the evidence minimum and the per-field checks.",
    "",
  );
  return lines.join("\n");
}
