/**
 * Parses the message parameters into a formatted string
 * @param params - The parameters to parse
 * @returns The formatted string
 */
export const parseMessageParams = (params: string[]) =>
  params
    .map((param) => param.trim())
    .filter(Boolean)
    .join(" ");

/**
 * Formats milliseconds as a human-readable duration string (e.g. "45m", "2h 30m")
 */
export const formatMinutes = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
};

/** Normalize for matching: lowercase, no spaces */
export const normalize = (s: string) => s.toLowerCase().replace(/\s/g, "");
