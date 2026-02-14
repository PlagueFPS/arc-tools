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
