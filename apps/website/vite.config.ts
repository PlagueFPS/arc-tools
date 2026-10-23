import { foldkit, foldkitBuild } from "@foldkit/vite-plugin";
import stylex from "@stylexjs/unplugin";
import type { Plugin } from "vite";
import { createRunnableDevEnvironment } from "vite";
import { defineConfig } from "vitest/config";

const stylexPlugin: Plugin = stylex.vite({ useCSSLayers: true });

// StyleX 0.19.1's dev middleware and runtime ignore Vite's base path.
const stylexBase: Plugin = {
  name: "arctools:stylex-base",
  enforce: "pre",
  apply: "serve",
  configureServer(server) {
    const stylesheet = `${server.config.base}virtual:stylex.css`;

    server.middlewares.use((request, _response, next) => {
      const url = new URL(request.url ?? "/", "http://vite.internal");

      if (url.pathname === stylesheet) {
        request.url = `/virtual:stylex.css${url.search}`;
      }

      next();
    });
  },
  transform(code, id) {
    if (!id.includes("virtual:stylex:runtime")) return;

    return code.replace(
      "'/virtual:stylex.css'",
      "import.meta.env.BASE_URL + 'virtual:stylex.css'",
    );
  },
};

if (process.env.VITEST) {
  // NOTE: StyleX's dev poller requires an HTTP server to clean up; Vitest has none.
  delete stylexPlugin.configureServer;
}

const serverEntry = "/src/entry.server.ts";

const clientEntry = "/src/entry.ts";

const clientOutDir = "dist/client";

// Alchemy 2.0.0-beta.83 collects every non-client environment
// (`Bundle/Vite.ts`). `viteEnvironments.entry: "static"` avoids "Entry chunk
// not found" because that environment never builds. Clearing this bundle
// avoids "Missing server entry" after the files are already on disk for
// Foldkit's prerender import. `Website.Foldkit` cannot forward
// `viteEnvironments`, so the stack uses `Website.Vite`.
const staticWebsite: Plugin = {
  name: "arctools:static-website",
  apply: "build",
  enforce: "pre",
  sharedDuringBuild: true,
  writeBundle(_options, bundle) {
    if (process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED !== "1") return;

    if (this.environment.name !== "ssr") return;

    for (const fileName of Object.keys(bundle)) {
      delete bundle[fileName];
    }
  },
};

const nodeServerEnvironment: Plugin = {
  name: "arctools:node-server-environment",
  enforce: "post",
  config(_config, { isPreview }) {
    if (isPreview) {
      return {
        appType: "mpa" as const,
        build: { outDir: clientOutDir },
        environments: {
          client: { build: { outDir: clientOutDir } },
        },
      };
    }

    return {
      appType: "custom" as const,
      environments: {
        ssr: {
          dev: {
            createEnvironment(name, config) {
              return createRunnableDevEnvironment(name, config);
            },
          },
        },
      },
    };
  },
  configurePreviewServer(server) {
    // Vite's mpa fallback rewrites a trailing slash to `index.html`.
    // `/connect` has no `connect.html`, so the directory index needs the slash.
    server.middlewares.use((req, _res, next) => {
      const url = req.url;

      if (url === undefined) {
        next();

        return;
      }

      const pathname = url.split("?", 1)[0] ?? url;

      if (pathname === "/connect") {
        req.url = `/connect/${url.slice(pathname.length)}`;
      }

      next();
    });
  },
};

export default defineConfig(({ command, isPreview }) => ({
  base: command === "serve" && !isPreview ? "/assets/" : "/",
  plugins: [
    stylexBase,
    stylexPlugin,
    foldkit({
      ssr: {
        serverEntry,
        clientEntry,
      },
    }),
    {
      ...foldkitBuild(serverEntry, {
        clientEntry,
        prerender: true,
      }),
      enforce: "post",
    },
    staticWebsite,
    nodeServerEnvironment,
  ],
  resolve: { dedupe: ["effect"] },
  optimizeDeps: { entries: ["src/entry.ts"] },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    server: {
      deps: { inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"] },
    },
  },
}));
