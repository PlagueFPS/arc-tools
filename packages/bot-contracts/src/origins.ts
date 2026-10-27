import { String as EffectString } from "effect";

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

export function botOrigin(stage: string, actual: string, configured: string) {
  if (EffectString.startsWith("local-")(stage)) return httpsOrigin(configured);
  const url = new URL(actual);

  const localTest =
    EffectString.startsWith("test-")(stage) &&
    url.protocol === "http:" &&
    url.hostname === "localhost" &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash;

  if (localTest) return httpsOrigin(configured);
  const origin = httpsOrigin(actual);

  if (configured && httpsOrigin(configured) !== origin)
    throw new Error("ARC_BOT_URL must match the deployed Worker origin");

  return origin;
}

export const localWebsiteOrigin = "http://localhost:3000";

export function websiteOAuthOrigin(stage: string, configured: string) {
  if (stage !== "prod" && configured === localWebsiteOrigin) return configured;

  return httpsOrigin(configured);
}

export function websiteOrigin(
  stage: string,
  actual: string,
  configured: string,
) {
  const origin = websiteOAuthOrigin(stage, configured);

  if (stage === "prod" && httpsOrigin(actual) !== origin)
    throw new Error("ARC_WEBSITE_URL must match the deployed Website origin");

  return origin;
}
