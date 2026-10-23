import { ChatPreview } from "./chat-preview";
import { ConnectLink, Eyebrow, wrap } from "./controls";

export function Landing() {
  return (
    <>
      <section
        className={`${wrap} grid items-center gap-[45px] py-12 tablet:grid-cols-[1.15fr_1fr] tablet:gap-[35px] tablet:py-[70px] desktop:gap-[72px] desktop:pt-[98px] desktop:pb-[88px]`}
      >
        <div>
          <Eyebrow>
            <span
              aria-hidden="true"
              className="size-[6px] rounded-full bg-primary"
            />
            BUILT FOR ARC RAIDERS · ON TWITCH
          </Eyebrow>
          <h1 className="my-[23px] font-heading text-[64px] leading-[1.05] font-semibold tracking-[-3px] tablet:text-[clamp(54px,6.2vw,86px)] desktop:tracking-[-5px] max-[380px]:text-[56px]">
            Your chat.
            <br />
            <span className="text-foreground">Raid ready.</span>
          </h1>
          <p className="max-w-[480px] text-base leading-[1.8] text-muted-foreground tablet:max-w-[430px]">
            Less alt-tabbing. More raiding. Give your community item, crafting,
            and event answers right in Twitch chat.
          </p>
          <div className="mt-[33px] flex flex-col items-start gap-[14px] desktop:flex-row desktop:items-center desktop:gap-[22px]">
            <ConnectLink />
            <p className="text-[10px] leading-[1.7] text-muted-foreground tablet:text-[11px]">
              Connect your channel through Twitch.
              <br />
              No downloads. No chat overlay.
            </p>
          </div>
          <div className="mt-9 flex items-center gap-[13px] text-[10px] text-muted-foreground tablet:items-start desktop:items-center">
            <code className="text-[11px] whitespace-nowrap text-foreground">
              !find sensors
            </code>
            <span>A little less searching. A lot more playing.</span>
          </div>
        </div>
        <ChatPreview />
      </section>
      <section
        aria-label="How ARC Tools works"
        className={`${wrap} border-t border-border pt-[35px] pb-[52px] tablet:pt-11`}
      >
        <Eyebrow>YOUR COMMUNITY'S FIELD GUIDE</Eyebrow>
        <h2 className="mt-2 font-heading text-[29px] tracking-[-1px]">
          Good intel. Zero detours.
        </h2>
        <div className="mt-[35px] grid gap-[27px] tablet:grid-cols-3 tablet:gap-[25px] desktop:gap-[50px]">
          <Capability number="01 / CONNECT" title="Your channel, connected.">
            Authorize your broadcaster account with Twitch. We check the channel
            connection before calling it ready.
          </Capability>
          <Capability number="02 / ASK" title="Let chat do the asking.">
            Find items, check what to craft, or see what's happening topside.
            Viewers use simple chat commands.
          </Capability>
          <Capability number="03 / RAID" title="Stay in the moment.">
            Answers land in chat, where the conversation already is. You keep
            playing. Everyone keeps up.
          </Capability>
        </div>
        <div className="mt-[35px] flex flex-wrap items-center gap-4 rounded-lg border border-border px-5 py-4 tablet:gap-[26px]">
          <span className="mr-auto w-full text-[9px] tracking-[1.5px] text-muted-foreground tablet:w-auto">
            IN YOUR CHAT
          </span>
          {["!find sensors", "!craft sensors", "!active"].map((command) => (
            <code key={command} className="text-[11px] text-foreground">
              {command}
            </code>
          ))}
        </div>
      </section>
    </>
  );
}

function Capability({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: string;
}) {
  return (
    <article>
      <p className="text-[9px] font-bold tracking-[1.8px] text-muted-foreground">
        {number}
      </p>
      <h3 className="my-2 font-heading text-[17px] font-medium tracking-[-0.4px] tablet:mt-[13px] tablet:mb-[10px]">
        {title}
      </h3>
      <p className="text-xs leading-[1.9] text-muted-foreground tablet:max-w-[300px]">
        {children}
      </p>
    </article>
  );
}
