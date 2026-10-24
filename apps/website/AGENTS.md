# Website development

The website uses Foldkit 0.167.0, @foldkit/vite-plugin 0.27.0, Tailwind CSS, foldcn components, and locally served Fontsource Barlow. Match the Alchemy Foldkit example's Effect 4.0.5 alignment through root overrides. Keep Foldkit UI and DevTools versions aligned with Foldkit. Read the `foldkit` and `generate-program` skills before changing the application. Installed declarations and the pinned upstream examples are authoritative. The Foldkit subtree was previously declined; use a temporary checkout of its matching release for reference.

`model.ts`, `message.ts`, and `main.ts` implement the pure Foldkit update loop. `command.ts` owns browser effects. `view/` keeps the shell, header, landing, chat preview, and connection views separate. `src/styles.css` owns Tailwind tokens and resets. Apply component styling with utility classes. Add foldcn components through the `@foldcn` registry in `components.json`; its Button and Card render native Foldkit HTML, with no React or Base UI runtime. Keep registry files typed TypeScript when the shadcn CLI emits JavaScript.

Enrollment uses Foldkit AsyncData. Status is browser state, loaded by a Command after hydration, with manual refresh and no polling. Leaving Connect interrupts its request; request IDs also reject stale responses. A 401 clears the previous channel. Other refresh failures retain the last known status. Browser imports use only `@arctools/twitch/enrollment`, never its server barrel.

Website is one public Worker declared with `Cloudflare.Website.Foldkit`. It owns OAuth and enrollment HTTP, calling Bot over its typed private service binding. `entry.server.ts` returns native `Server.Responded` values for the three browser endpoints before rendering pages. `server/enrollment.ts` retains cookie, query, deadline, and response policy. `server/bot.ts` imports `cloudflare:workers` lazily. Bot retains secrets, account policy, and storage. Resource imports used only for types stay type-only.

HTTPS uses the Secure HttpOnly `__Host-arctools-enrollment` cookie. Exact `http://localhost:3000` uses a separate local HttpOnly cookie without Secure. Neither policy reads the other cookie. Start enrollment with full navigation to `/oauth/twitch/enroll`. The status Command uses same-origin credentials, no-store caching, and the browser's normal wildcard Accept header. Foldkit's native page host rejects JSON-only Accept requests before routing. HEAD must return 405 without creating an enrollment intent.

The native Foldkit plugin owns SSR, prerendering, documents, assets, and hydration identity. `entry.server.ts` prerenders `/` and `/connect`; both render public content without status calls or session Flags. Unknown pages return 404. Do not add a custom `main`, build-output mutation, generated-handler patch, or extra Website Worker. Standard Vite external declarations keep the lazy Cloudflare built-in out of standalone Node resolution.

`bun run dev:web` serves native Vite at http://localhost:3000 with a strict port and no host override. `bun run --cwd apps/website preview` previews generated static files. Both are visual previews. Native Foldkit SSR development runs in Node, including the currently documented Alchemy integration, and does not supply the Bot binding. A missing cookie returns 401; operations requiring the binding return a private 503. Full OAuth verification requires the generated Worker in a binding-capable runtime. Keep ARC_BOT_URL as the HTTPS webhook origin and ARC_WEBSITE_URL as the OAuth origin. Leave existing user Bot and tunnel processes alone.

Use Story tests for transitions and Commands, Scene tests for accessible UI behavior, and Node tests for server dispatch. Do not mock framework modules. After a production build, run `bun run --cwd apps/website verify:build` to inspect real prerendered HTML, Tailwind, fonts, and the browser/server boundary.

After code changes, run the repository root checks in order:

1. `bun run typecheck`
2. `bun run lint`
3. `bun run fmt`
4. `bun run test`
