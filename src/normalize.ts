/** Collapses every whitespace run to one space, trims, and lowercases. Nothing else is loosened. */
export function normalizeForQuote(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** An empty quote is never "found": it would match every source text. */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalizeForQuote(quote);
  if (q === "") return false;
  return normalizeForQuote(source).includes(q);
}
