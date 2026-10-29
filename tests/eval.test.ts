import { describe, expect, it } from "vitest";
import {
  parseSamples,
  renderReport,
  runEval,
  scoreSample,
  summarize,
  valuesEqual,
  type Sample,
} from "../src/eval";
import { createMockProvider } from "../src/providers/mock";
import type { ExtractResult, ReasonIssue } from "../src/types";
import { INSTRUCTIONS, reply, schema } from "./helpers";

type Rec = Record<string, unknown>;

function result(data: Rec | null, over: Partial<ExtractResult<Rec>> = {}): ExtractResult<Rec> {
  const issues: ReasonIssue[] = over.issues ?? [];
  return {
    data,
    confidence: data ? 0.9 : 0,
    evidence: [],
    needsReview: issues.length > 0 || data === null,
    reasons: issues.map((i) => i.message),
    issues,
    attempts: 1,
    ...over,
  };
}

const sample = (id: string): Sample => ({ id, input: "x", expected: { a: "x", b: 1, c: "z" } });

// The mixture below was worked out by hand before it was coded:
//   S1 all three fields right, not flagged
//   S2 b is wrong (2 instead of 1), not flagged            -> silent error
//   S3 all right, but a cited quote is fabricated -> flagged
//   S4 schema failure, data null                           -> all three fields missing, flagged
//   S5 c is null where "z" was expected, not flagged       -> missing, silent error
const mixture = () => [
  scoreSample(sample("S1"), result({ a: "x", b: 1, c: "z" })),
  scoreSample(sample("S2"), result({ a: "x", b: 2, c: "z" })),
  scoreSample(
    sample("S3"),
    result(
      { a: "x", b: 1, c: "z" },
      {
        confidence: 0.4,
        issues: [{ code: "fabricated_quote", field: "b", message: 'quote for "b" not found in the source text: "q"' }],
      },
    ),
  ),
  scoreSample(
    sample("S4"),
    result(null, {
      issues: [{ code: "schema_failure", message: "schema validation failed after 2 attempts: data.a: required" }],
    }),
  ),
  scoreSample(sample("S5"), result({ a: "x", b: 1, c: null })),
];

