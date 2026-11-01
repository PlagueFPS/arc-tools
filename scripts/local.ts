/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/global-timers -- Process and HTTP harness deadlines must use real host timers, independently of the test clock. */
/* oxlint-disable effecttsgo/new-promise -- Native event and callback APIs require Promise resolvers at this interoperability boundary. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/schema-sync -- The host adapter validates configuration and serializes native callbacks synchronously. */
import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import {
  botOrigin,
  localWebsiteOrigin,
  websiteOAuthOrigin,
} from "@arctools/bot-contracts/origins";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Match,
  Predicate,
  Schema,
  SchemaIssue,
} from "effect";

import { EnvironmentConfig, runtimeConfig } from "../apps/bot/src/config.js";

const LocalAction = Schema.Literals(["dev", "setup", "status", "sync"]);

export type LocalAction = typeof LocalAction.Type;

const LocalSettings = Schema.Struct({
  stage: Schema.String.check(Schema.isPattern(/^local-[a-z0-9-]+$/)),
  endpoint: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        botOrigin("local-", "", value);

        return true;
      } catch {
        return false;
      }
    }),
  ),
  websiteOrigin: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        websiteOAuthOrigin("local-", value);

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

const settingDiagnostics = {
  ARC_STAGE:
    "a stage named prod, staging, local-[a-z0-9-]+, or test-[a-z0-9-]{1,24}-[a-f0-9]{12}; local commands require local-[a-z0-9-]+",
  APPLICATION_STAGE: "a valid stage equal to ARC_STAGE",
  ARC_ENVIRONMENT:
    "production, bot, personal, or test, with the matching stage and sender kind",
  TWITCH_SENDER_KIND:
    "bot for production/bot mode, personal for personal mode, or synthetic for test mode",
  TWITCH_SENDER_LOGIN:
    "a lowercase Twitch login of 1 to 25 letters, digits, or underscores; fixture_sender in test mode",
  TWITCH_CHANNEL_LOGINS:
    "comma-separated lowercase Twitch logins; exactly one channel matching the sender in personal mode; up to 32 fixture_ logins in test mode",
  TWITCH_CLIENT_ID: "a nonempty application ID; fixture-twitch in test mode",
  DISCORD_APPLICATION_ID:
    "a nonempty application ID; fixture-discord in test mode",
  TWITCH_CLIENT_SECRET: "a provider credential",
  TWITCH_SIGNING_SECRET: "a signing credential",
  DISCORD_BOT_TOKEN: "a provider credential",
  DISCORD_PUBLIC_KEY: "exactly 64 hexadecimal characters",
  OPERATOR_SECRET: "an operator credential",
  ARC_BOT_URL: "an HTTPS origin without credentials, path, query, or fragment",
  ARC_WEBSITE_URL:
    "exact http://localhost:3000 or an HTTPS origin without credentials, path, query, or fragment",
  ARC_BUILD_REVISION: "a string containing a non-whitespace character",
  ALCHEMY_PROFILE: "a nonempty string, or omit the setting",
};

type SettingKey = keyof typeof settingDiagnostics;

const identityKeys = {
  stage: "ARC_STAGE",
  applicationStage: "APPLICATION_STAGE",
  kind: "ARC_ENVIRONMENT",
  senderKind: "TWITCH_SENDER_KIND",
  senderLogin: "TWITCH_SENDER_LOGIN",
  channelLogins: "TWITCH_CHANNEL_LOGINS",
  twitchClientId: "TWITCH_CLIENT_ID",
  discordApplicationId: "DISCORD_APPLICATION_ID",
} satisfies Record<keyof EnvironmentConfig, SettingKey>;

const localKeys = {
  stage: "ARC_STAGE",
  endpoint: "ARC_BOT_URL",
  websiteOrigin: "ARC_WEBSITE_URL",
  revision: "ARC_BUILD_REVISION",
  profile: "ALCHEMY_PROFILE",
} satisfies Record<keyof LocalSettings, SettingKey>;

