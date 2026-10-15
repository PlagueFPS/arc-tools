import { layerUncached } from "@arctools/arc-data";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";

export const CommandLayer = layerUncached.pipe(
  Layer.provide(FetchHttpClient.layer),
);
