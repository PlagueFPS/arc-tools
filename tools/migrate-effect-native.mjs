/* oxlint-disable effecttsgo/global-console -- This host boundary writes native CLI output or captures console output in tests. */
/* oxlint-disable effecttsgo/node-builtin-import -- The host adapter uses Node filesystem, path, or process APIs before an Effect runtime is available. */
/* oxlint-disable effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string -- Source rewriting uses native AST arrays and UTF-16 string offsets without loading the application runtime. */
// Usage: bun tools/migrate-effect-native.mjs <oxlint --format json output>
// Add --effects for generator operations or --json for JSON codecs; regenerate diagnostics for each pass.
// Only rewrites calls identified by Effect's type-aware native API diagnostics.
import fs from "node:fs";

import { ts } from "ts-morph";

const diagnostics = JSON.parse(
  fs.readFileSync(process.argv[2], "utf8"),
).diagnostics.filter(
  (diagnostic) => diagnostic.filename !== "tools/migrate-effect-native.mjs",
);

const effectMode = process.argv.includes("--effects");

const jsonMode = process.argv.includes("--json");

const groups = Map.groupBy(
  diagnostics.filter((d) =>
    jsonMode
      ? d.code === "effecttsgo(prefer-schema-over-json)"
      : effectMode
        ? [
            "effecttsgo(schema-sync-in-effect)",
            "effecttsgo(crypto-random-uuid-in-effect)",
            "effecttsgo(global-console-in-effect)",
          ].includes(d.code) ||
          (d.code === "effecttsgo(global-date-in-effect)" &&
            d.filename.startsWith("apps/") &&
            !d.filename.includes("/test/"))
        : /effecttsgo\(prefer-effect-(array|string|record)\)/.test(d.code),
  ),
  (d) => d.filename,
);

let count = 0;

