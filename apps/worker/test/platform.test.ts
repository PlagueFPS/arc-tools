import { createServer } from "node:http";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { requestJson } from "../src/platform.ts";

test.each([
  { headers: { "ratelimit-reset": "1700000060" }, expected: 60000 },
  {
    headers: { "ratelimit-reset": "1700000060", "retry-after": "90" },
    expected: 90000,
  },
  {
    headers: { "ratelimit-reset": "1700000090", "retry-after": "60" },
    expected: 90000,
  },
  {
    headers: { "ratelimit-reset": "invalid", "retry-after": "2" },
    expected: 2000,
  },
  { headers: { "ratelimit-reset": "1699999999" }, expected: 0 },
  { headers: { "ratelimit-reset": "1700003600" }, expected: 600000 },
])("429 headers $headers defer retries by $expected ms", async ({
  headers,
  expected,
}) => {
  const server = createServer((_request, response) => {
    response.writeHead(429, headers);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture has no port");
  const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  try {
    expect(
      await Effect.runPromise(
        requestJson(`http://127.0.0.1:${address.port}`, {}).pipe(
          Effect.catchTag("HttpFailure", (error) =>
            Effect.succeed({
              status: error.status,
              retryable: error.retryable,
              delay: error.retryAfter,
            }),
          ),
        ),
      ),
    ).toEqual({ status: 429, retryable: true, delay: expected });
  } finally {
    clock.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
