import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy/State/LocalState";
import { Effect } from "effect";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "arc-bot",
  {
    providers: Cloudflare.providers(),
    state: localState(),
    secrets: Alchemy.Secrets.DotEnv({
      path: new URL("../../.env", import.meta.url).pathname,
    }),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
