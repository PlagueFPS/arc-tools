# Website development

Read [FOLDKIT.md](./FOLDKIT.md) before changing this Foldkit app.

subtree_prompted: false

Use the installed package declaration files as the API reference. This app does not vendor the optional Foldkit source subtree. The installed declarations are the authority for Foldkit, Effect, and `@foldkit/ui` signatures. Keep the scaffold conventions in FOLDKIT.md intact.

The website uses Foldkit 0.169.0 with its exact Effect 4.0.0 peer. The server remains on Effect 4.0.4. TypeScript paths and Vite deduplication resolve the browser-safe shared enrollment source against the frontend Effect version. Keep both resolutions together.

Bot is the canonical public origin. Website is a private asset worker with no Bot dependency. OAuth and enrollment cookies belong to Bot. Do not import server barrels into browser code. Status success contains only the shared EnrollmentStatus.

Production HTML is generated at build time. `src/entry.server.ts` prerenders `/` and `/connect`. The source tree has no `index.html`. The asset worker serves `index.html` and `connect/index.html`.

Alchemy 2.0.0-beta.83 `Cloudflare.Website.Foldkit` cannot forward `viteEnvironments`. `stacks/website.ts` uses `Cloudflare.Website.Vite` with `viteEnvironments.entry` set to `static`. That environment is not built. The website Vite config then clears the in-memory `ssr` bundle. Prerender still reads `dist/server/fetch.js` from disk, and Alchemy reports no server bundle. The deployed files are the generated client HTML and assets.

Dev Vite `base` is `/assets/`. `import.meta.env.BASE_URL` is the prefix `urlToAppRoute` removes and `homeHref` / `connectHref` add. `/assets/` and `/assets/connect` are Home and Connect during development. `/` and `/connect` are those routes in production and in `vite preview`. The connect prerender is the loading shell. The browser requests enrollment status once, after hydration. Unknown paths stay 404. There is no SPA fallback.

`bun run --cwd apps/website preview` serves `dist/client`. `/` is the home page, `/connect` is the connection page, and files under `/assets/` are the built stylesheet and script. Preview does not call `renderPage`.

Run the repository root checks in this order after code changes.

1. `bun run typecheck`
2. `bun run lint`
3. `bun run fmt`
4. `bun run test`

`bun run --cwd apps/website dev` serves the standalone visual preview at http://127.0.0.1:5180. Enrollment needs the Bot origin and its HTTPS cookie. Use the configured Alchemy development stack for the complete flow.
