import { z } from "zod";
import type { FieldHooks } from "../src/types";

// Example schema for the eval harness. Copy this file, change the fields, point --schema at it.
export const schema = z.object({
  invoiceNumber: z.string(),
  vendor: z.string(),
  issueDate: z.string().describe("ISO date, YYYY-MM-DD"),
  currency: z.string().describe("Three-letter currency code, for example USD"),
  total: z.number().describe("Total amount due as a plain number, no currency symbol"),
  dueDate: z
    .string()
    .nullable()
    .describe("ISO date, YYYY-MM-DD, or null when the document gives no calendar due date"),
});

export const instructions =
  "The text is an invoice. Extract the invoice number, vendor name, issue date, currency, total amount due and due date. Dates must be ISO YYYY-MM-DD.";

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// Optional per-field sanity checks: return a message when a value looks wrong, otherwise null.
export const hooks: FieldHooks = {
  total: (value) => (typeof value === "number" && value > 0 ? null : "total must be a positive number"),
  issueDate: (value) => (isIsoDate(value) ? null : "issueDate must be a real YYYY-MM-DD date"),
  dueDate: (value, data) => {
    if (value === null || value === undefined) return null;
    if (!isIsoDate(value)) return "dueDate must be a real YYYY-MM-DD date";
    const issued = data.issueDate;
    return isIsoDate(issued) && value < issued ? "dueDate is before issueDate" : null;
  },
};
