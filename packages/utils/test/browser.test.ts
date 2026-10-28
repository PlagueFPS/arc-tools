import { expect, test } from "bun:test";

import { Array as Arr, String as Str } from "effect";

test("the utils bundle builds for browsers without server HTTP dependencies", async () => {
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
  expect(Arr.some(inputs, (path) => Str.endsWith("http.ts")(path))).toBe(false);
});
