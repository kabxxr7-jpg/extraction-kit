# extraction-kit

> **Status:** a proof project (56 tests, run locally with a mock model). Not used in production or by any client. See Limits below for what was not verified.

A small, tested starting point for "turn this text into clean, validated data" jobs, plus an eval harness that runs the extraction on a client's real samples and writes a report. It exists to make the first milestone quick: define the schema, run it on 10 of the client's samples, hand over the report.

Built on the same pattern as `lib/ai.ts` in the Opsflow repo (schema-constrained output, Zod validation, a quote check that caps confidence at 0.4), with the differences listed at the bottom.

## What it does

1. `extract({ text, schema, instructions, provider, options })` asks the provider for JSON shaped like `{ data, evidence, confidence }`, where `data` matches your Zod schema and `evidence` is a list of `{ field, quote }`.
2. The answer is parsed and validated with Zod. If it fails (bad JSON, wrong type, missing required field) it is sent back once with the problem stated. A second failure returns `data: null`, `needsReview: true`.
3. Every quote must appear in the source text after collapsing whitespace and ignoring case. A quote that does not appear is recorded as `fabricated_quote` and confidence is capped at 0.4. An empty quote counts as not found.
4. Optional per-field hooks (`options.hooks`) run on the extracted values. A hook returns a message when a value looks wrong (negative total, impossible date); that sets `needsReview` and caps confidence at 0.4.
5. `needsReview` is true when confidence is strictly below `reviewThreshold` (default 0.7), or any issue above was recorded, or `data` is null.

The result: `{ data | null, confidence, evidence: [{ field, quote, found }], needsReview, reasons[], issues[], attempts }`.

## Setup

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Tested on Node v25.2.1 only.

## Use it as a library

```ts
import { z } from "zod";
import { extract, createGeminiProvider } from "./src/index";

const schema = z.object({ invoiceNumber: z.string(), total: z.number() });

const result = await extract({
  text: invoiceText,
  schema,
  instructions: "The text is an invoice. Extract the invoice number and the total due.",
  provider: createGeminiProvider(), // reads GEMINI_API_KEY from the environment at call time
  options: { reviewThreshold: 0.7 },
});

if (result.needsReview) {
  // send to a person, with result.reasons explaining why
}
```

Use string fields for dates (ISO `YYYY-MM-DD`). The schema is converted with `z.toJSONSchema`, and I have not tested schemas with transforms or `z.date()`.

## Run the eval on a client's samples

1. Put the client's 10 samples in a JSONL file, one object per line: `{"id": "s1", "input": "<the text>", "expected": {"field": "value"}}`. `expected` holds the values a person says are right, for the fields you want scored. Use `null` for "this field is not in the document".
2. Copy `examples/invoice-schema.ts`, change the Zod fields. It must export `schema`; it may export `instructions` (a string) and `hooks`.
3. Use the client's own API key, in your shell only (never in a file in this folder):

   ```bash
   export GEMINI_API_KEY=...   # the client's key
   npm run eval -- --samples client-samples.jsonl --schema ./client-schema.ts --provider gemini
   ```

4. Read `eval-report.md`. It has: fully correct samples (N of M), correct fields and per-field accuracy, how many samples were flagged for human review, how many wrong or missing values were *not* flagged, and a table of every failure with its kind: `wrong_value`, `missing`, `fabricated_quote`, `schema_failure`, `low_confidence` (plus `no_evidence`, `sanity_check`, `provider_error`).

Samples are plain text. PDFs, scans and images need converting to text first; this kit has no PDF or OCR step.

Use redacted or sample data first, and put real customer data through the client's own paid account only after they agree in writing. A free-tier key is not the place for it.

Options: `--threshold 0.7`, `--out ./eval-report.md`, `--model gemini-flash-lite-latest`.

### See it work without any API (mock provider)

```bash
npm run eval -- --samples examples/samples.jsonl --schema examples/invoice-schema.ts \
  --provider mock --mock-responses examples/mock-responses.json --out examples/eval-report.example.md
```

The 5 invoice-like samples are fictional, and the answers in `examples/mock-responses.json` are scripted by hand to show each failure kind. The result (3 of 5 fully correct, 23 of 30 fields, 3 flagged, 1 wrong value not flagged) describes the scripts, not any model. `examples/eval-report.example.md` is that output.

## Limits (read before you promise anything)

- **It checks that quotes exist and shapes validate.** That catches invented quotes and malformed or incomplete output. It does **not** catch a wrong value that is backed by a real quote: in the example, `inv-2` takes the subtotal (400) instead of the total (476), cites a real line, and is not flagged. A test covers this case (`does not catch a wrong value that is backed by a real quote`).
- **There is no accuracy benchmark.** The eval measures the samples you give it and nothing else. Do not quote its numbers as the accuracy of the model or of the system on other documents.
- **Only the Gemini adapter is implemented, and it was not run live in this build.** Its request shape (URL, `x-goog-api-key` header, `responseMimeType`, `responseJsonSchema`) is tested against a fake fetch only. The field names mirror what Opsflow passes through the `@google/genai` SDK; they have not been checked against the live REST endpoint.
- **The OpenAI adapter is a stub.** It throws `not implemented: wire to the client's key`. Wiring another provider means writing `generate()` for that API with its structured-output mode, then re-running the tests and the eval with the client's key.
- **Not production code.** Provider errors (rate limits, timeouts) are not retried, samples run one at a time, nothing is stored, there is no logging or redaction, and the prompt tells the model to ignore instructions inside the source text but I have not tested how well that holds.
- A hook or threshold is a gate you choose; a wrong choice lets bad values through.

## Differences from Opsflow's `lib/ai.ts`

| | Opsflow `lib/ai.ts` | this kit |
|---|---|---|
| Quote check | exact `String.includes` | whitespace collapsed, case ignored |
| Confidence cap | `Math.min(confidence, 0.4)` | same value, same rule |
| Invalid JSON or schema failure | throws `AIError("invalid_output")`, no retry (classification) | one retry with the problem stated, then `data: null` and `needsReview` |
| Evidence | one `sourceSnippet` per result | a list of `{ field, quote }` per field |
| Model call | `@google/genai` SDK | plain `fetch` to `generateContent` |
| Review threshold, hooks, eval | not in this file | added here |
| Logging | `console.error` of the raw output on failure | nothing is logged |

## Layout

```
src/extract.ts        extraction, retry, quote check, review rules
src/eval.ts           samples parsing, scoring, summary, markdown report
src/cli.ts            npm run eval
src/providers/        mock.ts, gemini.ts, openai.ts (stub)
examples/             invoice schema, 5 fictional samples, scripted mock answers, example report
tests/                vitest
```
