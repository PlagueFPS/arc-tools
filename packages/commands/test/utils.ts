import { createMockHttpClientLayer, type MockData } from "@arctools/testing";
import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { CommandError } from "../src/index.js";

/**
 * Creates a runner that executes a string-in, string-out handler with a mock HTTP layer.
 * @example
 * const run = runWithMock(buyHandler);
 * yield* run({})("input");
 */
export function runWithMock(
  handler: (
    input: string,
  ) => Effect.Effect<string, CommandError, HttpClient.HttpClient>,
) {
  return (mock: MockData) => (input: string) =>
    handler(input).pipe(Effect.provide(createMockHttpClientLayer(mock)));
}
