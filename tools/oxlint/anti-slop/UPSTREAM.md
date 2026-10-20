# Anti-slop provenance

Source: https://github.com/PlagueFPS/skills

Source commit: `861ea047c194c2634a9b07dc8970c3d1e14f1e20`

Copied from `install-anti-slop/assets/anti-slop/` using the source repository's
`install-anti-slop/scripts/install.mjs`. The source asset directory was clean at
installation, and the copied assets match that commit byte for byte.

Installed entry points:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/effect/index.ts`

Intentional deviations: this provenance file was added; plugin source is unchanged.
The nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` are preserved.

Both plugins are enabled at error severity in the root `oxlint.config.ts`, along
with `oxc/no-accumulating-spread`. `@oxlint/plugins` is pinned to `1.88.0`, matching
Oxlint. The vendored plugin and local agent assets are excluded from linting and
formatting.

The Effect service import rule covers relative project imports; package-alias
imports are not currently enforced.
