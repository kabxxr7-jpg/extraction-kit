import { describe, expect, it } from "vitest";
import { extract } from "../src/extract";
import { createMockProvider } from "../src/providers/mock";
import { INSTRUCTIONS, SOURCE, reply, schema } from "./helpers";

const run = (script: unknown[], options?: Parameters<typeof extract>[0]["options"]) => {
  const provider = createMockProvider(script);
  return extract({ text: SOURCE, schema, instructions: INSTRUCTIONS, provider, options }).then((result) => ({
    result,
    provider,
  }));
};

describe("extract: happy path", () => {
  it("returns validated data with grounded evidence and no review flag", async () => {
    const { result, provider } = await run([reply()]);
    expect(result.data).toEqual({ invoiceNumber: "INV-7", total: 120.5, dueDate: "2026-02-01" });
    expect(result.confidence).toBe(0.9);
    expect(result.needsReview).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.attempts).toBe(1);
    expect(result.evidence.every((e) => e.found)).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it("sends the source text, the instructions and an envelope JSON schema to the provider", async () => {
    const { provider } = await run([reply()]);
    const call = provider.calls[0]!;
    expect(call.prompt).toContain(SOURCE);
    expect(call.prompt).toContain(INSTRUCTIONS);
    const properties = (call.jsonSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["confidence", "data", "evidence"]);
  });

  it("accepts the answer as JSON text as well as an object", async () => {
    const { result } = await run([JSON.stringify(reply())]);
    expect(result.data?.invoiceNumber).toBe("INV-7");
    expect(result.attempts).toBe(1);
  });
});

describe("extract: schema failure and retry", () => {
  it("retries once with the problem stated, and uses the second answer", async () => {
    const bad = reply({ data: { invoiceNumber: "INV-7", total: "120.50", dueDate: null } });
    const { result, provider } = await run([bad, reply()]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.prompt).not.toContain("Correction:");
    expect(provider.calls[1]!.prompt).toContain("Correction:");
    expect(provider.calls[1]!.prompt).toContain("data.total");
    expect(result.attempts).toBe(2);
    expect(result.data?.total).toBe(120.5);
    expect(result.needsReview).toBe(false);
  });

  it("returns null data and needsReview after a second failure, and does not call a third time", async () => {
    const bad = reply({ data: { invoiceNumber: "INV-7", total: "n/a", dueDate: null } });
    const { result, provider } = await run([bad, bad, reply()]);
    expect(provider.calls).toHaveLength(2);
    expect(result.data).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.needsReview).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.issues.map((i) => i.code)).toEqual(["schema_failure"]);
  });

  it("treats a missing required field as a schema failure and names the field", async () => {
    const missing = reply({ data: { total: 120.5, dueDate: null } });
    const { result } = await run([missing, missing]);
    expect(result.data).toBeNull();
    expect(result.needsReview).toBe(true);
    expect(result.reasons[0]).toContain("data.invoiceNumber");
  });

  it("treats text that is not JSON as a failure and retries", async () => {
    const { result, provider } = await run(["Sorry, I cannot do that.", reply()]);
    expect(provider.calls[1]!.prompt).toContain("not valid JSON");
    expect(result.data).not.toBeNull();
    expect(result.attempts).toBe(2);
  });

  it("lets a provider error through instead of treating it as a validation failure", async () => {
    const provider = createMockProvider([new Error("quota exceeded")]);
    await expect(
      extract({ text: SOURCE, schema, instructions: INSTRUCTIONS, provider }),
    ).rejects.toThrow("quota exceeded");
    expect(provider.calls).toHaveLength(1);
  });
});