describe("valuesEqual", () => {
  it("compares strings ignoring surrounding and repeated whitespace, but not case", () => {
    expect(valuesEqual("Acme  Ltd ", "Acme Ltd")).toBe(true);
    expect(valuesEqual("Acme", "acme")).toBe(false);
  });
  it("is strict for numbers and treats null and undefined alike", () => {
    expect(valuesEqual(1250, 1250)).toBe(true);
    expect(valuesEqual(1250, "1250")).toBe(false);
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual(null, "x")).toBe(false);
  });
  it("compares arrays and objects element by element", () => {
    expect(valuesEqual(["a", { n: 1 }], ["a", { n: 1 }])).toBe(true);
    expect(valuesEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("parseSamples", () => {
  it("reads JSONL, skipping blank lines", () => {
    const out = parseSamples('{"id":"a","input":"t","expected":{"x":1}}\n\n{"id":"b","input":"u","expected":{}}\n');
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
  });
  it("rejects malformed rows with the line number", () => {
    expect(() => parseSamples("not json")).toThrow("line 1");
    expect(() => parseSamples('{"id":"a","input":"t"}')).toThrow('"expected" must be an object');
    expect(() => parseSamples('{"id":"a","input":"t","expected":{}}\n{"id":"a","input":"t","expected":{}}')).toThrow(
      'duplicate id "a"',
    );
  });
});

describe("scoreSample and summarize on a hand-checked mixture", () => {
  it("scores each sample", () => {
    const [s1, s2, s3, s4, s5] = mixture();
    expect(s1!.fullyCorrect).toBe(true);
    expect(s1!.silentError).toBe(false);
    expect(s2!.fieldOutcomes.map((o) => o.status)).toEqual(["correct", "wrong_value", "correct"]);
    expect(s2!.silentError).toBe(true);
    expect(s3!.fullyCorrect).toBe(true);
    expect(s3!.needsReview).toBe(true);
    expect(s3!.silentError).toBe(false);
    expect(s4!.fieldOutcomes.map((o) => o.status)).toEqual(["missing", "missing", "missing"]);
    expect(s4!.fullyCorrect).toBe(false);
    expect(s4!.silentError).toBe(false);
    expect(s5!.fieldOutcomes.map((o) => o.status)).toEqual(["correct", "correct", "missing"]);
    expect(s5!.silentError).toBe(true);
  });

  it("totals the counts", () => {
    const s = summarize(mixture());
    expect(s.totalSamples).toBe(5);
    expect(s.fullyCorrect).toBe(2); // S1, S3
    expect(s.flagged).toBe(2); // S3, S4
    expect(s.silentErrors).toBe(2); // S2, S5
    expect(s.fieldsCorrect).toBe(10);
    expect(s.fieldsTotal).toBe(15);
    expect(s.perField).toEqual([
      { field: "a", correct: 4, total: 5, accuracy: 0.8 }, // wrong only in S4
      { field: "b", correct: 3, total: 5, accuracy: 0.6 }, // S2 wrong, S4 missing
      { field: "c", correct: 3, total: 5, accuracy: 0.6 }, // S4, S5 missing
    ]);
  });

  it("lists one failure per problem, with the right kind", () => {
    const failures = mixture().flatMap((s) => s.failures);
    expect(failures.map((f) => `${f.sampleId}:${f.kind}${f.field ? `:${f.field}` : ""}`)).toEqual([
      "S2:wrong_value:b",
      "S3:fabricated_quote:b",
      "S4:schema_failure",
      "S5:missing:c",
    ]);
    expect(failures[0]!.detail).toBe("expected 1, got 2");
    expect(failures[3]!.detail).toBe('expected "z", got null');
  });

  it("reports a thrown provider error as provider_error, flagged for review", () => {
    const s = scoreSample(sample("E"), null, "Gemini is rate-limited right now. Try again shortly.");
    expect(s.failures).toEqual([
      { sampleId: "E", kind: "provider_error", detail: "Gemini is rate-limited right now. Try again shortly." },
    ]);
    expect(s.needsReview).toBe(true);
    expect(s.fullyCorrect).toBe(false);
    expect(s.silentError).toBe(false);
  });

  it("counts low_confidence as a flag on a correct sample", () => {
    const s = scoreSample(
      sample("L"),
      result(
        { a: "x", b: 1, c: "z" },
        {
          confidence: 0.55,
          issues: [{ code: "low_confidence", message: "confidence 0.55 is below the review threshold 0.7" }],
        },
      ),
    );
    expect(s.fullyCorrect).toBe(true);
    expect(s.needsReview).toBe(true);
    expect(s.failures.map((f) => f.kind)).toEqual(["low_confidence"]);
  });
});

describe("runEval", () => {
  const samples: Sample[] = [
    {
      id: "ok",
      input: "Invoice No: INV-7\nTotal due: USD 120.50",
      expected: { invoiceNumber: "INV-7", total: 120.5, dueDate: null },
    },
    { id: "boom", input: "whatever", expected: { invoiceNumber: "X", total: 1, dueDate: null } },
  ];

  it("runs every sample, records provider errors per sample and keeps going", async () => {
    const report = await runEval({
      samples,
      schema,
      instructions: INSTRUCTIONS,
      providerFor: (s) =>
        s.id === "ok"
          ? createMockProvider([reply({ data: { invoiceNumber: "INV-7", total: 120.5, dueDate: null } })])
          : createMockProvider([new Error("network down")]),
    });
    expect(report.summary.totalSamples).toBe(2);
    expect(report.summary.fullyCorrect).toBe(1);
    expect(report.failures.map((f) => `${f.sampleId}:${f.kind}`)).toEqual(["boom:provider_error"]);
    expect(report.failures[0]!.detail).toBe("network down");
  });
});

describe("renderReport", () => {
  const report = () => {
    const scores = mixture();
    return { scores, failures: scores.flatMap((s) => s.failures), summary: summarize(scores) };
  };
  const md = renderReport(report(), {
    provider: "mock (test)",
    reviewThreshold: 0.7,
    generatedAt: "2026-10-29T00:00:00.000Z",
  });

  it("states the headline numbers", () => {
    expect(md).toContain("Provider: mock (test)");
    expect(md).toContain("Generated: 2026-10-29T00:00:00.000Z");
    expect(md).toContain("- Fully correct samples: 2 of 5");
    expect(md).toContain("- Correct fields: 10 of 15 (67%)");
    expect(md).toContain("- Flagged for human review: 2 of 5");
    expect(md).toContain("- Wrong or missing values that were not flagged: 2 of 5");
  });

  it("has a per-field table and a failures table", () => {
    expect(md).toContain("| a | 4 | 5 | 80% |");
    expect(md).toContain("| b | 3 | 5 | 60% |");
    expect(md).toContain("| c | 3 | 5 | 60% |");
    expect(md).toContain("| S2 | wrong_value | b | expected 1, got 2 |");
    expect(md).toContain("| S3 | fabricated_quote | b |");
    expect(md).toContain("| S4 | schema_failure |  | schema validation failed after 2 attempts");
    expect(md).toContain('| S5 | missing | c | expected "z", got null |');
  });

  it("says plainly that the numbers are not a benchmark", () => {
    expect(md).toContain("not a benchmark");
  });

  it("escapes pipes so a detail cannot break the table", () => {
    const scores = [scoreSample(sample("P"), result({ a: "x|y", b: 1, c: "z" }))];
    const out = renderReport(
      { scores, failures: scores.flatMap((s) => s.failures), summary: summarize(scores) },
      { provider: "p", reviewThreshold: 0.7, generatedAt: "t" },
    );
    expect(out).toContain('got "x\\|y"');
  });

  it("prints 'None.' when there are no failures", () => {
    const scores = [scoreSample(sample("G"), result({ a: "x", b: 1, c: "z" }))];
    const out = renderReport(
      { scores, failures: [], summary: summarize(scores) },
      { provider: "p", reviewThreshold: 0.7, generatedAt: "t" },
    );
    expect(out).toContain("None.");
  });
});
