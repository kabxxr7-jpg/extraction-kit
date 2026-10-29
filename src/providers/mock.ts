import type { JsonSchema, Provider } from "../types";

/** A scripted answer: data returned as-is, an Error that is thrown, or a function that computes one. */
export type MockStep = unknown | Error | ((prompt: string, jsonSchema: JsonSchema) => unknown);

export interface MockProvider extends Provider {
  readonly calls: { prompt: string; jsonSchema: JsonSchema }[];
}

/** Returns the scripted steps in order, one per `generate` call. For tests and offline examples only. */
export function createMockProvider(script: MockStep[], name = "mock"): MockProvider {
  const calls: MockProvider["calls"] = [];
  return {
    name,
    calls,
    async generate(prompt, jsonSchema) {
      calls.push({ prompt, jsonSchema });
      if (calls.length > script.length) {
        throw new Error(`mock provider script exhausted after ${script.length} call(s)`);
      }
      const step = script[calls.length - 1];
      if (step instanceof Error) throw step;
      if (typeof step === "function") return (step as (p: string, s: JsonSchema) => unknown)(prompt, jsonSchema);
      return step;
    },
  };
}
