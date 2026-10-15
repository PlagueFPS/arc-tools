import { ManagedRuntime } from "effect";
import { CommandLayer } from "./layers.js";

export const CommandRuntime = ManagedRuntime.make(CommandLayer);
