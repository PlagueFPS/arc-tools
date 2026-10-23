import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { ConfigProvider, Effect, Schema } from "effect";

import { publicOrigin, runtimeConfig } from "../apps/bot/src/config.js";

const LocalAction = Schema.Literals(["dev", "setup", "status", "sync"]);

export type LocalAction = typeof LocalAction.Type;

const LocalSettings = Schema.Struct({
  stage: Schema.String.check(Schema.isPattern(/^local-[a-z0-9-]+$/)),
  endpoint: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        publicOrigin("local-", "", value);

        return true;
      } catch {
        return false;
      }
    }),
  ),
  websiteOrigin: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        publicOrigin("local-", "", value);

        return true;
      } catch {
        return false;
      }
    }),
  ),
  revision: Schema.String.check(Schema.isPattern(/\S/)),
  profile: Schema.optionalKey(Schema.NonEmptyString),
});

export type LocalSettings = typeof LocalSettings.Type;

const root = fileURLToPath(new URL("../", import.meta.url));

export function localAction(args: readonly string[]): LocalAction {
  try {
    return Schema.decodeUnknownSync(Schema.Tuple([LocalAction]))(args)[0];
  } catch {
    throw new Error(
      "Use dev:local, setup:local, status:local, or sync:discord:local without extra arguments.",
    );
  }
}

export async function localSettings(
  envFile = join(root, ".env.local"),
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<{ settings: LocalSettings; env: NodeJS.ProcessEnv }> {
  let contents: string;

  try {
    contents = await readFile(envFile, "utf8");
  } catch {
    throw new Error(
      "Cannot read .env.local. Create a protected local environment file at the repository root.",
    );
  }

  const env = { ...inherited };

  try {
    Object.assign(env, parseEnv(contents));

    const config = await Effect.runPromise(
      runtimeConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }),
        ),
      ),
    );

    const input = {
      stage: config.identity.stage,
      endpoint: env.ARC_PUBLIC_URL,
      websiteOrigin: env.ARC_WEBSITE_URL,
      revision: env.ARC_BUILD_REVISION ?? "unreleased",
    };

    const decoded = Schema.decodeUnknownSync(LocalSettings)(
      env.ALCHEMY_PROFILE === undefined
        ? input
        : { ...input, profile: env.ALCHEMY_PROFILE },
    );

    const settings = {
      ...decoded,
      endpoint: publicOrigin(decoded.stage, "", decoded.endpoint),
      websiteOrigin: publicOrigin(decoded.stage, "", decoded.websiteOrigin),
    };

    env.ARC_PUBLIC_URL = settings.endpoint;
    env.ARC_WEBSITE_URL = settings.websiteOrigin;
    env.ARC_BUILD_REVISION = settings.revision;
    env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}`;

    return { settings, env };
  } catch {
    throw new Error(
      "Invalid local configuration. Check ARC_STAGE and APPLICATION_STAGE (matching local-*), ARC_ENVIRONMENT and TWITCH_SENDER_KIND (both personal or both bot), TWITCH_SENDER_LOGIN and TWITCH_CHANNEL_LOGINS (one own channel for personal; configured channels for bot), ARC_PUBLIC_URL and ARC_WEBSITE_URL (HTTPS origins), ARC_BUILD_REVISION, ALCHEMY_PROFILE, TWITCH_CLIENT_ID, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, and application secret keys. Values are omitted.",
    );
  }
}

export function plan(action: LocalAction, settings: LocalSettings): string[][] {
  const target = ["--stage", settings.stage, "--endpoint", settings.endpoint];
  const revision = ["--revision", settings.revision];

  const sync = [
    process.execPath,
    join(root, "scripts/sync-discord-commands.ts"),
    ...target,
    ...revision,
    "--wait",
  ];

  const ops = [process.execPath, join(root, "scripts/ops.ts")];

  switch (action) {
    case "dev":
      return [
        [
          process.execPath,
          join(root, "node_modules/alchemy/bin/cli.js"),
          "dev",
          "--stage",
          settings.stage,
          "--env-file",
          join(root, ".env.local"),
          ...(settings.profile === undefined
            ? []
            : ["--profile", settings.profile]),
        ],
      ];
    case "setup":
      return [sync, [...ops, "setup", ...target]];
    case "status":
      return [[...ops, "status", ...target, "--discord", ...revision]];
    case "sync":
      return [sync];
  }
}

export async function runPlan(
  commands: readonly (readonly string[])[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  let active: ChildProcess | undefined;
  let interrupted = 0;
  let force: ReturnType<typeof setTimeout> | undefined;

  const kill = (signal: NodeJS.Signals) => {
    if (!active?.pid) return;

    try {
      if (process.platform === "win32") active.kill(signal);
      else process.kill(-active.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  };

  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (interrupted) return;
    interrupted = signal === "SIGINT" ? 130 : 143;
    kill(signal);
    force = setTimeout(() => kill("SIGKILL"), 5000);
  };

  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    for (const [command, ...args] of commands) {
      if (interrupted) return interrupted;

      if (!command) throw new Error("Empty local command.");
      active = spawn(command, args, {
        ...options,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });

      const code = await new Promise<number>((resolve, reject) => {
        active?.once("error", reject);
        active?.once("exit", (code, signal) =>
          resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)),
        );
      });

      if (interrupted) kill("SIGKILL");
      active = undefined;

      if (interrupted || code !== 0) return interrupted || code;
    }

    return 0;
  } finally {
    if (force) clearTimeout(force);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  try {
    const action = localAction(process.argv.slice(2));
    const { settings, env } = await localSettings();
    const commands = plan(action, settings);

    if (action === "dev") {
      console.info(
        `Set the portal applications manually if the tunnel host changed:\nDiscord interactions endpoint: ${settings.endpoint}/interactions/discord\nTwitch EventSub callback: ${settings.endpoint}/webhooks/twitch\nTwitch OAuth redirect: ${settings.websiteOrigin}/oauth/twitch/callback`,
      );
    }

    process.exitCode = await runPlan(commands, { cwd: root, env });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Local command failed. Details are omitted.",
    );
    process.exitCode = 1;
  }
}
