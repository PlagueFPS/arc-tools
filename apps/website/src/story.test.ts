import { Effect, Layer, Option, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AsyncData } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";
import { expect, test } from "vitest";

import {
  CheckEnrollment,
  EffectsLayer,
  LoadExternal,
  NavigateInternal,
  ScrollToContent,
  checkEnrollment,
} from "./command";
import {
  CheckError,
  Enrollment,
  EnrollmentStatus,
  RequestId,
} from "./domain/enrollment";
import { init, update } from "./main";
import { Message } from "./message";
import type { Model } from "./model";
import { ApplicationRoute } from "./route";

const url = (path: string) =>
  Option.getOrThrow(fromString(`https://bot.invalid${path}`));

const initial = () => init(url("/connect"));

test("entering connect checks once and duplicate refresh clicks preserve the active request", () => {
  const started = initial();
  expect(started.commands).toHaveLength(1);
  story(
    update,
    given(started.model),
    message(Message.ClickedCheckStatus()),
    model((current) => expect(current).toEqual(started.model)),
  );
  expect(
    update(started.model, Message.ClickedCheckStatus()).commands,
  ).toBeUndefined();
});

test("pending refresh retains data then becomes ready for this channel", () => {
  story(
    update,
    given({
      route: ApplicationRoute.Connect(),
      enrollment: Enrollment.Success({ data: { kind: "pending" } }),
      requestId: RequestId.make(1),
    }),
    message(Message.ClickedCheckStatus()),
    model((current) =>
      expect(current.enrollment).toEqual(
        Enrollment.Refreshing({ data: { kind: "pending" } }),
      ),
    ),
    Command.resolve(
      CheckEnrollment,
      Message.SucceededCheckEnrollment({
        requestId: RequestId.make(2),
        status: { kind: "ready", login: "raider" },
      }),
    ),
    model((current) =>
      expect(current.enrollment).toEqual(
        Enrollment.Success({ data: { kind: "ready", login: "raider" } }),
      ),
    ),
  );
});

test("route exit and reentry ignore the response from the previous request", () => {
  const started = initial();
  const left = update(started.model, Message.ChangedUrl({ url: url("/") }));

  const returned = update(
    left.model,
    Message.ChangedUrl({ url: url("/connect") }),
  );

  const stale = update(
    returned.model,
    Message.SucceededCheckEnrollment({
      requestId: started.model.requestId,
      status: { kind: "ready", login: "old" },
    }),
  );

  expect(stale.model).toEqual(returned.model);
  expect(stale.commands).toBeUndefined();
  expect(returned.model.requestId).not.toBe(started.model.requestId);
});

test("an unavailable refresh preserves last known data and an absent session clears it", () => {
  const started = {
    ...initial().model,
    enrollment: Enrollment.Refreshing({
      data: { kind: "pending" } satisfies EnrollmentStatus,
    }),
  };

  expect(
    update(
      started,
      Message.FailedCheckEnrollment({
        requestId: started.requestId,
        error: CheckError.Unavailable(),
      }),
    ).model.enrollment,
  ).toEqual(
    Enrollment.Stale({
      data: { kind: "pending" },
      error: CheckError.Unavailable(),
    }),
  );
  expect(
    update(
      started,
      Message.FailedCheckEnrollment({
        requestId: started.requestId,
        error: CheckError.Absent(),
      }),
    ).model.enrollment,
  ).toEqual(Enrollment.Failure({ error: CheckError.Absent() }));
});

test("OAuth navigation leaves the application and unknown URLs use NotFound", () => {
  const started = init(url("/"));
  story(
    update,
    given(started.model),
    message(
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: url("/oauth/twitch/enroll") }),
      }),
    ),
    Command.expectExact(
      LoadExternal({ href: "https://bot.invalid/oauth/twitch/enroll" }),
    ),
    Command.resolve(LoadExternal, Message.CompletedLoadExternal()),
  );
  expect(init(url("/unknown")).model.route).toEqual(
    ApplicationRoute.NotFound({ path: "/unknown" }),
  );
  expect(started.commands).toHaveLength(0);
});

const checkResponse = (body: string, status = 200) =>
  checkEnrollment().pipe(
    Effect.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.url).toBe("/oauth/twitch/enroll/status");

          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(body, { status })),
          );
        }),
      ),
    ),
    Effect.result,
    Effect.runPromise,
  );

test.each([
  { kind: "pending" },
  { kind: "ready", login: "raider" },
  { kind: "failed", reason: "denied" },
])("HTTP status decodes the shared contract %j", async (status) => {
  expect(await checkResponse(JSON.stringify(status))).toEqual(
    Result.succeed(status),
  );
});

