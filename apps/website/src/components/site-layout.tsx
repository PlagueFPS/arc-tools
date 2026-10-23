import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { wrap } from "./controls";

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_83%_19%,#26212e66,transparent_43%)]">
      <a
        href="#main"
        className="absolute -top-[100px] left-5 z-10 bg-violet p-3 text-[#151517] focus:top-[15px]"
      >
        Skip to content
      </a>
      <header
        className={`${wrap} flex items-center justify-between border-b border-line py-[22px] tablet:py-8`}
      >
        <Link
          to="/"
          aria-label="ARC Tools home"
          className="flex items-center gap-2 font-heading text-[17px] font-bold tracking-[-0.6px] tablet:text-[21px] max-[380px]:gap-[5px]"
        >
          <span
            aria-hidden="true"
            className="mr-[5px] grid h-[29px] w-[26px] -skew-x-[9deg] place-items-center bg-violet text-[26px] text-[#17131f] tablet:h-[33px] tablet:w-[31px]"
          >
            A
          </span>
          ARC <span className="font-normal text-[#bdbac5]">TOOLS</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link
            to="/connect"
            activeOptions={{ exact: true }}
            activeProps={{ className: "text-violet" }}
            inactiveProps={{ className: "text-[#d2cfd8]" }}
            className="flex items-center gap-2 text-[11px] hover:text-violet tablet:gap-[21px] tablet:text-[13px]"
          >
            Connection status{" "}
            <span aria-hidden="true" className="max-[380px]:hidden">
              ↗
            </span>
          </Link>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer
        className={`${wrap} flex flex-wrap items-center gap-[14px] border-t border-line py-[25px] text-[11px] text-[#8e8996] tablet:gap-[25px] desktop:justify-between`}
      >
        <span className="font-heading text-xs font-semibold tracking-[1px] text-[#c5bfce]">
          ARC TOOLS
        </span>
        <p>Made for the raid. Built for your community.</p>
        <p className="w-full text-[9px] leading-[1.7] tablet:w-auto">
          An independent community tool. Not affiliated with Embark Studios or
          Twitch.
        </p>
      </footer>
    </div>
  );
}
