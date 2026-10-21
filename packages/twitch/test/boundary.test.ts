import { expect, test } from "bun:test";

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
    inputs.some((path) =>
      /apps\/bot|alchemy|packages\/twitch\/src\/(account|provider|state|cloudflare|testing)\.ts/.test(
        path,
      ),
    ),
  ).toBe(false);
});
