import { ClientOnly, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { NAV_ROUTES } from "@/utils/nav-routes";
import { ThemeToggle, ThemeToggleFallback } from "./theme-toggle";

export function Header() {
  const discordAppLink = import.meta.env.VITE_DISCORD_APP_LINK;

  return (
    <div className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 container items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-tight text-foreground">
            ARCToolsBot
          </span>
        </Link>
        {/* Desktop Navigation */}
        <nav
          className="hidden items-center gap-8 md:flex"
          aria-label="Main navigation"
        >
          {NAV_ROUTES.map((route) => (
            <Link
              key={route.label}
              to={route.to}
              hash={route.hash}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {route.label}
            </Link>
          ))}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden md:flex items-center gap-2">
          <Button
            nativeButton={false}
            className="font-semibold rounded-lg text-background dark:text-foreground bg-discord-brand [a]:hover:bg-discord-brand/90 [a]:hover:dark:bg-discord-brand/80"
            render={
              <a
                href={discordAppLink}
                target="_blank"
                rel="noopener noreferrer"
              >
                Add to Discord
              </a>
            }
          />
          <ClientOnly fallback={<ThemeToggleFallback />}>
            <ThemeToggle />
          </ClientOnly>
        </div>
      </div>
    </div>
  );
}
