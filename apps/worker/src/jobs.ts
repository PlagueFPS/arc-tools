import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { twitchCredentials } from "./config.ts";
import {
  BotWork,
  CallbackKey,
  ERROR_TEXT,
  JOB_LIFETIME,
  type Job,
  JobJson,
  MAX_ATTEMPTS,
  type ReplyTarget,
  TOMBSTONE_LIFETIME,
} from "./domain.ts";
import { editDiscord, makeTwitchSender, renderCommand } from "./platform.ts";

export const jobRuntime = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const credentials = yield* twitchCredentials;
  return Effect.gen(function* () {
    yield* state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS bot_jobs (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
    const sendTwitch = makeTwitchSender(credentials);
    const readJob = Effect.fnUntraced(function* (key: string) {
      const rows = yield* (yield* state.storage.sql.exec<{ data: string }>(
        "SELECT data FROM bot_jobs WHERE key = ?",
        key,
      )).toArray();
      const row = rows[0];
      if (row === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(JobJson)(row.data).pipe(
        Effect.mapError(() => "Invalid stored bot job"),
        Effect.orDie,
      );
    });
    const writeJob = Effect.fnUntraced(function* (key: string, job: Job) {
      yield* state.storage.sql.exec(
        "INSERT INTO bot_jobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
        key,
        JSON.stringify(job),
      );
    });
    const terminal = Effect.fnUntraced(function* (key: string) {
      const expiresAt = Date.now() + TOMBSTONE_LIFETIME;
      yield* state.storage
        .transaction(
          Effect.gen(function* () {
            yield* writeJob(key, { kind: "terminal", expiresAt });
            yield* execute.schedule(key, { at: expiresAt, payload: { key } });
          }),
        )
        .pipe(Effect.orDie);
    });
    const runJob: (
      payload: unknown,
    ) => Effect.Effect<void, never, RuntimeContext> = Effect.fnUntraced(
      function* (payload) {
        const { key } = yield* Schema.decodeUnknownEffect(CallbackKey)(
          payload,
        ).pipe(
          Effect.mapError(() => "Invalid bot callback key"),
          Effect.orDie,
        );
        const job = yield* state.storage
          .transaction(
            Effect.gen(function* () {
              const job = yield* readJob(key);
              if (job === undefined) return undefined;
              if (job.kind === "terminal") {
                if (job.expiresAt <= Date.now())
                  yield* state.storage.sql.exec(
                    "DELETE FROM bot_jobs WHERE key = ?",
                    key,
                  );
                else
                  yield* execute.schedule(key, {
                    at: job.expiresAt,
                    payload: { key },
                  });
                return undefined;
              }
              if (job.deadline <= Date.now() || job.attempts >= MAX_ATTEMPTS) {
                yield* terminal(key);
                return undefined;
              }
              const attempted = { ...job, attempts: job.attempts + 1 };
              yield* writeJob(key, attempted);
              return attempted;
            }),
          )
          .pipe(Effect.orDie);
        if (job === undefined) return;
        yield* Effect.gen(function* () {
          let reply: Extract<Job, { kind: "reply" }>;
          if (job.kind === "execute") {
            const text = yield* renderCommand(job.work).pipe(
              Effect.catchTag("HttpFailure", (error) =>
                job.attempts >= MAX_ATTEMPTS
                  ? Effect.succeed(ERROR_TEXT)
                  : error,
              ),
            );
            const target: ReplyTarget =
              job.work.kind === "twitch"
                ? {
                    kind: "twitch",
                    broadcasterId: job.work.broadcasterId,
                    messageId: job.work.messageId,
                  }
                : {
                    kind: "discord",
                    guildId: job.work.guildId,
                    applicationId: job.work.applicationId,
                    interactionId: job.work.interactionId,
                    token: job.work.token,
                  };
            reply = {
              kind: "reply",
              target,
              text,
              attempts: job.attempts,
              deadline: job.deadline,
            };
            yield* writeJob(key, reply);
          } else reply = job;
          if (Date.now() >= reply.deadline) return yield* terminal(key);
          if (reply.target.kind === "twitch")
            yield* sendTwitch(reply.target, reply.text);
          else yield* editDiscord(reply.target, reply.text);
          yield* terminal(key);
        }).pipe(
          Effect.catchTag(
            "HttpFailure",
            Effect.fnUntraced(function* (error) {
              yield* Effect.logWarning("Bot job delivery failed").pipe(
                Effect.annotateLogs({
                  key,
                  attempt: job.attempts,
                  status: error.status,
                  retryable: error.retryable,
                }),
              );
              const retryAt =
                Date.now() +
                Math.max(1000 * 2 ** (job.attempts - 1), error.retryAfter);
              if (
                !error.retryable ||
                job.attempts >= MAX_ATTEMPTS ||
                retryAt >= job.deadline
              )
                return yield* terminal(key);
              yield* execute
                .schedule(key, { at: retryAt, payload: { key } })
                .pipe(Effect.orDie);
            }),
          ),
        );
      },
    );
    const execute = yield* Alchemy.makeCallback("job", runJob, {
      retry: { delay: "30 seconds" },
    });
    return {
      fetch: Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      accept: Effect.fnUntraced(function* (value: unknown) {
        const work = yield* Schema.decodeUnknownEffect(BotWork)(value).pipe(
          Effect.mapError(() => "Invalid bot work"),
          Effect.orDie,
        );
        const key =
          work.kind === "twitch" ? work.deliveryId : work.interactionId;
        return yield* state.storage.transaction(
          Effect.gen(function* () {
            if ((yield* readJob(key)) !== undefined) return "duplicate";
            yield* writeJob(key, {
              kind: "execute",
              work,
              attempts: 0,
              deadline:
                work.kind === "discord"
                  ? Math.min(Date.now() + JOB_LIFETIME, work.expiresAt)
                  : Date.now() + JOB_LIFETIME,
            });
            yield* execute.schedule(key, { after: 1000, payload: { key } });
            return "accepted";
          }),
        );
      }),
    };
  });
});
export class TwitchChannel extends Cloudflare.DurableObject<TwitchChannel>()(
  "TwitchChannel",
  jobRuntime,
) {}
export class DiscordGuild extends Cloudflare.DurableObject<DiscordGuild>()(
  "DiscordGuild",
  jobRuntime,
) {}
