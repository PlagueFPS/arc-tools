import { createFileRoute } from "@tanstack/react-router";
import { FeaturesSection } from "@/components/features-section";
import { Hero } from "@/components/hero";

export const Route = createFileRoute("/")({ component: App });

function App() {
  return (
    <main className="min-h-screen">
      <Hero />
      <div id="features">
        <FeaturesSection />
      </div>
      <div id="commands">

      </div>
    </main>
  );
}
