import type { Provider } from "../types";

/** STUB. Not implemented: wire this to the client's own key and re-run the tests and the eval. */
export function createOpenAIProvider(): Provider {
  return {
    name: "openai (stub)",
    async generate(): Promise<unknown> {
      throw new Error("not implemented: wire to the client's key");
    },
  };
}
