export type JsonSchema = Record<string, unknown>;

/**
 * The only vendor-specific seam. `generate` receives the full prompt plus the JSON Schema of the
 * response envelope and returns the model's answer: either a parsed object or the raw JSON text.
 * Throwing means the call itself failed (network, quota, auth); it is not retried by `extract`.
 */
export interface Provider {
  readonly name: string;
  generate(prompt: string, jsonSchema: JsonSchema): Promise<unknown>;
}

export type ReasonCode =
  | "schema_failure"
  | "fabricated_quote"
  | "no_evidence"
  | "sanity_check"
  | "low_confidence";

export interface ReasonIssue {
  code: ReasonCode;
  message: string;
  field?: string;
}

export interface Evidence {
  field: string;
  quote: string;
  /** True when the quote is a substring of the source text after whitespace/case normalisation. */
  found: boolean;
}

export interface ExtractResult<T> {
  /** Null when validation failed after the retry. */
  data: T | null;
  /** 0 to 1. Never higher than what the model reported; capped at 0.4 when grounding or a sanity check fails. */
  confidence: number;
  evidence: Evidence[];
  needsReview: boolean;
  /** Human-readable form of `issues`. */
  reasons: string[];
  issues: ReasonIssue[];
  /** Model calls made: 1, or 2 when the first answer failed validation. */
  attempts: number;
}

/** Per-field sanity checks. Return a message when the value looks wrong, or null when it is fine. */
export type FieldHooks = Record<string, (value: unknown, data: Record<string, unknown>) => string | null>;

export interface ExtractOptions {
  /** needsReview when confidence is strictly below this. Default 0.7. */
  reviewThreshold?: number;
  /** Minimum number of evidence quotes the model must return. Default 1. */
  minEvidence?: number;
  hooks?: FieldHooks;
}
