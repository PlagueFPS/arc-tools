import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { provisionDiscord, provisionTwitch } from "../src/provision.ts";

type Call = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
};
async function fixture(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const body: unknown = text === "" ? undefined : JSON.parse(text);
      const call = {
        method: request.method ?? "",
        path: request.url ?? "",
        body,
        authorization: request.headers.authorization,
      };
      calls.push(call);
      const result = handler(call);
      response.writeHead(result === undefined ? 204 : 200, {
        "content-type": "application/json",
      });
      response.end(result === undefined ? undefined : JSON.stringify(result));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture has no port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
const sub = (id: string, channel = "101", status = "enabled") => ({
  id,
  type: "channel.chat.message",
  version: "1",
  status,
  condition: { broadcaster_user_id: channel, user_id: "999" },
  transport: {
    method: "webhook",
    callback: "https://bot.test/webhooks/twitch",
  },
});
const twitchOptions = {
  clientId: "client",
  appToken: "app-token",
  botId: "999",
  channels: ["101", "202"],
  callback: "https://bot.test/webhooks/twitch",
  secret: "local-webhook-secret",
};

test("Discord global bulk registration derives all ten guild commands from the registry", async () => {
  const api = await fixture(() => [{ id: "1000", name: "buy" }]);
  try {
    const result = await Effect.runPromise(
      provisionDiscord({
        applicationId: "123",
        botToken: "bot-token",
        apiBase: api.base,
      }),
    );
    expect(result).toEqual([{ id: "1000", name: "buy" }]);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.method).toBe("PUT");
    expect(api.calls[0]?.path).toBe("/applications/123/commands");
    expect(api.calls[0]?.authorization).toBe("Bot bot-token");
    const expected = [
      {
        name: "buy",
        description: "Get the trader that sells an item and its price.",
        option: "item",
        optionDescription: "Item name",
      },
      {
        name: "loot",
        description: "Get the items dropped by an arc.",
        option: "arc",
        optionDescription: "Arc name",
      },
      {
        name: "craft",
        description: "Get the required items and workbench to craft an item.",
        option: "item",
        optionDescription: "Item name",
      },
      {
        name: "find",
        description: "Get the loot areas where an item can be found.",
        option: "item",
        optionDescription: "Item name",
      },
      {
        name: "sell",
        description: "Get the sell value of an item.",
        option: "item",
        optionDescription: "Item name",
      },
      {
        name: "recycle",
        description: "Get the items granted for recycling an item.",
        option: "item",
        optionDescription: "Item name",
      },
      {
        name: "recycleto",
        description: "Get all items that recycle into a specific item.",
        option: "item",
        optionDescription: "Item name",
      },
      {
        name: "event",
        description:
          "Get currently active or upcoming events by event or map name.",
        option: "event_or_map",
        optionDescription: "Event or map name",
      },
      {
        name: "upcoming",
        description: "Display all upcoming events within the next 2 hours.",
        option: "",
        optionDescription: "",
      },
      {
        name: "active",
        description: "Display all currently active events.",
        option: "",
        optionDescription: "",
      },
    ];
    expect(api.calls[0]?.body).toEqual(
      expected.map((command) => ({
        type: 1,
        name: command.name,
        description: command.description,
        integration_types: [0],
        contexts: [0],
        options:
          command.option === ""
            ? []
            : [
                {
                  type: 3,
                  name: command.option,
                  description: command.optionDescription,
                  required: true,
                },
              ],
      })),
    );
  } finally {
    await api.close();
  }
});

