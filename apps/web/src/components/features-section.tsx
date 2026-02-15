import { Calendar, Globe, Info, type LucideIcon } from "lucide-react"

interface Feature {
  icon: LucideIcon
  title: string
  description: string
}

const features: Feature[] = [
  {
    icon: Info,
    title: "Item Info",
    description: "Quick access to useful item sell value, crafting recipe, recycle components, and more."
  },
  {
    icon: Calendar,
    title: "Map Conditions",
    description: "Real-time map condition timers for keeping track of the currently active and upcoming conditions."
  },
  {
    icon: Globe,
    title: "Wide Platform Support",
    description: "Seamless integration with your Twitch streams and/or Discord servers with YouTube support coming soon!"
  }
]

export function FeaturesSection() {
  return (
    <section className="relative border-t border-border/50 bg-secondary/50 dark:bg-card/25 py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Features
          </p>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Everything you need to survive topside
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
            From items to maps, ArcTools will make sure you're always prepared for the next raid.
          </p>
        </div>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-xl border border-border/50 bg-card/50 p-6 transition-colors hover:border-primary/30 hover:bg-secondary/50"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/20">
                <feature.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
