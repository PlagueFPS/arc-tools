import { mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

export default mergeConfig(shared, {
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
