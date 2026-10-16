import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { fixture, observation } from "./subscription-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

test(
  "confirmed list authorization loss remains repairable after retirement and signed revocation",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const record = f.control.remote.get("created-1");
    if (!record) throw new Error("missing confirmed fixture subscription");
    f.control.remote.set(record.id, {
      ...record,
      status: "authorization_revoked",
    });
    f.control.response = { status: 403, body: "missing grant" };
    const first = yield* a.service.setup("operator").pipe(Effect.result);
    yield* a.service.observeSubscription(
      observation(a.config, record.id, "authorization_revoked"),
    );
    const second = yield* a.service.setup("operator");
    expect({
      first:
        first._tag === "Failure"
          ? first.failure.code
          : first.success.status.setup,
      links: second.authorizations.map((entry) => entry.login).sort(),
      sender: second.status.sender?.authorized,
      channel: second.status.channels[0]?.authorized,
      calls: f.control.calls,
    }).toEqual({
      first: "stale",
      links: ["fixture_channel", "fixture_sender"],
      sender: false,
      channel: false,
      calls: { get: 2, post: 1, delete: 0, conflict: 0, send: 0 },
    });
  }),
);

test(
  "HTML users 401 invalidates the rejected credential on every setup",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    f.control.responses.set(
      "GET /users",
      () => new Response("<html>rejected</html>", { status: 401 }),
    );
    const generations: (string | undefined)[] = [];
    const codes: string[] = [];
    const credentials: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      generations.push(f.snapshot().session?.generation);
      const result = yield* a.service.setup("operator").pipe(Effect.result);
      codes.push(result._tag === "Failure" ? result.failure.code : "success");
      credentials.push((yield* a.service.status()).credential);
    }
    expect({
      codes,
      credentials,
      sameGeneration: generations[0] === generations[1],
      tokenPosts: f.control.requests.filter(
        (entry) => entry.path === "/token" && entry.method === "POST",
      ).length,
      sends: f.control.calls.send,
    }).toEqual({
      codes: ["client", "client"],
      credentials: ["absent", "absent"],
      sameGeneration: false,
      tokenPosts: 4,
      sends: 0,
    });
  }),
);
