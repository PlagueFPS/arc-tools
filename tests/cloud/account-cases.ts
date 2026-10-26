import { expect } from "bun:test";
import { appendFile } from "node:fs/promises";

import {
  commandManifest,
  ReleaseHealth,
  syncCommands,
} from "@arctools/discord/server";
import {
  subscriptionBinding,
  AccountStatus,
  DispatchOutcome,
  SetupResult,
} from "@arctools/twitch/server";
import { providerTransport } from "@arctools/utils/http";
import { Match, Clock, Effect, Fiber, Redacted, Schema } from "effect";

import { setupWhenAvailable } from "./account-setup.js";
import {
  LiveAccountAttribution,
  NativeAlarmSnapshot,
} from "./alarm-attribution.js";
import {
  completedRunKey,
  selectCompletedRun,
  verifyCompletedRecovery,
  verifyCompletedValidation,
} from "./completed-recovery.js";
import { retainJourney } from "./fixture-evidence.js";
import {
  auditedObservation,
  observe,
  get,
  json,
  post,
  reconstructedSnapshot,
} from "./fixture-http.js";
import { withProviderControl } from "./fixture-journey.js";
import { accountJourney } from "./fixture-routing.js";
import type * as Foundation from "./foundation.test.js";
import { ProviderSnapshot } from "./twitch-provider-fixture.js";

const providerSnapshot = (
  url: string,
  until: (value: typeof ProviderSnapshot.Type) => boolean = () => true,
) =>
  observe(auditedObservation("provider", `${url}/snapshot`, ProviderSnapshot), {
    until,
    budgetMs: 5000,
  });

const Snapshot = Schema.Struct({
  instance: Schema.String,
  journey: Schema.String,
  nativeId: Schema.String,
  logs: Schema.Array(Schema.String),
  time: Schema.Number,
  status: Schema.Unknown,
  onboardingRetained: Schema.Boolean,
  alarm: Schema.NullOr(Schema.Number),
});

const rpc = Effect.fnUntraced(function* <A, I>(
  url: string,
  schema: Schema.Codec<A, I>,
  body: Schema.Json = {},
) {
  const result = yield* post(url, body);

  const decoded = yield* json(
    result,
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("success"), value: schema }),
      Schema.Struct({ kind: Schema.Literal("failure"), code: Schema.String }),
    ]),
  );

  if (decoded.kind === "failure")
    return yield* Effect.fail(
      new Error(`Account RPC ${new URL(url).pathname}: ${decoded.code}`),
    );

  return decoded.value;
});

const rawReply = Effect.fnUntraced(function* (url: string, body: Schema.Json) {
  const response = yield* post(url, body);

  return yield* json(
    response,
    Schema.Struct({ kind: Schema.Literal("failure"), code: Schema.String }),
  );
});

const authorize = Effect.fnUntraced(function* (url: string) {
  const setup = yield* rpc(`${url}/setup`, SetupResult);

  for (const auth of setup.authorizations) {
    const params = new URL(auth.url).searchParams;

    const userId = Match.value(auth.login).pipe(
      Match.when("fixture_sender", () => "100"),
      Match.when("fixture_channel", () => "200"),
      Match.orElse(() => "300"),
    );

    yield* rpc(`${url}/complete`, AccountStatus, {
      state: params.get("state"),
      operator: "fixture-operator-digest",
      code: JSON.stringify({
        userId,
        login: auth.login,
        scopes: params.get("scope")?.split(" "),
        clientId: "fixture-twitch",
      }),
    });
  }

  return yield* rpc(`${url}/setup`, SetupResult);
});

const sendInput = (
  attemptId: string,
  deadline: number,
  broadcasterId = "200",
) => ({
  attemptId,
  deadline,
  broadcasterId,
  replyParentId: "fixture-parent",
  text: "Sensors sell for 10 coins.",
});

