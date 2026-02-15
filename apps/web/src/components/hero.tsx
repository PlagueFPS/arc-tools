import { Link } from "@tanstack/react-router";
import { DiscordSVG } from "@/components/discord-svg";
import { Button } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Background glow effects */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-primary/10 blur-[120px]" />
        <div className="absolute right-0 top-1/3 h-[400px] w-[400px] rounded-full bg-accent/5 blur-[100px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-6 pb-24 pt-32 text-center">
        <h1 className="mx-auto max-w-3xl text-balance text-5xl font-bold tracking-tight text-foreground md:text-7xl">
          The <span className="text-primary">Ultimate</span> Resource Raiders
          Deserve
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground md:text-xl">
          Supercharge your Twitch streams and Discord server with powerful
          commands providing useful information and resources. All in one
          seamless bot.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button
            nativeButton={false}
            size="lg"
            className="h-12 rounded-lg px-8 text-base font-semibold bg-discord-brand"
            render={
              <a
                href={import.meta.env.VITE_DISCORD_APP_LINK}
                target="_blank"
                rel="noopener noreferrer"
              >
                <DiscordSVG />
                Add to Discord
              </a>
            }
          />
          <Button
            nativeButton={false}
            variant="outline"
            size="lg"
            className="h-12 rounded-lg border-border/50 px-8 text-base font-semibold text-foreground hover:bg-secondary"
            render={
              <Link to="/" hash="commands">
                View Commands
              </Link>
            }
          />
        </div>
      </div>
    </section>
  );
}
