export function ChatPreview() {
  return (
    <section
      aria-label="Example Twitch chat"
      className="max-w-[500px] rounded-xl border border-border bg-card shadow-lg tablet:max-w-none tablet:rotate-[1.5deg]"
    >
      <div className="flex items-center gap-[9px] border-b border-border p-5 text-[10px] font-bold tracking-[1.5px]">
        <span
          aria-hidden="true"
          className="size-[6px] rounded-full bg-primary"
        />
        STREAM CHAT
        <span className="ml-auto rounded-sm border border-border px-[5px] py-[3px] text-[8px] text-muted-foreground">
          EXAMPLE
        </span>
      </div>
      <div className="px-[22px] pt-[25px] pb-[21px] tablet:pt-8 tablet:pb-[25px]">
        <ChatLine name="raider_01" avatar="bg-muted text-foreground">
          anyone know where to find sensors?
        </ChatLine>
        <ChatLine name="luna" avatar="bg-secondary text-secondary-foreground">
          !find sensors
        </ChatLine>
        <div className="-mx-[6px] rounded-md border-l-2 border-primary bg-muted px-[13px] pt-4">
          <ChatLine
            name="ARC Tools"
            avatar="bg-primary font-bold text-primary-foreground"
          >
            Item locations, crafting info, sell values. One command away.
          </ChatLine>
        </div>
        <p className="pt-[6px] text-center text-[10px] text-muted-foreground">
          Ask in chat. Keep your eyes on the raid.
        </p>
      </div>
      <div
        aria-hidden="true"
        className="mx-[17px] mb-[18px] flex justify-between rounded border border-border px-3 py-[14px] text-[11px] text-muted-foreground"
      >
        Send a message <span>↵</span>
      </div>
    </section>
  );
}

function ChatLine({
  name,
  children,
  avatar,
}: {
  name: string;
  children: string;
  avatar: string;
}) {
  return (
    <div className="mb-[25px] flex gap-3 text-xs leading-[1.8] text-card-foreground">
      <span
        aria-hidden="true"
        className={`size-7 shrink-0 rounded-md text-center text-xs leading-7 ${avatar}`}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <div>
        <p className="mb-[3px] text-[11px] font-bold text-foreground">{name}</p>
        <p>{children}</p>
      </div>
    </div>
  );
}
