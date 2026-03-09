import { BASE_API_URL } from "@arctools/utils";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

export interface MockTraders {
  Apollo: Array<{ id: string; name: string; trader_price: number }>;
  Celeste: Array<{ id: string; name: string; trader_price: number }>;
  Lance: Array<{ id: string; name: string; trader_price: number }>;
  Shani: Array<{ id: string; name: string; trader_price: number }>;
  TianWen: Array<{ id: string; name: string; trader_price: number }>;
}

export interface MockData {
  traders?: MockTraders;
}

const emptyTraders: MockTraders = {
  Apollo: [],
  Celeste: [],
  Lance: [],
  Shani: [],
  TianWen: [],
};

export function createMockHttpClientLayer(mock: MockData) {
  const traders = mock.traders ?? emptyTraders;
  const baseUrl = `${BASE_API_URL.replace(/\/$/, "")}/`;

  const mockClient = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const url = request.url;
        if (!url.startsWith(baseUrl)) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ error: "unexpected url" }), {
              status: 404,
            }),
          );
        }
        const path = url.slice(baseUrl.length).split("?")[0];

        if (path === "traders") {
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ data: traders }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
        );
      }),
  );

  return Layer.succeed(HttpClient.HttpClient, mockClient);
}

export function createMockReply() {
  const calls: Array<{ content: string }> = [];
  const fn = (opts: { content: string }) => {
    calls.push(opts);
    return Promise.resolve();
  };
  return { calls, fn };
}

export function createMockMessage(overrides: {
  author?: { bot?: boolean };
  content?: string;
  reply: {
    calls: Array<{ content: string }>;
    fn: (opts: { content: string }) => Promise<unknown>;
  };
}) {
  const { reply, ...rest } = overrides;
  return {
    ...rest,
    author: { bot: false, ...overrides.author },
    content: overrides.content ?? "",
    reply: reply.fn,
  } as never;
}
