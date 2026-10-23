export function ChatPreview() {
  return (
    <section
      aria-label="Example Twitch chat"
      className="max-w-[500px] rounded-[9px] border border-[#49414f] bg-[#1e1c23] shadow-[0_28px_90px_#0005] tablet:max-w-none tablet:rotate-[1.5deg]"
    >
      <div className="flex items-center gap-[9px] border-b border-line p-5 text-[10px] font-bold tracking-[1.5px]">
        <span
          aria-hidden="true"
          className="size-[6px] rounded-full bg-[#e7ce9c]"
        />
        STREAM CHAT
        <span className="ml-auto rounded-[3px] border border-[#41394c] px-[5px] py-[3px] text-[8px] text-[#8c8599]">
          EXAMPLE
        </span>
      </div>
      <div className="px-[22px] pt-[25px] pb-[21px] tablet:pt-8 tablet:pb-[25px]">
        <ChatLine
          name="raider_01"
          avatar="bg-[#423532] text-[#dbbfae]"
          nameColor="text-[#cfb4a5]"
        >
          anyone know where to find sensors?
        </ChatLine>
        <ChatLine
          name="luna"
          avatar="bg-[#2c3935] text-[#b3cdb8]"
          nameColor="text-[#b3cdb8]"
        >
          !find sensors
        </ChatLine>
        <div className="-mx-[6px] rounded-[2px_5px_5px_2px] border-l-2 border-violet bg-[#30283d] px-[13px] pt-4">
          <ChatLine
            name="ARC Tools"
            avatar="bg-violet font-bold text-[#20182f]"
            nameColor="text-[#cdb4ff]"
          >
            Item locations, crafting info, sell values. One command away.
          </ChatLine>
        </div>
        <p className="pt-[6px] text-center text-[10px] text-[#97909f]">
          Ask in chat. Keep your eyes on the raid.
        </p>
      </div>
      <div
        aria-hidden="true"
        className="mx-[17px] mb-[18px] flex justify-between rounded border border-[#3a3541] px-3 py-[14px] text-[11px] text-[#8d8698]"
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
  nameColor,
}: {
  name: string;
  children: string;
  avatar: string;
  nameColor: string;
}) {
  return (
    <div className="mb-[25px] flex gap-3 text-xs leading-[1.8] text-[#d2cdd8]">
      <span
        aria-hidden="true"
        className={`size-7 shrink-0 rounded-[6px] text-center text-xs leading-7 ${avatar}`}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <div>
        <p className={`mb-[3px] text-[11px] font-bold ${nameColor}`}>{name}</p>
        <p>{children}</p>
      </div>
    </div>
  );
}