for (const [filename, reports] of groups) {
  const source = fs.readFileSync(filename, "utf8");

  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  const calls = [];
  const aliases = new Map();
  let effectImport;

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    )
      calls.push(node);

    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === "effect"
    ) {
      const bindings = node.importClause?.namedBindings;

      if (bindings && ts.isNamedImports(bindings)) {
        effectImport = bindings;

        for (const specifier of bindings.elements) {
          aliases.set(
            specifier.propertyName?.text ?? specifier.name.text,
            specifier.name.text,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(ast);
  const added = new Map();
  let needsUUID = false;

  function moduleName(name) {
    if (aliases.has(name)) return aliases.get(name);

    if (added.has(name)) return added.get(name);
    const alias = `Effect${name}`;

    if (new RegExp(`\\b${alias}\\b`).test(source))
      throw new Error(`Alias collision in ${filename}: ${alias}`);
    added.set(name, alias);

    return alias;
  }

  const edits = [];

  for (const report of reports) {
    const span = report.labels[0].span;

    // Oxlint offsets are UTF-8 bytes; the TypeScript AST uses UTF-16 offsets.
    const offset = Buffer.from(source)
      .subarray(0, span.offset)
      .toString().length;

    const call = calls
      .filter(
        (n) =>
          !!(n.expression.getStart(ast) <= offset && offset < n.expression.end),
      )
      .sort((a, b) => a.end - a.pos - (b.end - b.pos))[0];

    if (!call || edits.some((e) => !!(e.node === call))) continue;

    const label = Buffer.from(source)
      .subarray(span.offset, span.offset + span.length)
      .toString();

    if (!label.includes(call.expression.name.text))
      throw new Error(
        `Stale diagnostics for ${filename}; regenerate oxlint JSON before migrating.`,
      );

    if ((jsonMode || effectMode) && call.flags & ts.NodeFlags.OptionalChain)
      continue;

    if (
      call.flags & ts.NodeFlags.OptionalChain &&
      (ts.isElementAccessExpression(call.parent) ||
        ts.isPropertyAccessExpression(call.parent))
    )
      continue;

    if (jsonMode) {
      let owner = call.parent;

      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      const generator = !!owner?.asteriskToken;
      const schema = moduleName("Schema");

      const operation =
        call.expression.name.text === "stringify" ? "encode" : "decodeUnknown";

      if (
        operation === "encode" &&
        call.arguments[1] &&
        call.arguments[1].kind !== ts.SyntaxKind.NullKeyword
      )
        continue;
      edits.push({
        node: call,
        rewrite: () => {
          const codec = call.arguments[2]
            ? `${schema}.fromJsonString(${schema}.Unknown, { space: ${text(call.arguments[2])} })`
            : `${schema}.fromJsonString(${schema}.Unknown)`;

          const converted = `${schema}.${operation}${generator ? "Effect" : "Sync"}(${codec})(${call.arguments[0] ? text(call.arguments[0]) : "undefined"})`;

          return generator
            ? `(yield* ${converted}.pipe(${moduleName("Effect")}.orDie))`
            : converted;
        },
      });
      continue;
    }

    if (effectMode) {
      let owner = call.parent;

      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;

      if (!owner?.asteriskToken) continue;

      if (report.code === "effecttsgo(schema-sync-in-effect)") {
        const invocation = call.parent;

        if (!ts.isCallExpression(invocation) || invocation.expression !== call)
          continue;
        const method = call.expression.name.text.replace("Sync", "Effect");
        edits.push({
          node: invocation,
          rewrite: () =>
            `(yield* ${text(call.expression.expression)}.${method}(${call.arguments.map((arg) => text(arg)).join(", ")})(${invocation.arguments.map((arg) => text(arg)).join(", ")}))`,
        });
      } else if (report.code === "effecttsgo(global-console-in-effect)") {
        const console = moduleName("Console");
        edits.push({
          node: call,
          rewrite: () =>
            `(yield* ${console}.${call.expression.name.text}(${call.arguments.map((arg) => text(arg)).join(", ")}))`,
        });
      } else if (report.code === "effecttsgo(crypto-random-uuid-in-effect)") {
        needsUUID = true;
        edits.push({ node: call, rewrite: () => "(yield* secureRandomUUID)" });
      } else {
        const clock = moduleName("Clock");
        edits.push({
          node: call,
          rewrite: () => `(yield* ${clock}.currentTimeMillis)`,
        });
      }

      continue;
    }

    const target = report.message.match(
      /Consider effect\/(Array|String|Record)\.(\w+)/,
    );

    if (!target) continue;
    const [, module, method] = target;
    const nativeMethod = call.expression.name.text;

    if (
      module === "String" &&
      nativeMethod === "split" &&
      call.arguments.length > 1
    )
      continue;

    if (
      module === "String" &&
      ["replace", "replaceAll"].includes(nativeMethod) &&
      call.arguments[1] &&
      (ts.isArrowFunction(call.arguments[1]) ||
        ts.isFunctionExpression(call.arguments[1]))
    )
      continue;
    const edit = { node: call, module, method, nativeMethod };

    if (nativeMethod === "reduceRight" && call.arguments.length !== 2) continue;

    if (nativeMethod === "match" || nativeMethod === "indexOf") {
      moduleName("Option");
    }

    if (nativeMethod === "find") moduleName("Option");

    if (call.flags & ts.NodeFlags.OptionalChain) moduleName("Option");
    moduleName(module);
    edits.push(edit);
  }

  function renderRange(start, end, excluded) {
    const nested = edits.filter(
      (e) =>
        e !== excluded && e.node.getStart(ast) >= start && e.node.end <= end,
    );

    const roots = nested.filter(
      (e) =>
        !nested.some(
          (other) =>
            other !== e &&
            other.node.getStart(ast) <= e.node.getStart(ast) &&
            other.node.end >= e.node.end,
        ),
    );

    let value = source.slice(start, end);

    for (const edit of roots.sort(
      (a, b) => b.node.getStart(ast) - a.node.getStart(ast),
    )) {
      const from = edit.node.getStart(ast) - start;
      const to = edit.node.end - start;
      value = value.slice(0, from) + render(edit) + value.slice(to);
    }

    return value;
  }

  const text = (node, excluded) =>
    renderRange(node.getStart(ast), node.end, excluded);

  function render(edit) {
    if (edit.rewrite) return edit.rewrite();
    const { node, module, method, nativeMethod } = edit;
    const originalReceiver = text(node.expression.expression, edit);
    const optional = !!(node.flags & ts.NodeFlags.OptionalChain);
    const parameter = `effectNativeValue${edits.indexOf(edit)}`;

    if (optional && new RegExp(`\\b${parameter}\\b`).test(source))
      throw new Error(`Optional binding collision in ${filename}`);
    const receiver = optional ? parameter : originalReceiver;

    const args = node.arguments.map((arg) => {
      if (
        module === "Array" &&
        ["filter", "some", "every", "find"].includes(nativeMethod) &&
        ts.isArrowFunction(arg) &&
        !ts.isBlock(arg.body) &&
        !arg.type
      ) {
        return (
          source.slice(arg.getStart(ast), arg.body.getStart(ast)) +
          `!!(${text(arg.body, edit)})`
        );
      }

      return text(arg, edit);
    });

    const namespace = moduleName(module);
    let inputs = [receiver, ...args];

    if (nativeMethod === "join" && args.length === 0) inputs.push('","');

    if (module === "Record" || nativeMethod === "isArray") inputs = args;

    if (nativeMethod === "reduceRight") inputs = [receiver, args[1], args[0]];

    const curried =
      module === "String" &&
      !["toLowerCase", "toUpperCase", "trim", "split"].includes(method);

    const call = curried
      ? `${namespace}.${method}(${args.join(", ")})(${receiver})`
      : `${namespace}.${method}(${inputs.join(", ")})`;

    const wrapper = {
      find: "getOrUndefined",
      match: "getOrNull",
      indexOf: "getOrElse",
    }[nativeMethod];

    const fallback = nativeMethod === "indexOf" ? ", () => -1" : "";

    const result = wrapper
      ? `${moduleName("Option")}.${wrapper}(${call}${fallback})`
      : call;

    return optional
      ? `${moduleName("Option")}.getOrUndefined(${moduleName("Option")}.map(${moduleName("Option")}.fromNullishOr(${originalReceiver}), (${parameter}) => ${result}))`
      : result;
  }

  let output = renderRange(0, source.length);

  if (added.size) {
    const bindings = [...added]
      .map(([name, alias]) => `${name} as ${alias}`)
      .join(", ");

    if (effectImport) {
      const original = effectImport.elements.map((element) =>
        element.getText(ast),
      );

      // Imports precede every rewritten call, so their offsets remain unchanged.
      output =
        output.slice(0, effectImport.getStart(ast)) +
        `{ ${[...original, bindings].join(", ")} }` +
        output.slice(effectImport.end);
    } else {
      output = `import { ${bindings} } from "effect";\n${output}`;
    }
  }

  if (needsUUID)
    output = `import { randomUUID as secureRandomUUID } from "@arctools/utils/http";\n${output}`;

  if (edits.length) {
    fs.writeFileSync(filename, output);
    count += edits.length;
  }
}

console.log(`Migrated ${count} native API calls in ${groups.size} files.`);
