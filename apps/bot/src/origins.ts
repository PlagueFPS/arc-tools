export const httpsOrigin = (value: string) => {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Expected an HTTPS public origin");

  return url.origin;
};

export function publicOrigin(
  stage: string,
  actual: string,
  configured: string,
) {
  if (stage.startsWith("local-")) return httpsOrigin(configured);
  const origin = httpsOrigin(actual);

  if (configured && httpsOrigin(configured) !== origin)
    throw new Error("ARC_PUBLIC_URL must match the deployed Worker origin");

  return origin;
}

export function websiteOrigin(
  stage: string,
  actual: string,
  configured: string,
) {
  const origin = httpsOrigin(configured);

  if (!stage.startsWith("local-") && httpsOrigin(actual) !== origin)
    throw new Error("ARC_WEBSITE_URL must match the deployed Website origin");

  return origin;
}
