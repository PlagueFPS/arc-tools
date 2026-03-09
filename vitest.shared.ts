import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.repos/**"],
    setupFiles: [path.join(__dirname, "vitest.setup.ts")],
    include: ["test/**/*.test.{ts,tsx}"],
  },
})
