export function createMockReply() {
  const calls: Array<{ content: string }> = [];
  const fn = (opts: { content: string }) => {
    calls.push(opts);
    return Promise.resolve();
  };
  return { calls, fn };
}

export function createMockMessage(overrides: {
  author?: { bot?: boolean };
  content?: string;
  reply: {
    calls: Array<{ content: string }>;
    fn: (opts: { content: string }) => Promise<unknown>;
  };
}) {
  const { reply, ...rest } = overrides;
  return {
    ...rest,
    author: { bot: false, ...overrides.author },
    content: overrides.content ?? "",
    reply: reply.fn,
  } as never;
}
