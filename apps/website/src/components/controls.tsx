import type { ReactNode } from "react";

import { buttonVariants } from "./ui/button";

export const wrap =
  "mx-auto w-[calc(100%-40px)] tablet:w-[calc(100%-56px)] desktop:w-[min(1184px,calc(100%-96px))]";

export const contentPage = `${wrap} min-h-[calc(100vh-195px)] max-w-[740px] py-[35px] pb-[55px] tablet:pt-[58px] tablet:pb-[85px]`;

export const pageTitle =
  "mt-[35px] mb-[23px] font-heading text-[clamp(36px,5vw,50px)] font-semibold leading-[1.15] tracking-[-2px]";

export const primaryButton = buttonVariants({ size: "lg" });

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[10px] font-bold leading-[1.7] tracking-[1.8px] text-foreground">
      {children}
    </p>
  );
}

export function ConnectLink({ className = "" }: { className?: string }) {
  return (
    <a
      href="/oauth/twitch/enroll"
      className={buttonVariants({ size: "lg", className })}
    >
      Connect Twitch<span aria-hidden="true">↗</span>
    </a>
  );
}