test("Twitch reconciliation paginates, removes only matching duplicates, and accepts real create responses without pagination", async () => {
  const api = await fixture((call) => {
    if (call.method === "DELETE") return undefined;
    if (call.method === "POST")
      return {
        data: [sub("new-202", "202", "webhook_callback_verification_pending")],
        total: 5,
        total_cost: 0,
        max_total_cost: 10000,
      };
    if (call.path.includes("after="))
      return {
        data: [
          sub("duplicate"),
          sub("revoked", "101", "authorization_revoked"),
        ],
        pagination: {},
      };
    return {
      data: [
        sub("keeper"),
        {
          ...sub("other-bot"),
          condition: { broadcaster_user_id: "101", user_id: "555" },
        },
        {
          ...sub("other-callback"),
          transport: {
            method: "webhook",
            callback: "https://other.test/webhooks/twitch",
          },
        },
        { ...sub("websocket"), transport: { method: "websocket" } },
      ],
      pagination: { cursor: "next-page" },
    };
  });
  try {
    expect(
      await Effect.runPromise(
        provisionTwitch({ ...twitchOptions, apiBase: api.base }),
      ),
    ).toEqual({ created: 1, deleted: 2 });
    expect(api.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/eventsub/subscriptions"],
      ["GET", "/eventsub/subscriptions?after=next-page"],
      ["DELETE", "/eventsub/subscriptions?id=duplicate"],
      ["DELETE", "/eventsub/subscriptions?id=revoked"],
      ["POST", "/eventsub/subscriptions"],
    ]);
    expect(api.calls[4]?.body).toEqual({
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: "202", user_id: "999" },
      transport: {
        method: "webhook",
        callback: "https://bot.test/webhooks/twitch",
        secret: "local-webhook-secret",
      },
    });
    for (const call of api.calls)
      expect(call.authorization).toBe("Bearer app-token");
  } finally {
    await api.close();
  }
});

test("an enabled or pending matching subscription is retained, and explicit recreation rotates its secret", async () => {
  const api = await fixture((call) =>
    call.method === "DELETE"
      ? undefined
      : call.method === "POST"
        ? { data: [sub("new")], total: 1, total_cost: 0, max_total_cost: 10000 }
        : {
            data: [
              sub("existing", "101", "webhook_callback_verification_pending"),
            ],
            pagination: {},
          },
  );
  try {
    expect(
      await Effect.runPromise(
        provisionTwitch({
          ...twitchOptions,
          channels: ["101"],
          apiBase: api.base,
        }),
      ),
    ).toEqual({ created: 0, deleted: 0 });
    expect(
      await Effect.runPromise(
        provisionTwitch({
          ...twitchOptions,
          channels: ["101"],
          apiBase: api.base,
          recreate: true,
        }),
      ),
    ).toEqual({ created: 1, deleted: 1 });
    expect(api.calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "DELETE",
      "POST",
    ]);
  } finally {
    await api.close();
  }
});

test("repeated pagination cursors fail before any provisioning writes", async () => {
  const api = await fixture(() => ({
    data: [],
    pagination: { cursor: "repeat" },
  }));
  try {
    const exit = await Effect.runPromiseExit(
      provisionTwitch({ ...twitchOptions, apiBase: api.base }),
    );
    expect(exit._tag).toBe("Failure");
    expect(api.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  } finally {
    await api.close();
  }
});

test.each([
  false,
  true,
])("overlapping subscription pages keep stable IDs during recreate=%s", async (recreate) => {
  const api = await fixture((call) => {
    if (call.method === "DELETE") return undefined;
    if (call.method === "POST")
      return {
        data: [sub("new")],
        total: 1,
        total_cost: 0,
        max_total_cost: 10000,
      };
    return {
      data: [sub("same-id")],
      pagination: call.path.includes("after=") ? {} : { cursor: "next" },
    };
  });
  try {
    expect(
      await Effect.runPromise(
        provisionTwitch({
          ...twitchOptions,
          channels: ["101"],
          apiBase: api.base,
          recreate,
        }),
      ),
    ).toEqual(
      recreate ? { created: 1, deleted: 1 } : { created: 0, deleted: 0 },
    );
    expect(api.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/eventsub/subscriptions"],
      ["GET", "/eventsub/subscriptions?after=next"],
      ...(recreate
        ? [
            ["DELETE", "/eventsub/subscriptions?id=same-id"],
            ["POST", "/eventsub/subscriptions"],
          ]
        : []),
    ]);
  } finally {
    await api.close();
  }
});
