import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  const handleThemeToggle = () => {
    if (!document.startViewTransition) {
      if (theme === "light") setTheme("dark");
      else setTheme("light");
      return;
    }

    document.startViewTransition(() => {
      if (theme === "light") setTheme("dark");
      else setTheme("light");
    });
  };

  return (
    <div className="flex w-fit p-0.5">
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="outline" size="icon" type="button" />}
          onClick={handleThemeToggle}
          aria-label="Toggle Theme; keyboard shortcut is T"
          className={cn("size-8 cursor-pointer", className)}
        >
          {theme === "dark" ? (
            <Sun className="size-4 transition-all" />
          ) : (
            <Moon className="size-4 transition-all" />
          )}
        </TooltipTrigger>
        <TooltipContent
          sideOffset={5}
          className="flex items-center justify-center gap-2"
        >
          <span>Toggle Theme</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function ThemeToggleFallback() {
  return (
    <div className="flex w-fit p-0.5">
      <Button
        variant="outline"
        size="icon"
        type="button"
        aria-label="Toggle Theme"
        title="Toggle Theme"
        disabled
        aria-disabled
        className="size-8 rounded-full border-none bg-transparent text-muted-foreground"
      >
        <Sun className="size-4 transition-all" />
      </Button>
    </div>
  );
}
