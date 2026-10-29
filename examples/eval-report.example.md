# Extraction eval report

Generated: 2026-10-29T17:29:49.663Z
Provider: mock (scripted answers from examples/mock-responses.json; no model was called)
Review threshold: 0.7 (flagged when confidence is below it)

## Summary

- Fully correct samples: 3 of 5
- Correct fields: 23 of 30 (77%)
- Flagged for human review: 3 of 5
- Wrong or missing values that were not flagged: 1 of 5

## Per-field accuracy

| Field | Correct | Total | Accuracy |
|---|---|---|---|
| invoiceNumber | 4 | 5 | 80% |
| vendor | 4 | 5 | 80% |
| issueDate | 4 | 5 | 80% |
| currency | 4 | 5 | 80% |
| total | 3 | 5 | 60% |
| dueDate | 4 | 5 | 80% |

## Failures and flags

| Sample | Kind | Field | Detail |
|---|---|---|---|
| inv-2 | wrong_value | total | expected 476, got 400 |
| inv-3 | fabricated_quote | total | quote for "total" not found in the source text: "Total: GBP 89.90" |
| inv-4 | schema_failure |  | schema validation failed after 2 attempts: the response was not valid JSON |
| inv-5 | low_confidence |  | confidence 0.55 is below the review threshold 0.7 |

## How to read this

- Scores compare the output with the expected values supplied in the samples file. They describe these samples only and are not a benchmark of the model or of production accuracy.
- A value that is wrong but backed by a quote that really appears in the text is not caught by the quote check. Such a sample shows up only as a `wrong_value` failure, and under "not flagged" when the model was confident.
- `fabricated_quote`: a quote the model cited is not in the source text. `schema_failure`: the answer did not match the schema after one retry. `low_confidence`: confidence was below the review threshold. `no_evidence` and `sanity_check` come from the evidence minimum and the per-field checks.
