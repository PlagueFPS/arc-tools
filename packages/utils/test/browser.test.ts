/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
import { expect, test } from "bun:test";

import { Array as EffectArray } from "effect";

test("the pure utils bundle excludes Effect and server HTTP dependencies", async () => {
  const inputs: string[] = [];

  const result = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [
      {
        name: "inspect-pure-utils-dependencies",
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
    new URL("../src/index.ts", import.meta.url).pathname,
  );
  expect(
    EffectArray.some(inputs, (path) => !!/node_modules|http\.ts$/.test(path)),
  ).toBe(false);
});