export function registerAccountTests({
  stack,
  test,
}: {
  stack: typeof Foundation.stack;
  test: typeof Foundation.test;
}) {
  const urls = Effect.fnUntraced(function* (name: string) {
    const deployed = yield* stack;

    if (!deployed.accountUrl || !deployed.providerUrl)
      return yield* Effect.die("Missing account fixture bindings");

    yield* retainJourney(name, { phase: "start" });

    return {
      ...accountJourney(
        { account: deployed.accountUrl, provider: deployed.providerUrl },
        name,
      ),
      bot: deployed.url,
    };
  });

  test(
    "native account/provider pairs isolate held sends and retain routing through reconstruction",
    Effect.gen(function* () {
      const a = yield* urls("routing-alpha");
      const b = yield* urls("routing-beta");

      for (const pair of [a, b]) {
        yield* post(`${pair.account}/configure`, {
          revision: "routing",
          channels: ["fixture_channel"],
        });
        expect((yield* authorize(pair.account)).status.setup).toBe("ready");
      }

      const original = yield* get(`${a.account}/snapshot`, Snapshot);
      const other = yield* get(`${b.account}/snapshot`, Snapshot);
      expect(original.journey).toBe("routing-alpha");
      expect(other.journey).toBe("routing-beta");
      expect(original.nativeId).not.toBe(other.nativeId);
      yield* withProviderControl(
        a.provider,
        { holdSend: true },
        Effect.fnUntraced(function* (control) {
          const input = sendInput("identical-attempt", original.time + 10000);

          const held = yield* rpc(
            `${a.account}/dispatch`,
            DispatchOutcome,
            input,
          ).pipe(Effect.exit, Effect.forkScoped);

          const aMessages = yield* providerSnapshot(
            a.provider,
            (value) => value.messages.length === 1,
          );

          expect(aMessages.messages).toHaveLength(1);
          expect(
            yield* rpc(
              `${b.account}/dispatch`,
              DispatchOutcome,
              sendInput("identical-attempt", other.time + 10000),
            ),
          ).toMatchObject({ kind: "sent" });
          yield* post(`${a.account}/reconstruct`);
          yield* control.release;
          expect((yield* Fiber.join(held))._tag).toBe("Failure");

          const rebuilt = yield* reconstructedSnapshot(
            get(`${a.account}/snapshot`, Snapshot),
            original.instance,
          );

          yield* retainJourney("routing-alpha", {
            original: {
              journey: original.journey,
              nativeId: original.nativeId,
              instance: original.instance,
            },
            rebuilt: {
              journey: rebuilt.journey,
              nativeId: rebuilt.nativeId,
              instance: rebuilt.instance,
            },
          });
          expect(rebuilt.journey).toBe(original.journey);
          expect(rebuilt.nativeId).toBe(original.nativeId);
          expect(
            yield* rpc(`${a.account}/dispatch`, DispatchOutcome, input),
          ).toMatchObject({ kind: "ambiguous" });
        }),
      );
      expect((yield* providerSnapshot(a.provider)).messages).toHaveLength(1);
      expect((yield* providerSnapshot(b.provider)).messages).toHaveLength(1);
    }),
    { timeout: 90000 },
  );

  test(
    "account native storage binds OAuth identity/client, expiry, replay and config revision",
    Effect.gen(function* () {
      const u = yield* urls("oauth");
      yield* providerSnapshot(u.provider);
      yield* get(`${u.account}/snapshot`, Snapshot);
      const now = Date.now() + 86_400_000;
      yield* post(`${u.account}/time`, now);

      for (const [field, override, expected] of [
        ["userId", "999", "identity"],
        ["clientId", "wrong", "client"],
        ["scopes", [], "scopes"],
      ] as const) {
        const setup = yield* rpc(`${u.account}/setup`, SetupResult);

        const state = new URL(
          setup.authorizations[0]?.url ?? "",
        ).searchParams.get("state");

        const code = JSON.stringify({
          userId: "100",
          login: "fixture_sender",
          clientId: "fixture-twitch",
          scopes: ["user:read:chat", "user:write:chat", "user:bot"],
          [field]: override,
        });

        const request = { state, code, operator: "fixture-operator-digest" };
        expect((yield* rawReply(`${u.account}/complete`, request)).code).toBe(
          expected,
        );
        expect((yield* rawReply(`${u.account}/complete`, request)).code).toBe(
          "state",
        );
      }

      const expiry = yield* rpc(`${u.account}/setup`, SetupResult);

      const oldState = new URL(
        expiry.authorizations[0]?.url ?? "",
      ).searchParams.get("state");

      yield* post(`${u.account}/time`, now + 600_000);
      expect(
        (yield* rawReply(`${u.account}/complete`, {
          state: oldState,
          code: "unused",
          operator: "fixture-operator-digest",
        })).code,
      ).toBe("state");
      const old = yield* rpc(`${u.account}/setup`, SetupResult);
      yield* post(`${u.account}/configure`, {
        revision: "configured-two",
        channels: ["fixture_channel", "fixture_other"],
      });
      expect(
        (yield* rawReply(`${u.account}/complete`, {
          state: new URL(old.authorizations[0]?.url ?? "").searchParams.get(
            "state",
          ),
          code: "unused",
          operator: "fixture-operator-digest",
        })).code,
      ).toBe("state");
      const ready = yield* authorize(u.account);
      expect(ready.status.setup).toBe("ready");
      expect(
        ready.status.channels.map((channel) => String(channel.id)),
      ).toEqual(["200", "300"]);
      expect(
        (yield* get(`${u.account}/snapshot`, Snapshot)).onboardingRetained,
      ).toBeFalse();

      const statusResponse = yield* Effect.promise(() =>
        fetch(`${u.bot}/ops/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: "wrong" }),
        }),
      );

      expect(statusResponse.status).toBe(401);

      const authenticated = yield* Effect.promise(() =>
        fetch(`${u.bot}/ops/status`, {
          method: "POST",
          headers: {
            Authorization: "Bearer fixture-operator",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stage: ready.status.stage }),
        }),
      );

      expect(authenticated.status).toBe(200);

      const operational = yield* Effect.promise(() =>
        authenticated.json(),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccountStatus)));

      expect(operational.setup).toBe("unresolved");
      expect(operational.credential).toBe("absent");

      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "scripts/ops.ts",
          "status",
          "--stage",
          ready.status.stage,
          "--endpoint",
          u.bot,
        ],
        {
          env: { ...process.env, OPERATOR_SECRET: "fixture-operator" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const output = yield* Effect.promise(() =>
        new Response(child.stdout).text(),
      );

      const errors = yield* Effect.promise(() =>
        new Response(child.stderr).text(),
      );

      expect(yield* Effect.promise(() => child.exited)).toBe(0);
      expect(
        Schema.decodeUnknownSync(AccountStatus)(JSON.parse(output)).stage,
      ).toBe(ready.status.stage);
      expect(output + errors).not.toContain("fixture-operator");
    }),
    { timeout: 180_000 },
  );

  test(
    "paginated setup preserves confirmed IDs and replaces an interrupted unconfirmed create after reconstruction",
    Effect.gen(function* () {
      const u = yield* urls("pagination");
      expect((yield* authorize(u.account)).status.setup).toBe("ready");
      const before = yield* providerSnapshot(u.provider);
      yield* rpc(`${u.account}/setup`, SetupResult);
      const adopted = yield* providerSnapshot(u.provider);
      expect(adopted.calls["POST /helix/eventsub/subscriptions"]).toBe(
        before.calls["POST /helix/eventsub/subscriptions"],
      );
      expect(
        (adopted.calls["GET /helix/eventsub/subscriptions"] ?? 0) -
          (before.calls["GET /helix/eventsub/subscriptions"] ?? 0),
      ).toBe(2);
      yield* post(`${u.account}/configure`, {
        revision: "one-channel",
        channels: ["fixture_channel"],
      });
      yield* authorize(u.account);
      const configured = yield* get(`${u.account}/snapshot`, Snapshot);

      yield* post(`${u.account}/time`, configured.time + 1);
      yield* post(`${u.account}/credential`);
      expect(
        (yield* providerSnapshot(u.provider)).remote.map(
          (sub) => sub.condition.broadcaster_user_id,
        ),
      ).toEqual(["200"]);
      yield* post(`${u.provider}/control`, { remote: [] });
      yield* withProviderControl(
        u.provider,
        { holdCreate: true },
        Effect.fnUntraced(function* (control) {
          const starting = yield* get(`${u.account}/snapshot`, Snapshot);

          const interrupted = yield* rpc(
            `${u.account}/setup`,
            SetupResult,
          ).pipe(Effect.exit, Effect.forkScoped);

          const created = yield* providerSnapshot(
            u.provider,
            (value) => value.remote.length === 1,
          );

          expect(created.remote.length).toBe(1);
          yield* post(`${u.account}/reconstruct`);
          yield* control.release;
          expect((yield* Fiber.join(interrupted))._tag).toBe("Failure");

          const reconstructed = yield* reconstructedSnapshot(
            get(`${u.account}/snapshot`, Snapshot),
            starting.instance,
          );

          expect(reconstructed.instance).not.toBe(starting.instance);
          yield* post(`${u.account}/time`, starting.time + 121_000);
          expect(
            (yield* setupWhenAvailable(`${u.account}/setup`)).status.setup,
          ).toBe("ready");
          const after = yield* providerSnapshot(u.provider);
          expect(after.remote.length).toBe(1);
          expect(after.calls["POST /helix/eventsub/subscriptions"]).toBe(
            (created.calls["POST /helix/eventsub/subscriptions"] ?? 0) + 1,
          );
          expect(after.calls["DELETE /helix/eventsub/subscriptions"]).toBe(
            (created.calls["DELETE /helix/eventsub/subscriptions"] ?? 0) + 1,
          );
          expect(after.remote[0]?.id).not.toBe(created.remote[0]?.id);
          expect(after.bindings[after.remote[0]?.id ?? ""]).toBe(
            yield* subscriptionBinding({
              callback: "https://fixture.invalid/webhooks/twitch",
              clientId: "fixture-twitch",
              signingSecret: Redacted.make("CANARY-SIGNING-SECRET"),
            }),
          );
        }),
      );
    }),
    { timeout: 90_000 },
  );

  test(
    "real account dispatch separates rejection, ambiguity, deadline equality and interrupted POST",
    Effect.gen(function* () {
      const u = yield* urls("dispatch");
      yield* post(`${u.account}/configure`, {
        revision: "one-channel",
        channels: ["fixture_channel"],
      });
      expect((yield* authorize(u.account)).status.setup).toBe("ready");
      let snapshot = yield* get(`${u.account}/snapshot`, Snapshot);
      let time = snapshot.time + 10_000;
      yield* post(`${u.account}/time`, time);
      yield* withProviderControl(
        u.provider,
        {
          sendBody: {
            data: [
              {
                is_sent: false,
                message_id: "",
                drop_reason: {
                  code: "automod",
                  message: "CANARY-PRIVATE-DROP",
                },
              },
            ],
          },
        },
        Effect.fnUntraced(function* () {
          const rejected = sendInput("rejected", time + 10_000);
          expect(
            yield* rpc(`${u.account}/dispatch`, DispatchOutcome, rejected),
          ).toEqual({ kind: "rejected" });
          const captured = yield* get(`${u.account}/snapshot`, Snapshot);
          expect(captured.logs.length).toBeGreaterThan(0);
          expect(JSON.stringify(captured.logs)).not.toContain("CANARY");
          const before = yield* providerSnapshot(u.provider);
          expect(
            yield* rpc(`${u.account}/dispatch`, DispatchOutcome, rejected),
          ).toEqual({ kind: "rejected" });
          expect(
            (yield* providerSnapshot(u.provider)).calls[
              "POST /helix/chat/messages"
            ],
          ).toBe(before.calls["POST /helix/chat/messages"]);
          expect(
            yield* rpc(
              `${u.account}/dispatch`,
              DispatchOutcome,
              sendInput("equal", time),
            ),
          ).toEqual({ kind: "expired" });
        }),
      );
      time += 1000;
      yield* post(`${u.account}/time`, time);
      const ambiguous = sendInput("unknown-post", time + 10_000);
      yield* withProviderControl(
        u.provider,
        { sendStatus: 503, sendBody: {} },
        Effect.fnUntraced(function* () {
          expect(
            yield* rpc(`${u.account}/dispatch`, DispatchOutcome, ambiguous),
          ).toEqual({ kind: "ambiguous" });
        }),
      );
      yield* withProviderControl(
        u.provider,
        {
          sendStatus: 200,
          sendBody: { data: [{ is_sent: true, message_id: "delivered" }] },
          holdSend: true,
        },
        Effect.fnUntraced(function* (control) {
          time += 1000;
          yield* post(`${u.account}/time`, time);
          const input = sendInput("interrupted-send", time + 10_000);
          const previous = yield* providerSnapshot(u.provider);

          const interrupted = yield* rpc(
            `${u.account}/dispatch`,
            DispatchOutcome,
            input,
          ).pipe(Effect.exit, Effect.forkScoped);

          const observed = yield* providerSnapshot(
            u.provider,
            (value) =>
              (value.calls["POST /helix/chat/messages"] ?? 0) >
              (previous.calls["POST /helix/chat/messages"] ?? 0),
          );

          expect(observed.calls["POST /helix/chat/messages"]).toBe(
            (previous.calls["POST /helix/chat/messages"] ?? 0) + 1,
          );
          snapshot = yield* get(`${u.account}/snapshot`, Snapshot);
          yield* post(`${u.account}/reconstruct`);
          yield* control.release;
          expect((yield* Fiber.join(interrupted))._tag).toBe("Failure");

          const reconstructed = yield* reconstructedSnapshot(
            get(`${u.account}/snapshot`, Snapshot),
            snapshot.instance,
          );

          expect(reconstructed.instance).not.toBe(snapshot.instance);
          expect(
            yield* rpc(`${u.account}/dispatch`, DispatchOutcome, input),
          ).toEqual({ kind: "ambiguous" });
          expect(
            yield* rpc(`${u.account}/dispatch`, DispatchOutcome, ambiguous),
          ).toEqual({ kind: "ambiguous" });
          expect(
            (yield* providerSnapshot(u.provider)).calls[
              "POST /helix/chat/messages"
            ],
          ).toBe(observed.calls["POST /helix/chat/messages"]);
          expect(JSON.stringify(reconstructed.status)).not.toContain("CANARY");
          expect(JSON.stringify(observed.logs)).not.toContain("CANARY");
        }),
      );
    }),
    { timeout: 90_000 },
  );

  test(
    "token refresh contention and clock overrun preserve the absolute send cutoff",
    Effect.gen(function* () {
      const u = yield* urls("refresh-contention");
      yield* post(`${u.account}/configure`, {
        revision: "one-channel",
        channels: ["fixture_channel"],
      });
      expect((yield* authorize(u.account)).status.setup).toBe("ready");
      const snapshot = yield* get(`${u.account}/snapshot`, Snapshot);
      let time = snapshot.time + 3_600_000;
      yield* post(`${u.account}/time`, time);
      const before = yield* providerSnapshot(u.provider);
      yield* withProviderControl(
        u.provider,
        { holdMint: true },
        Effect.fnUntraced(function* (control) {
          const one = yield* rpc(
            `${u.account}/dispatch`,
            DispatchOutcome,
            sendInput("late-refresh", time + 10_000),
          ).pipe(Effect.forkScoped);

          const two = yield* rpc(
            `${u.account}/dispatch`,
            DispatchOutcome,
            sendInput("late-refresh-two", time + 9_000),
          ).pipe(Effect.forkScoped);

          const pending = yield* providerSnapshot(
            u.provider,
            (value) => (value.calls.mint ?? 0) > (before.calls.mint ?? 0),
          );

          expect(pending.calls.mint).toBe((before.calls.mint ?? 0) + 1);
          expect(
            (yield* get(`${u.account}/snapshot`, Snapshot)).alarm,
          ).not.toBeNull();
          time += 10_000;
          yield* post(`${u.account}/time`, time);
          yield* control.release;
          expect(yield* Fiber.join(one)).toEqual({ kind: "expired" });
          expect(yield* Fiber.join(two)).toEqual({ kind: "expired" });
          const after = yield* providerSnapshot(u.provider);
          expect(after.calls["POST /helix/chat/messages"]).toBe(
            before.calls["POST /helix/chat/messages"],
          );
          expect(after.calls.mint).toBe((before.calls.mint ?? 0) + 1);
        }),
      );
      yield* post(`${u.account}/credential`);
      const scheduled = yield* get(`${u.account}/snapshot`, Snapshot);
      expect(scheduled.alarm ?? 0).toBeGreaterThan(scheduled.time);
      yield* withProviderControl(
        u.provider,
        { appClient: "wrong-client" },
        Effect.fnUntraced(function* () {
          yield* post(`${u.account}/reconstruct`);

          const refused = yield* rpc(
            `${u.account}/dispatch`,
            DispatchOutcome,
            sendInput("bad-app", time + 10_000),
          );

          expect(refused.kind).toBe("retryable");
          expect(
            (yield* providerSnapshot(u.provider)).calls[
              "POST /helix/chat/messages"
            ],
          ).toBe(before.calls["POST /helix/chat/messages"]);
        }),
      );
      yield* post(`${u.account}/time`, time + 6000);
    }),
    { timeout: 90_000 },
  );

  test(
    "shared global/channel budgets survive requests and revocation blocks further delivery",
    Effect.gen(function* () {
      const u = yield* urls("budgets");
      yield* post(`${u.account}/configure`, {
        revision: "two-channels-final",
        channels: ["fixture_channel", "fixture_other"],
      });
      expect((yield* authorize(u.account)).status.setup).toBe("ready");
      const snapshot = yield* get(`${u.account}/snapshot`, Snapshot);
      const base = snapshot.time + 60_000;
      yield* post(`${u.account}/time`, base);
      expect(
        (yield* rpc(
          `${u.account}/dispatch`,
          DispatchOutcome,
          sendInput("budget-start", base + 10_000),
        )).kind,
      ).toBe("sent");

      const waiting = yield* rpc(
        `${u.account}/dispatch`,
        DispatchOutcome,
        sendInput("budget-wait", base + 10_000),
      );

      expect(waiting.kind).toBe("retryable");

      if (waiting.kind === "retryable")
        expect(Number(waiting.retryAt)).toBe(base + 1000);
      expect(
        (yield* rpc(
          `${u.account}/dispatch`,
          DispatchOutcome,
          sendInput("budget-other", base + 10_000, "300"),
        )).kind,
      ).toBe("sent");

      for (let i = 1; i <= 18; i++) {
        yield* post(`${u.account}/time`, base + i * 1000);
        expect(
          (yield* rpc(
            `${u.account}/dispatch`,
            DispatchOutcome,
            sendInput(`budget-${i}`, base + i * 1000 + 10_000),
          )).kind,
        ).toBe("sent");
      }

      expect(
        yield* rpc(
          `${u.account}/dispatch`,
          DispatchOutcome,
          sendInput("global-limit", base + 28_000, "300"),
        ),
      ).toEqual({ kind: "expired" });
      const remote = yield* providerSnapshot(u.provider);

      const subscription = remote.remote.find(
        (sub) => sub.condition.broadcaster_user_id === "300",
      );

      if (!subscription) return yield* Effect.die("Missing revocation fixture");
      yield* rpc(`${u.account}/observe`, Schema.Null, {
        id: subscription.id,
        broadcasterId: "300",
        senderId: "100",
        binding: yield* subscriptionBinding({
          callback: "https://fixture.invalid/webhooks/twitch",
          clientId: "fixture-twitch",
          signingSecret: Redacted.make("CANARY-SIGNING-SECRET"),
        }),
        callback: "https://fixture.invalid/webhooks/twitch",
        status: "authorization_revoked",
      });
      expect(
        yield* rpc(
          `${u.account}/dispatch`,
          DispatchOutcome,
          sendInput("revoked-final", base + 28_000, "300"),
        ),
      ).toEqual({ kind: "rejected" });

      const status = yield* get(
        `${u.account}/status`,
        Schema.Struct({
          kind: Schema.Literal("success"),
          value: AccountStatus,
        }),
      );

      expect(status.value.sender?.authorized).toBeTrue();
      expect(
        status.value.channels.some((channel) => channel.id === "300"),
      ).toBeFalse();
    }),
    { timeout: 120_000 },
  );
  test(
    "native account alarm recovers a reconstructed credential lease without losing its schedule",
    Effect.gen(function* () {
      const u = yield* urls("native-credentials");
      const snapshotSchema = NativeAlarmSnapshot;
      const clock = yield* Clock.Clock;
      const observationStart = clock.monotonicTimeNanosUnsafe();

      const remaining = () =>
        Math.max(
          1,
          45000 -
            Number(clock.monotonicTimeNanosUnsafe() - observationStart) / 1e6,
        );

      const native = (
        until: (value: typeof NativeAlarmSnapshot.Type) => boolean = () => true,
        budgetMs = remaining(),
      ) =>
        observe(
          auditedObservation(
            "native-account",
            `${u.account}/native-alarm/snapshot`,
            snapshotSchema,
          ),
          { until, budgetMs },
        );

      const retain = Effect.fnUntraced(function* (
        boundary: string,
        snapshots: Schema.Json,
      ) {
        const stage = process.env.ARC_CLOUD_STAGE;

        const entry = JSON.stringify({
          stage,
          at: Date.now(),
          boundary,
          snapshots,
        });

        console.info(`NATIVE_ALARM_ATTRIBUTION ${entry}`);
        yield* Effect.promise(() =>
          appendFile(
            new URL(
              `../../.cloud-tests/${stage}/native-alarm-attribution.jsonl`,
              import.meta.url,
            ),
            `${entry}\n`,
          ),
        );
      });

      yield* Effect.gen(function* () {
        const preparedResponse = yield* post(
          `${u.account}/native-alarm/prepare`,
        );

        const prepared = yield* json(
          preparedResponse,
          Schema.Struct({
            instance: Schema.String,
            until: Schema.Number,
            journey: Schema.String,
            nativeId: Schema.String,
          }),
        );

        expect(prepared.journey).toBe("native-credentials");
        expect(prepared.nativeId).not.toBe("");

        const before = yield* observe(
          auditedObservation(
            "provider",
            `${u.provider}/snapshot`,
            ProviderSnapshot,
          ),
          { until: () => true, budgetMs: 2000 },
        );

        yield* retain("prepared", {
          prepared,
          provider: before,
          target: yield* native(),
          other: yield* observe(
            auditedObservation(
              "attribution",
              `${u.account}/attribution`,
              LiveAccountAttribution,
            ),
            { until: () => true, budgetMs: 2000 },
          ),
        });
        expect(
          (yield* post(`${u.account}/native-alarm/reconstruct`)).status,
        ).toBe(204);
        yield* reconstructedSnapshot(native(), prepared.instance);

        const recovered = yield* native((value) =>
          value.attribution.completedRuns.some((run) => run.alarmRun === 1),
        );

        yield* retain("early-account", recovered);
        const earlyKey = completedRunKey(recovered.attribution, 1);
        const early = selectCompletedRun(recovered.attribution, earlyKey);
        expect(early.instance).not.toBe(prepared.instance);
        expect(early.alarmRun).toBe(1);
        expect(early.entryAlarm).toBeNull();
        expect(early.intended).toBe(prepared.until);
        expect(early.native).toBe(prepared.until);
        expect(early.lease?.until).toBe(prepared.until);
        yield* retain(
          "early-provider",
          yield* observe(
            auditedObservation(
              "provider",
              `${u.provider}/snapshot`,
              ProviderSnapshot,
            ),
            { until: () => true, budgetMs: 2000 },
          ),
        );

        const validated = yield* native((value) =>
          value.attribution.completedRuns.some((run) => run.alarmRun === 2),
        );

        yield* retain("late-account", validated);
        const recoveryKey = completedRunKey(validated.attribution, 2);
        const recovery = selectCompletedRun(validated.attribution, recoveryKey);
        expect(recovery.alarmRun).toBe(2);
        expect(recovery.lease).toBeNull();
        expect(recovery.intended ?? 0).toBeGreaterThan(prepared.until);
        expect(recovery.native).toBe(recovery.scheduled);

        const lateProvider = yield* observe(
          auditedObservation(
            "provider",
            `${u.provider}/snapshot`,
            ProviderSnapshot,
          ),
          { until: () => true, budgetMs: 2000 },
        );

        yield* retain("late-provider", lateProvider);

        const evidence = {
          earlyRunKey: earlyKey,
          recoveryRunKey: recoveryKey,
          preparedInstance: prepared.instance,
          leaseUntil: prepared.until,
        };

        const verified = yield* Effect.sync(() =>
          verifyCompletedRecovery({
            ...evidence,
            account: validated.attribution,
            provider: lateProvider.validations,
          }),
        );

        expect(verified.runKey).toBe(recoveryKey);
        yield* retain("verified-recovery", verified);

        const beforePaired = yield* native();

        const priorInstances = new Set(
          beforePaired.attribution.events.map((event) => event.instance),
        );

        const pairedRuns = (value: typeof snapshotSchema.Type) =>
          value.attribution.completedRuns.filter(
            (run) =>
              run.alarmRun > beforePaired.liveAlarmRuns &&
              !priorInstances.has(run.instance) &&
              run.validationInvocationIds.length > 0,
          );

        expect(
          (yield* post(`${u.account}/native-alarm/reconstruct`)).status,
        ).toBe(204);
        yield* reconstructedSnapshot(native(), beforePaired.instance);

        const paired = yield* native((value) => pairedRuns(value).length > 0);

        const pairedOrdinal = Math.min(
          ...pairedRuns(paired).map((run) => run.alarmRun),
        );

        const pairedKey = completedRunKey(paired.attribution, pairedOrdinal);
        const pairedRun = selectCompletedRun(paired.attribution, pairedKey);
        expect(pairedRun.instance).not.toBe(beforePaired.instance);

        const latestProvider = yield* observe(
          auditedObservation(
            "provider",
            `${u.provider}/snapshot`,
            ProviderSnapshot,
          ),
          { until: () => true, budgetMs: 2000 },
        );

        const pairedVerified = yield* Effect.sync(() =>
          verifyCompletedValidation({
            account: paired.attribution,
            provider: latestProvider.validations,
            runKey: pairedKey,
          }),
        );

        expect(pairedRun.lease).toBeNull();
        expect(pairedRun.native).toBe(pairedRun.scheduled);
        expect(pairedVerified.invocationId).not.toBe(verified.invocationId);
        expect(
          latestProvider.calls["GET /oauth/validate"] ?? 0,
        ).toBeGreaterThan((before.calls["GET /oauth/validate"] ?? 0) + 1);

        const reverified = yield* Effect.sync(() =>
          verifyCompletedRecovery({
            ...evidence,
            account: paired.attribution,
            provider: latestProvider.validations,
          }),
        );

        expect(reverified).toEqual(verified);
        yield* retain("paired-native-revalidation", {
          before: beforePaired,
          target: paired,
          provider: latestProvider,
          pairedVerified,
          reverified,
        });
      }).pipe(
        Effect.timeout(45000),
        Effect.onExit(() =>
          Effect.gen(function* () {
            const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.catchCause(() => Effect.succeed({ unavailable: true })),
              );

            yield* retain("final", {
              target: yield* safe(native(() => true, 2000)),
              other: yield* safe(
                observe(
                  auditedObservation(
                    "attribution",
                    `${u.account}/attribution`,
                    LiveAccountAttribution,
                  ),
                  { until: () => true, budgetMs: 2000 },
                ),
              ),
              provider: yield* safe(
                observe(
                  auditedObservation(
                    "provider",
                    `${u.provider}/snapshot`,
                    ProviderSnapshot,
                  ),
                  { until: () => true, budgetMs: 2000 },
                ),
              ),
            });
          }),
        ),
      );
    }),
    { timeout: 90_000 },
  );
  test(
    "Discord cloud fixture reconciles the full registry and detects partial or stale releases",
    Effect.gen(function* () {
      const u = yield* urls("registry");
      const health = yield* get(`${u.provider}/health`, ReleaseHealth);

      const release = {
        endpoint: u.provider,
        stage: health.stage,
        revision: "fixture-release",
        applicationId: "fixture-discord",
        token: Redacted.make("CANARY-DISCORD-TOKEN"),
      };

      const options = { api: u.provider };
      yield* post(`${u.provider}/control`, {
        commands: [
          { name: "obsolete", description: "obsolete", contexts: [0] },
          ...commandManifest
            .slice(1)
            .map((command, index) =>
              index === 0
                ? { ...command, description: "old definition" }
                : command,
            ),
        ],
      });
      expect((yield* syncCommands(release, options)).changed).toBeTrue();
      const written = yield* providerSnapshot(u.provider);
      expect((yield* syncCommands(release, options)).changed).toBeFalse();
      expect(
        (yield* providerSnapshot(u.provider)).calls[
          "PUT /applications/fixture-discord/commands"
        ],
      ).toBe(written.calls["PUT /applications/fixture-discord/commands"]);
      yield* post(`${u.provider}/control`, {
        commands: commandManifest.map((command, index) =>
          index === 0
            ? {
                ...command,
                name_localizations: { de: "kaufen" },
                options: command.options.map((option) => ({
                  ...option,
                  description_localizations: { de: "Objektname" },
                })),
              }
            : command,
        ),
      });
      expect(
        (yield* syncCommands(release, { ...options, checkOnly: true })).drift,
      ).toBeTrue();
      expect((yield* syncCommands(release, options)).changed).toBeTrue();
      expect((yield* syncCommands(release, options)).changed).toBeFalse();
      const localized = yield* providerSnapshot(u.provider);
      expect(localized.calls["discord-full-read"]).toBe(
        localized.calls["GET /applications/fixture-discord/commands"],
      );
      expect(localized.calls["discord-partial-read"] ?? 0).toBe(0);
      yield* withProviderControl(
        u.provider,
        { badDiscordReadback: true },
        Effect.fnUntraced(function* () {
          const failed = yield* syncCommands(release, options).pipe(
            Effect.flip,
          );

          expect(failed.code).toBe("readback");
          expect(failed.phase).toBe("after");
        }),
      );
      yield* withProviderControl(
        u.provider,
        { releaseRevision: "newer-release" },
        Effect.fnUntraced(function* () {
          const before = yield* providerSnapshot(u.provider);
          expect(
            (yield* syncCommands(release, options).pipe(Effect.flip)).code,
          ).toBe("stale-release");
          expect(
            (yield* providerSnapshot(u.provider)).calls[
              "PUT /applications/fixture-discord/commands"
            ],
          ).toBe(before.calls["PUT /applications/fixture-discord/commands"]);
        }),
      );
      yield* post(`${u.provider}/control`, { commands: [] });
      yield* withProviderControl(
        u.provider,
        { releaseRevision: "fixture-release", changeReleaseAfterWrite: true },
        Effect.fnUntraced(function* () {
          const raced = yield* syncCommands(release, options).pipe(Effect.flip);
          expect(raced.code).toBe("stale-release");
          expect(raced.phase).toBe("after");
        }),
      );
    }).pipe(Effect.provide(providerTransport)),
    { timeout: 60_000 },
  );
}