test("HTTP distinguishes absent sessions from unavailable or invalid responses", async () => {
  expect(await checkResponse("{}", 401)).toEqual(
    Result.fail(CheckError.Absent()),
  );
  expect(await checkResponse("{}", 503)).toEqual(
    Result.fail(CheckError.Unavailable()),
  );
  expect(
    Result.isFailure(await checkResponse('{"sender":"private","channels":[]}')),
  ).toBe(true);
  expect(Result.isFailure(await checkResponse("invalid JSON"))).toBe(true);
});

test("remaining on connect does not duplicate its entry check", () => {
  const started = initial();

  story(
    update,
    given(started.model),
    message(Message.ChangedUrl({ url: url("/connect#main") })),
    model((current) => expect(current).toEqual(started.model)),
    Command.expectExact(ScrollToContent({ hash: "main" })),
    Command.resolve(ScrollToContent, Message.CompletedScrollToContent()),
  );
});

test("a content hash moves to main and an in-app link stays inside the page", () => {
  story(
    update,
    given(init(url("/")).model),
    message(
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: url("/#main") }),
      }),
    ),
    Command.expectExact(NavigateInternal({ url: "https://bot.invalid/#main" })),
    Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    message(Message.ChangedUrl({ url: url("/#main") })),
    Command.expectExact(ScrollToContent({ hash: "main" })),
    Command.resolve(ScrollToContent, Message.CompletedScrollToContent()),
  );

  const home = init(url("/#main"));

  expect(home.model.route).toEqual(ApplicationRoute.Home());
  Command.expectExact(ScrollToContent({ hash: "main" }))({
    ...home,
    commands: home.commands ?? [],
    outMessage: undefined,
  });

  const opened = init(url("/connect#session"));

  expect(opened.model.requestId).toBe(RequestId.make(1));
  Command.expectExact(
    CheckEnrollment({ requestId: RequestId.make(1) }),
    ScrollToContent({ hash: "session" }),
  )({ ...opened, commands: opened.commands ?? [], outMessage: undefined });
});

test("a duplicate settled response and a stale failure leave the visible status", () => {
  const ready = {
    route: ApplicationRoute.Connect(),
    enrollment: Enrollment.Success({
      data: { kind: "ready", login: "raider" },
    }),
    requestId: RequestId.make(2),
  };

  expect(
    update(
      ready,
      Message.SucceededCheckEnrollment({
        requestId: RequestId.make(2),
        status: { kind: "pending" },
      }),
    ).model,
  ).toEqual(ready);

  const refreshing = {
    ...ready,
    enrollment: Enrollment.Refreshing({
      data: { kind: "ready", login: "raider" },
    }),
    requestId: RequestId.make(3),
  };

  expect(
    update(
      refreshing,
      Message.FailedCheckEnrollment({
        requestId: RequestId.make(2),
        error: CheckError.Unavailable(),
      }),
    ).model,
  ).toEqual(refreshing);
});

test("leaving Connect aborts the pending browser request", async () => {
  const { Deferred, Exit, Fiber } = await import("effect");
  const { FetchHttpClient } = await import("effect/http");
  const started = await Effect.runPromise(Deferred.make<void>());
  let aborted = false;

  const transport: typeof fetch = (_input, options) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;

      if (!signal) throw new Error("Expected an abortable browser request");
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
      void Effect.runPromise(Deferred.succeed(started, undefined));
    });

  const opening = init(url("/connect"));
  const request = CheckEnrollment({ requestId: opening.model.requestId });

  const fiber = Effect.runFork(
    request.effect.pipe(
      Effect.provide(CheckEnrollment.layer),
      Effect.provideService(FetchHttpClient.Fetch, transport),
    ),
  );

  await Effect.runPromise(Deferred.await(started));
  const leaving = update(opening.model, Message.ChangedUrl({ url: url("/") }));

  for (const command of leaving.commands ?? [])
    await Effect.runPromise(command.effect.pipe(Effect.provide(EffectsLayer)));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(aborted).toBe(true);
  expect(Exit.isFailure(exit)).toBe(true);
});

test("an absent session followed by an unavailable refresh never restores a former channel", () => {
  const ready: Model = {
    route: ApplicationRoute.Connect(),
    enrollment: Enrollment.Success({
      data: { kind: "ready", login: "former_channel" },
    }),
    requestId: RequestId.make(5),
  };

  const refresh = update(ready, Message.ClickedCheckStatus());

  const absent = update(
    refresh.model,
    Message.FailedCheckEnrollment({
      requestId: refresh.model.requestId,
      error: CheckError.Absent(),
    }),
  );

  const retry = update(absent.model, Message.ClickedCheckStatus());

  const unavailable = update(
    retry.model,
    Message.FailedCheckEnrollment({
      requestId: retry.model.requestId,
      error: CheckError.Unavailable(),
    }),
  );

  expect(AsyncData.getData(unavailable.model.enrollment)).toEqual(
    Option.none(),
  );
});
