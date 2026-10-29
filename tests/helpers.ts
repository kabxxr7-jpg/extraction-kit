import { z } from "zod";

export const schema = z.object({
  invoiceNumber: z.string(),
  total: z.number(),
  dueDate: z.string().nullable(),
});

// Three spaces after "Total due:" on purpose: quotes are compared with whitespace collapsed.
export const SOURCE = "Invoice No: INV-7\nTotal due:   USD 120.50\nDue date: 2026-02-01";

export const INSTRUCTIONS = "The text is an invoice.";

export function reply(over: Record<string, unknown> = {}) {
  return {
    data: { invoiceNumber: "INV-7", total: 120.5, dueDate: "2026-02-01" },
    evidence: [
      { field: "invoiceNumber", quote: "Invoice No: INV-7" },
      { field: "total", quote: "Total due: USD 120.50" },
    ],
    confidence: 0.9,
    ...over,
  };
}
