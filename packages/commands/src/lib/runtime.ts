import { ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

export const CommandRuntime = ManagedRuntime.make(FetchHttpClient.layer);
