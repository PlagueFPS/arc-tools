/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
import { expect, test } from "bun:test";

import { Array as EffectArray } from "effect";

test("the account contract bundle excludes provider mutation and deployment runtime", async () => {
  const inputs: string[] = [];

  const result = await Bun.build({
    entrypoints: [new URL("../src/server.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [
      {
        name: "inspect-twitch-contract-dependencies",
        setup(build) {
          build.onLoad({ filter: /./ }, (args) => {
            inputs.push(args.path);
          });
        },
      },
    ],
  });

  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  expect(inputs).toContain(
    new URL("../src/contracts.ts", import.meta.url).pathname,
  );
  expect(
    EffectArray.some(
      inputs,
      (path) =>
        !!/apps\/bot|alchemy|packages\/twitch\/src\/(account|provider|state|cloudflare|testing)\.ts/.test(
          path,
        ),
    ),
  ).toBe(false);
});
