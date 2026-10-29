import { describe, expect, it } from "vitest";
import { normalizeForQuote, quoteAppearsIn } from "../src/normalize";

describe("normalizeForQuote", () => {
  it("collapses whitespace runs, trims and lowercases", () => {
    expect(normalizeForQuote("  Total   Due:\n\tUSD  5 ")).toBe("total due: usd 5");
  });
});

describe("quoteAppearsIn", () => {
  const source = "Invoice No: INV-7\nTotal due:   USD 120.50\nDue date: 2026-02-01";

  it("finds an exact quote", () => {
    expect(quoteAppearsIn("Invoice No: INV-7", source)).toBe(true);
  });

  it("ignores case", () => {
    expect(quoteAppearsIn("INVOICE NO: inv-7", source)).toBe(true);
  });

  it("ignores differences in spaces and line breaks", () => {
    expect(quoteAppearsIn("Total due: USD 120.50", source)).toBe(true);
    expect(quoteAppearsIn("INV-7 Total due: USD 120.50", source)).toBe(true);
  });

  it("does not loosen anything else: a changed word or number is not found", () => {
    expect(quoteAppearsIn("Total due: USD 120.55", source)).toBe(false);
    expect(quoteAppearsIn("Grand total: USD 120.50", source)).toBe(false);
  });

  it("never finds an empty or whitespace-only quote", () => {
    expect(quoteAppearsIn("", source)).toBe(false);
    expect(quoteAppearsIn("  \n ", source)).toBe(false);
  });
});
