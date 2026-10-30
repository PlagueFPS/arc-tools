/* oxlint-disable effecttsgo/node-builtin-import -- Vite resolves the repository's environment directory at its configuration boundary. */
import { fileURLToPath } from "node:url";

import { guildInstallUrl } from "@arctools/discord/install";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { Effect } from "effect";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../../", import.meta.url)),
    "DISCORD_APPLICATION_ID",
  );

  const discordInstallUrl = Effect.runSync(
    guildInstallUrl({ applicationId: env.DISCORD_APPLICATION_ID ?? "" }),
  );

  return {
    define: {
      "import.meta.env.VITE_DISCORD_INSTALL_URL":
        JSON.stringify(discordInstallUrl),
    },
    appType: "mpa",
    server: { port: 3000, strictPort: true },
    preview: { port: 3000, strictPort: true },
    resolve: { tsconfigPaths: true },
    ssr: { external: ["cloudflare:workers"] },
    optimizeDeps: { exclude: ["cloudflare:workers"] },
    environments: {
      ssr: { build: { rolldownOptions: { external: ["cloudflare:workers"] } } },
    },
    plugins: [
      tailwindcss(),
      foldkit({
        ssr: {
          serverEntry: "/src/entry.server.ts",
          clientEntry: "/src/entry.ts",
          build: { prerender: true },
        },
      }),
    ],
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: "browser",
            include: ["src/**/story.test.ts", "src/**/scene.test.ts"],
            environment: "happy-dom",
            setupFiles: ["./src/test-setup.ts"],
          },
        },
        {
          extends: true,
          test: {
            name: "server",
            include: ["src/server/**/*.test.ts"],
            environment: "node",
          },
        },
      ],
    },
  };
});
