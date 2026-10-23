import type { ReactNode } from "react";

export const wrap =
  "mx-auto w-[calc(100%-40px)] tablet:w-[calc(100%-56px)] desktop:w-[min(1184px,calc(100%-96px))]";

export const contentPage = `${wrap} min-h-[calc(100vh-195px)] max-w-[740px] py-[35px] pb-[55px] tablet:pt-[58px] tablet:pb-[85px]`;

export const pageTitle =
  "mt-[35px] mb-[23px] font-heading text-[clamp(36px,5vw,50px)] font-semibold leading-[1.15] tracking-[-2px]";

export const button =
  "inline-flex min-h-[49px] shrink-0 cursor-pointer whitespace-nowrap items-center justify-center gap-[26px] rounded-[5px] border border-transparent px-[21px] py-[13px] text-[13px] font-bold transition-[background,transform] duration-150 hover:-translate-y-px disabled:cursor-wait disabled:opacity-60";

export const primaryButton = `${button} bg-violet text-[#20182f] hover:bg-[#cdbbff]`;

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[10px] font-bold leading-[1.7] tracking-[1.8px] text-violet">
      {children}
    </p>
  );
}

export function ConnectLink({ className = "" }: { className?: string }) {
  return (
    <a href="/oauth/twitch/enroll" className={`${primaryButton} ${className}`}>
      Connect Twitch<span aria-hidden="true">↗</span>
    </a>
  );
}
