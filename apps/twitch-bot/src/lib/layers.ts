import { FetchHttpClient } from "@effect/platform";
import { ManagedRuntime } from "effect";

export const CommandRuntime = ManagedRuntime.make(FetchHttpClient.layer);
