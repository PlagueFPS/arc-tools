import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { ComponentExample } from "@/components/component-example";
import { ThemeToggle, ThemeToggleFallback } from "@/components/theme-toggle";

export const Route = createFileRoute("/")({ component: App });

function App() {
return (
  <div>
    <ClientOnly fallback={<ThemeToggleFallback />}>
      <ThemeToggle />
    </ClientOnly>
    <ComponentExample />
  </div>
);
}