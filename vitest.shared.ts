import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ViteUserConfig } from "vitest/config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const config: ViteUserConfig = {
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.repos/**"],
    setupFiles: [path.join(__dirname, "vitest.setup.ts")],
    include: ["test/**/*.test.{ts,tsx}"],
  },
}

export default config
