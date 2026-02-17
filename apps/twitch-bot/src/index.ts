import { BunRuntime } from "@effect/platform-bun";
import { Bot } from "@twurple/easy-bot";
import { Config, Effect } from "effect";
import { AuthProvider } from "@/lib/auth";
import { twitchCommands } from "./commands";

const startTwitchBot = Effect.gen(function* () {
  yield* Effect.log("Twitch Bot starting...");
  const { authProvider } = yield* AuthProvider;
  const joinSecret = yield* Config.string("BOT_JOIN_SECRET");
  const joinPort = yield* Config.number("PORT");

  const bot = new Bot({
    authProvider,
    channels: ["arctoolsbot", "k4rnivore"],
    commands: twitchCommands,
  });

  bot.onConnect(() => console.log("Successfully connected to Twitch"));
  bot.onJoin((channel) => console.log(`Joined ${channel.broadcasterName}`));

  Bun.serve({
    port: joinPort,
    async fetch(req) {
      if (
        req.method !== "POST" ||
        new URL(req.url).pathname !== "/internal/join"
      ) {
        return new Response("Not Found", { status: 404 });
      }
      const secret = req.headers.get("X-Bot-Join-Secret");
      if (secret !== joinSecret) {
        return new Response("Unauthorized", { status: 401 });
      }
      let body: { channel?: string };
      try {
        body = await req.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      const channel = body?.channel;
      if (typeof channel !== "string" || !channel.trim()) {
        return new Response("Bad Request", { status: 400 });
      }
      const normalized = channel.trim().toLowerCase().replace(/^#/, "");
      try {
        await bot.join(normalized);
        return new Response(JSON.stringify({ ok: true, channel: normalized }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Failed to join channel:", err);
        return new Response(
          JSON.stringify({ ok: false, error: "Failed to join channel" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    },
  });

  yield* Effect.log(`Join API listening on port ${joinPort}`);
}).pipe(Effect.provide(AuthProvider.Default));

BunRuntime.runMain(startTwitchBot);
