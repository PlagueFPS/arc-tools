import { ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

export const CommandRuntime = ManagedRuntime.make(FetchHttpClient.layer);
