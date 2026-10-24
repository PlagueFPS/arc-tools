import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
          include: ["src/story.test.ts", "src/scene.test.ts"],
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
});
