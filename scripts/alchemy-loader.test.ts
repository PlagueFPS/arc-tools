/* oxlint-disable effecttsgo/node-builtin-import -- This regression exercises the installed Node loader at the subprocess boundary. */
import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeLoaderArgs } from "alchemy/Util/Node";

import { nodeLoaderArgs as compiledLoaderArgs } from "../node_modules/alchemy/lib/Util/Node.js";

const node = Bun.which("node");

if (node === null) throw new Error("Node is required to test Alchemy loaders");

const entry = import.meta.resolve("alchemy/Cli/commands/dev");

test.each([
  ["Bun source", nodeLoaderArgs],
  ["compiled Node", compiledLoaderArgs],
])(
  "%s helper selects an installed loader for Bun's published TypeScript entry",
  async (_, loaderArgs) => {
    expect(new URL(entry).pathname).toEndWith("/src/Cli/commands/dev.ts");
    const args = loaderArgs(entry);
    expect(args[0]).toBe("--import");
    const loader = args[1];
    expect(loader).toBeDefined();

    if (loader === undefined) throw new Error("Missing loader argument");
    expect(await Bun.file(new URL(loader)).exists()).toBeTrue();

    const directory = await mkdtemp(join(tmpdir(), "arc-alchemy-loader-"));

    try {
      const script = join(directory, "entry.mts");
      await writeFile(
        script,
        'class Message { constructor(public text: string) {} }\nprocess.stdout.write(new Message("loaded-typescript").text);\n',
      );

      const child = Bun.spawn([node, ...args, script], {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(stdout).toBe("loaded-typescript");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  import.meta.resolve("alchemy/Util/Node"),
  new URL("../node_modules/alchemy/lib/Util/Node.js", import.meta.url).href,
])("checkout helper %s retains the dev loader when present", async (helper) => {
  const directory = await mkdtemp(join(tmpdir(), "arc-alchemy-checkout-"));

  try {
    const util = join(directory, "src", "Util");
    const bin = join(directory, "bin");
    await mkdir(util, { recursive: true });
    await mkdir(bin);
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    const copy = join(util, "Node.ts");
    await copyFile(fileURLToPath(helper), copy);
    const devLoader = join(bin, "register-dev-mode.js");
    await writeFile(devLoader, "");

    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { nodeLoaderArgs } = await import(${JSON.stringify(copy)}); process.stdout.write(nodeLoaderArgs(${JSON.stringify(entry)})[1]);`,
      ],
      { env: {}, stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(fileURLToPath(stdout)).toBe(devLoader);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
