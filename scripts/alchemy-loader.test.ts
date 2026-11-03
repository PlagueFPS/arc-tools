/* oxlint-disable effecttsgo/node-builtin-import -- This regression exercises the installed Node loader at the subprocess boundary. */
import { expect, test } from "bun:test";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nodeLoaderArgs } from "alchemy/Util/Node";

import { nodeLoaderArgs as compiledLoaderArgs } from "../node_modules/alchemy/lib/Util/Node.js";

const node = Bun.which("node");

if (node === null) throw new Error("Node is required to test Alchemy loaders");

const nodeDirectory = dirname(node);

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

const viteChild = import.meta
  .resolve("@alchemy.run/cloudflare/Workers/ViteChild");

const compiledViteChild = new URL(
  "../node_modules/@alchemy.run/cloudflare/lib/Workers/ViteChild.js",
  import.meta.url,
).href;

const viteOperations = [
  { start: "startViteChild", runner: "ViteChildRunner" },
  { start: "runViteBuildChild", runner: "ViteBuildChildRunner" },
];

async function viteCommand(
  helper: string,
  operation: (typeof viteOperations)[number],
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import * as Effect from "effect/Effect";
       import * as Spawner from "effect/process/ChildProcessSpawner";
       import { PlatformServices } from "alchemy/Util/PlatformServices";
       const { ${operation.start}: start } = await import(${JSON.stringify(helper)});
       const command = await Effect.runPromise(Effect.flip(Effect.scoped(
         start({ rootDir: process.cwd() }, () => Effect.void).pipe(
           Effect.provideService(Spawner.ChildProcessSpawner, Spawner.make(command => Effect.fail(command))),
           Effect.provide(PlatformServices)
         )
       )));
       process.stdout.write([command.command, ...command.args].join(String.fromCharCode(10)));`,
    ],
    { env: { PATH: nodeDirectory }, stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stderr).toBe("");
  expect(exit).toBe(0);
  const [executable, ...args] = stdout.split("\n");

  if (executable === undefined) throw new Error("Missing Vite executable");

  return { executable, args };
}

for (const operation of viteOperations) {
  test.each([viteChild, compiledViteChild])(
    `installed Vite helper %s boots ${operation.runner} on Node`,
    async (helper) => {
      const { executable, args } = await viteCommand(helper, operation);
      const runner = args.at(-1);
      expect(runner).toEndWith(`/lib/Workers/${operation.runner}.js`);

      if (runner === undefined) throw new Error("Missing Vite runner");
      expect(executable).toBe(
        operation.start === "startViteChild" ? node : process.execPath,
      );
      const directory = await mkdtemp(join(tmpdir(), "arc-vite-runner-"));

      try {
        const nodeArgs =
          operation.start === "startViteChild"
            ? args
            : [...nodeLoaderArgs(runner), runner];

        const child = Bun.spawn([node, ...nodeArgs], {
          cwd: directory,
          env: {
            ALCHEMY_RPC_SERVER_ENVIRONMENT: JSON.stringify({
              stack: { name: "loader-test", stage: "test" },
              alchemyContext: {},
            }),
          },
          stdin: new Uint8Array(),
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        expect(exit).toBe(1);
        expect(stdout + stderr).toContain("Unable to deserialize cloned data");
        expect(stdout + stderr).not.toContain(
          "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test.each(["src", "lib"])(
  "checkout %s Vite helpers retain their runner format",
  async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "arc-vite-checkout-"));

    try {
      const modules = join(directory, "node_modules");
      await mkdir(modules);

      const installedModules = fileURLToPath(
        new URL("../node_modules", import.meta.url),
      );

      for (const name of await readdir(installedModules)) {
        if (name === "alchemy" || name === ".bun") continue;
        await symlink(join(installedModules, name), join(modules, name));
      }

      const alchemy = join(directory, "alchemy");
      await cp(join(installedModules, "alchemy"), alchemy, {
        recursive: true,
        dereference: true,
      });
      await symlink(alchemy, join(modules, "alchemy"));
      await symlink(
        dirname(await realpath(join(installedModules, "alchemy"))),
        join(alchemy, "node_modules"),
      );
      const devLoader = join(alchemy, "bin", "register-dev-mode.js");
      await copyFile(join(alchemy, "bin", "register-oxc.js"), devLoader);
      const workers = join(directory, "cloudflare", format, "Workers");
      await mkdir(workers, { recursive: true });
      const extension = format === "src" ? ".ts" : ".js";
      const installedHelper = format === "src" ? viteChild : compiledViteChild;
      await copyFile(
        fileURLToPath(installedHelper),
        join(workers, `ViteChild${extension}`),
      );
      await copyFile(
        fileURLToPath(new URL(`ViteChild.shared${extension}`, installedHelper)),
        join(workers, `ViteChild.shared${extension}`),
      );

      for (const operation of viteOperations) {
        const { executable, args } = await viteCommand(
          join(workers, `ViteChild${extension}`),
          operation,
        );

        const runner = join(workers, `${operation.runner}${extension}`);
        expect(executable).toBe(
          operation.start === "startViteChild" ? node : process.execPath,
        );
        expect(args).toEqual(
          operation.start === "startViteChild"
            ? [
                "--import",
                pathToFileURL(
                  join(
                    alchemy,
                    "bin",
                    format === "src"
                      ? "register-dev-mode.js"
                      : "register-oxc.js",
                  ),
                ).href,
                runner,
              ]
            : ["run", runner],
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
