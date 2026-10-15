import { commands } from "@arctools/commands";
import { Schema } from "effect";
import { digest } from "./provider-http.js";

const locales = Schema.NullOr(Schema.Record(Schema.String, Schema.String));
const Option = Schema.Struct({
  type: Schema.Int,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  autocomplete: Schema.optional(Schema.Boolean),
  name_localizations: Schema.optional(locales),
  description_localizations: Schema.optional(locales),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        value: Schema.Union([Schema.String, Schema.Number]),
        name_localizations: Schema.optional(locales),
      }),
    ),
  ),
  min_length: Schema.optional(Schema.Number),
  max_length: Schema.optional(Schema.Number),
});
export const RemoteCommands = Schema.Array(
  Schema.Struct({
    type: Schema.optional(Schema.Int),
    name: Schema.String,
    description: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(Option)),
    integration_types: Schema.optional(Schema.Array(Schema.Int)),
    contexts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Int))),
    default_member_permissions: Schema.optional(Schema.NullOr(Schema.String)),
    nsfw: Schema.optional(Schema.Boolean),
    name_localizations: Schema.optional(locales),
    description_localizations: Schema.optional(locales),
  }),
);
export type RemoteCommands = typeof RemoteCommands.Type;
const localizations = (
  value: Readonly<Record<string, string>> | null | undefined,
) =>
  value && Object.keys(value).length
    ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      )
    : null;
export function normalizeManifest(input: RemoteCommands) {
  return input
    .map((command) => ({
      type: command.type ?? 1,
      name: command.name,
      description: command.description ?? "",
      name_localizations: localizations(command.name_localizations),
      description_localizations: localizations(
        command.description_localizations,
      ),
      options: (command.options ?? []).map((option) => ({
        type: option.type,
        name: option.name,
        description: option.description ?? "",
        required: option.required ?? false,
        autocomplete: option.autocomplete ?? false,
        name_localizations: localizations(option.name_localizations),
        description_localizations: localizations(
          option.description_localizations,
        ),
        choices: (option.choices ?? []).map((choice) => ({
          ...choice,
          name_localizations: localizations(choice.name_localizations),
        })),
        min_length: option.min_length ?? null,
        max_length: option.max_length ?? null,
      })),
      integration_types: [...(command.integration_types ?? [0])].sort(),
      contexts: [...(command.contexts ?? [0, 1, 2])].sort(),
      default_member_permissions: command.default_member_permissions ?? null,
      nsfw: command.nsfw ?? false,
    }))
    .sort((a, b) => a.type - b.type || a.name.localeCompare(b.name));
}
export const commandManifest = commands.map((command) => ({
  type: 1,
  name: command.name,
  description: command.description,
  integration_types: [0],
  contexts: [0],
  default_member_permissions: null,
  nsfw: false,
  name_localizations: null,
  description_localizations: null,
  options: command.slashOptions.map((option) => ({
    type: 3,
    name: option.name,
    description: option.description,
    required: option.required ?? false,
    autocomplete: false,
    choices: [],
    name_localizations: null,
    description_localizations: null,
  })),
})) satisfies RemoteCommands;
export const canonicalManifest = (input: RemoteCommands) =>
  JSON.stringify(normalizeManifest(input));
export const manifestHash = digest(canonicalManifest(commandManifest));
