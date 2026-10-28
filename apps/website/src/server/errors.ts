import { Schema } from "effect";

export class WebsiteUnavailable extends Schema.TaggedError<
  WebsiteUnavailable,
  { readonly brand: unique symbol }
>()("WebsiteUnavailable", {}) {}
