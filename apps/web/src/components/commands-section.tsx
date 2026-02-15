import { commands } from "@arctools/commands";

export function CommandsSection() {
  return (
    <section id="commands" className="relative py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Commands
          </p>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Powerful commands at your fingertips
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
            {commands.length} built-in commands to help you get the most out of ARC Raiders.
          </p>
        </div>

        {/* Command grid */}
        <div className="mt-10 grid gap-3 sm:grid-cols-2">
          {commands.map((cmd) => (
            <div
              key={cmd.name}
              className="group rounded-xl border border-border/50 bg-secondary/50 dark:bg-card/50 p-5 transition-colors hover:border-primary/20"
            >
              <div className="flex items-start justify-between gap-3">
                <code className="font-mono text-sm font-bold text-foreground">
                  !{cmd.name}
                </code>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {cmd.description}
              </p>
              <div className="mt-3 rounded-md bg-muted px-3 py-1.5">
                <code className="font-mono text-xs text-muted-foreground">
                  {cmd.usage}
                </code>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}