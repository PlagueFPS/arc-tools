/* oxlint-disable effecttsgo/node-builtin-import -- Vite resolves the repository's environment directory at its configuration boundary. */
import { fileURLToPath } from "node:url";

import { guildInstallUrl } from "@arctools/discord/install";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { Effect, String as Str } from "effect";
import { type Plugin, loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const isFoldkitBuildTokenRequest = (url: string | undefined) => {
  if (url === undefined) return false;
  const [rawPath] = Str.split("?")(url);
  const pathname = Str.replace(/\\/g, "/")(rawPath);

  return (
    Str.endsWith("/foldkit/dist/buildToken.js")(pathname) ||
    Str.endsWith("/foldkit/src/buildToken.ts")(pathname)
  );
};

// Vite tags excluded node_modules imports with ?v=<browserHash> and serves any
// ?v= request as immutable, while Foldkit's dev server compiles a fresh UUID
// into buildToken.js on every startup.
const foldkitDevBuildToken = (): Plugin => ({
  name: "arctools:foldkit-dev-build-token",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (isFoldkitBuildTokenRequest(request.url)) {
        const setHeader = response.setHeader.bind(response);
        response.setHeader = (name, value) =>
          setHeader(
            name,
            Str.toLowerCase(name) === "cache-control" ? "no-store" : value,
          );
      }

      next();
    });
  },
});

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
      foldkitDevBuildToken(),
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
            include: [
              "src/**/story.test.ts",
              "src/**/scene.test.ts",
              "src/**/browser.test.ts",
            ],
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
