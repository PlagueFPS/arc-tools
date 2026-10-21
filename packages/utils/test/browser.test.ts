import { expect, test } from "bun:test";

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
  expect(inputs.some((path) => /node_modules|http\.ts$/.test(path))).toBe(
    false,
  );
});
