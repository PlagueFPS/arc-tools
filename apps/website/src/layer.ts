import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Layer } from "effect";
import { KeyValueStore } from "effect/persistence";

// Some browser policies deny access to the localStorage object itself.
export const BrowserStorageLayer = BrowserKeyValueStore.layerLocalStorage.pipe(
  Layer.catchCause(() => KeyValueStore.layerMemory),
);