function issuePaths(issue: SchemaIssue.Issue): PropertyKey[] {
  return Match.value(issue).pipe(
    Match.tag("Pointer", (issue) => [
      ...issue.path,
      ...issuePaths(issue.issue),
    ]),
    Match.tag("Composite", "AnyOf", (issue) =>
      issue.issues.flatMap(issuePaths),
    ),
    Match.tag("Filter", "Encoding", (issue) => issuePaths(issue.issue)),
    Match.orElse(() => []),
  );
}

function configurationDiagnostic(
  failure: Cause.Reason<Config.ConfigError> | Schema.SchemaError,
  env: NodeJS.ProcessEnv,
  file: NodeJS.ProcessEnv,
  local: boolean,
): string {
  const error = Schema.isSchemaError(failure)
    ? failure
    : Cause.isFailReason(failure)
      ? failure.error
      : Cause.isDieReason(failure)
        ? failure.defect
        : undefined;

  const report = (
    keys: readonly SettingKey[],
    reason: string,
    expected: string,
  ) =>
    `Invalid local configuration. ${keys.map((key) => `${key} (${Object.hasOwn(file, key) ? ".env.local" : env[key] === undefined ? "not set in .env.local or exported environment" : "exported environment"})`).join(" and ")}: ${reason}. Expected ${expected}. Values are omitted.`;

  const field = (key: SettingKey) =>
    report(
      [key],
      env[key] === undefined ? "missing required setting" : "invalid setting",
      settingDiagnostics[key],
    );

  if (
    Predicate.isTagged(error, "ConfigError") &&
    Predicate.hasProperty(error, "cause") &&
    Schema.isSchemaError(error.cause)
  ) {
    const paths = issuePaths(error.cause.issue);

    for (const key of [
      ...Object.values(identityKeys),
      ...Object.values(localKeys),
      "TWITCH_CLIENT_SECRET",
      "TWITCH_SIGNING_SECRET",
      "DISCORD_BOT_TOKEN",
      "DISCORD_PUBLIC_KEY",
      "OPERATOR_SECRET",
    ] as const) {
      if (paths.includes(key)) return field(key);
    }
  }

  if (Schema.isSchemaError(error)) {
    const hasFilter = (
      issue: SchemaIssue.Issue,
      filters: typeof EnvironmentConfig.ast.checks,
    ): boolean => {
      return Match.value(issue).pipe(
        Match.tag(
          "Filter",
          (issue) =>
            filters?.includes(issue.filter) === true ||
            hasFilter(issue.issue, filters),
        ),
        Match.tag("Pointer", "Encoding", (issue) =>
          hasFilter(issue.issue, filters),
        ),
        Match.tag("Composite", "AnyOf", (issue) =>
          issue.issues.some((issue) => hasFilter(issue, filters)),
        ),
        Match.orElse(() => false),
      );
    };

    if (local) {
      const paths = issuePaths(error.issue);

      for (const [property, key] of Object.entries(localKeys)) {
        if (paths.includes(property)) return field(key);
      }
    } else {
      if (hasFilter(error.issue, EnvironmentConfig.ast.checks))
        return report(
          ["ARC_STAGE", "APPLICATION_STAGE"],
          "stages do not match",
          "equal stage names",
        );

      // Union discriminants can suppress branch issues. Decode only the selected
      // authoritative member to recover field paths without reporting inputs.
      const member = EnvironmentConfig.members.find((member) =>
        Schema.is(member.fields.kind)(env.ARC_ENVIRONMENT),
      );

      if (member) {
        const provider = ConfigProvider.fromEnvRecord(env, {
          preserveEmptyStrings: true,
        });

        const channels = Effect.runSync(
          Config.Array(Schema.String, "TWITCH_CHANNEL_LOGINS").parse(provider),
        );

        const input = Object.fromEntries(
          Object.entries(identityKeys).map(([property, key]) => [
            property,
            property === "channelLogins" ? channels : env[key],
          ]),
        );

        const decoded = Schema.decodeUnknownExit(member)(input);

        if (Exit.isFailure(decoded)) {
          for (const reason of decoded.cause.reasons) {
            if (
              Cause.isFailReason(reason) &&
              Schema.isSchemaError(reason.error)
            ) {
              const paths = issuePaths(reason.error.issue);

              for (const [property, key] of Object.entries(identityKeys)) {
                if (paths.includes(property)) {
                  if (property === "senderKind")
                    return report(
                      ["ARC_ENVIRONMENT", key],
                      "invalid mode/sender relationship",
                      settingDiagnostics[key],
                    );

                  return field(key);
                }
              }

              if (hasFilter(reason.error.issue, member.ast.checks))
                return report(
                  ["TWITCH_SENDER_LOGIN", "TWITCH_CHANNEL_LOGINS"],
                  "personal sender/channel relationship does not match",
                  "exactly one channel equal to the sender login",
                );
            }
          }
        }
      }
    }
  }

  if (error === "Synthetic stages require synthetic provider credentials")
    return report(
      [
        "TWITCH_CLIENT_SECRET",
        "TWITCH_SIGNING_SECRET",
        "DISCORD_BOT_TOKEN",
        "OPERATOR_SECRET",
      ],
      "invalid synthetic credentials",
      "the synthetic provider credentials required by test mode",
    );

  return "Invalid local configuration. An internal configuration check failed; no setting could be identified safely. Values and causes are omitted.";
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

  let file: NodeJS.ProcessEnv = {};
  let local = false;

  let diagnostic =
    "Invalid local configuration. Could not parse .env.local; expected dotenv KEY=value entries. Values are omitted.";

  try {
    file = parseEnv(contents);
    Object.assign(env, file);
    diagnostic =
      "Invalid local configuration. An internal configuration check failed; no setting could be identified safely. Values and causes are omitted.";

    const result = await Effect.runPromiseExit(
      runtimeConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }),
        ),
      ),
    );

    if (Exit.isFailure(result)) {
      const reason = result.cause.reasons[0];

      if (reason)
        diagnostic = configurationDiagnostic(reason, env, file, false);
      throw new Error(diagnostic);
    }

    const config = result.value;
    local = true;

    const input = {
      stage: config.identity.stage,
      endpoint: env.ARC_BOT_URL,
      websiteOrigin: env.ARC_WEBSITE_URL ?? localWebsiteOrigin,
      revision: env.ARC_BUILD_REVISION ?? "unreleased",
    };

    const decoded = Schema.decodeUnknownSync(LocalSettings)(
      env.ALCHEMY_PROFILE === undefined
        ? input
        : { ...input, profile: env.ALCHEMY_PROFILE },
    );

    const settings = {
      ...decoded,
      endpoint: botOrigin(decoded.stage, "", decoded.endpoint),
      websiteOrigin: websiteOAuthOrigin(decoded.stage, decoded.websiteOrigin),
    };

    env.ARC_BOT_URL = settings.endpoint;
    env.ARC_WEBSITE_URL = settings.websiteOrigin;
    env.ARC_BUILD_REVISION = settings.revision;
    env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}`;

    return { settings, env };
  } catch (error) {
    if (local && Schema.isSchemaError(error))
      diagnostic = configurationDiagnostic(error, env, file, true);
    throw new Error(diagnostic);
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

  return Match.value(action).pipe(
    Match.when("dev", () => [
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
    ]),
    Match.when("setup", () => [sync, [...ops, "setup", ...target]]),
    Match.when("status", () => [
      [...ops, "status", ...target, "--discord", ...revision],
    ]),
    Match.when("sync", () => [sync]),
    Match.exhaustive,
  );
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
        !(
          Predicate.isError(error) &&
          Predicate.hasProperty(error, "code") &&
          error.code === "ESRCH"
        )
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
      Predicate.isError(error)
        ? error.message
        : "Local command failed. Details are omitted.",
    );
    process.exitCode = 1;
  }
}