describe("extract: quote check", () => {
  it("caps confidence at 0.4 and flags the sample when a quote is not in the source", async () => {
    const fabricated = reply({
      confidence: 0.95,
      evidence: [
        { field: "invoiceNumber", quote: "Invoice No: INV-7" },
        { field: "total", quote: "Grand total: USD 999.00" },
      ],
    });
    const { result } = await run([fabricated]);
    expect(result.data).not.toBeNull();
    expect(result.confidence).toBe(0.4);
    expect(result.needsReview).toBe(true);
    expect(result.evidence.map((e) => e.found)).toEqual([true, false]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: "fabricated_quote", field: "total" });
    expect(result.reasons[0]).toContain("Grand total: USD 999.00");
  });

  it("never raises confidence: a model score below 0.4 stays as reported", async () => {
    const { result } = await run([
      reply({ confidence: 0.2, evidence: [{ field: "total", quote: "not in the text" }] }),
    ]);
    expect(result.confidence).toBe(0.2);
    expect(result.needsReview).toBe(true);
  });

  it("accepts quotes that differ only in case and whitespace", async () => {
    const loose = reply({
      evidence: [
        { field: "total", quote: "TOTAL DUE: usd 120.50" },
        { field: "invoiceNumber", quote: "Invoice No: INV-7 Total due: USD 120.50" },
      ],
    });
    const { result } = await run([loose]);
    expect(result.evidence.every((e) => e.found)).toBe(true);
    expect(result.needsReview).toBe(false);
    expect(result.confidence).toBe(0.9);
  });

  it("treats an empty quote as not found", async () => {
    const { result } = await run([reply({ evidence: [{ field: "total", quote: "" }] })]);
    expect(result.issues.map((i) => i.code)).toEqual(["fabricated_quote"]);
    expect(result.confidence).toBe(0.4);
  });

  it("does not catch a wrong value that is backed by a real quote", async () => {
    const wrong = reply({
      data: { invoiceNumber: "INV-7", total: 999, dueDate: "2026-02-01" },
      evidence: [{ field: "total", quote: "Total due: USD 120.50" }],
    });
    const { result } = await run([wrong]);
    expect(result.data?.total).toBe(999);
    expect(result.needsReview).toBe(false);
  });

  it("flags a reply with fewer evidence quotes than required", async () => {
    const { result } = await run([reply({ evidence: [] })]);
    expect(result.issues.map((i) => i.code)).toEqual(["no_evidence"]);
    expect(result.confidence).toBe(0.4);
    expect(result.needsReview).toBe(true);

    const relaxed = await run([reply({ evidence: [] })], { minEvidence: 0 });
    expect(relaxed.result.needsReview).toBe(false);
  });
});

describe("extract: review threshold", () => {
  it("flags confidence below the default threshold of 0.7, without capping it", async () => {
    const { result } = await run([reply({ confidence: 0.65 })]);
    expect(result.confidence).toBe(0.65);
    expect(result.needsReview).toBe(true);
    expect(result.issues.map((i) => i.code)).toEqual(["low_confidence"]);
  });

  it("does not flag confidence exactly at the threshold", async () => {
    const { result } = await run([reply({ confidence: 0.7 })]);
    expect(result.needsReview).toBe(false);
  });

  it("uses a custom threshold in both directions", async () => {
    expect((await run([reply({ confidence: 0.65 })], { reviewThreshold: 0.6 })).result.needsReview).toBe(false);
    expect((await run([reply({ confidence: 0.9 })], { reviewThreshold: 0.95 })).result.needsReview).toBe(true);
  });
});

describe("extract: per-field hooks", () => {
  it("flags a value the hook rejects and caps confidence at 0.4", async () => {
    const { result } = await run([reply()], {
      hooks: { total: (v) => (typeof v === "number" && v > 1000 ? null : "total looks too small") },
    });
    expect(result.needsReview).toBe(true);
    expect(result.confidence).toBe(0.4);
    expect(result.issues).toEqual([
      { code: "sanity_check", field: "total", message: "total: total looks too small" },
    ]);
  });

  it("records a hook that throws instead of crashing", async () => {
    const { result } = await run([reply()], {
      hooks: {
        total: () => {
          throw new Error("boom");
        },
      },
    });
    expect(result.needsReview).toBe(true);
    expect(result.reasons[0]).toContain("sanity check threw: boom");
  });

  it("leaves the result alone when every hook passes, and passes the whole record as context", async () => {
    let seen: Record<string, unknown> | undefined;
    const { result } = await run([reply()], {
      hooks: {
        dueDate: (_v, data) => {
          seen = data;
          return null;
        },
      },
    });
    expect(result.needsReview).toBe(false);
    expect(seen?.invoiceNumber).toBe("INV-7");
  });
});
