#!/usr/bin/env node
// Enforce the documents/folders query boundary with a syntactic, per-file AST scan.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = "tools/ci/fixtures/tree-visibility";
const owner = "apps/server/server/domains/context/tree/";
const tables = new Set(["documents", "folders"]);
const reads = new Set(["from", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "crossJoin"]);
const writes = new Set(["insert", "update", "delete"]);
const kinds = {
  from: "read",
  query: "read",
  write: "write",
  "raw-read": "read",
  "raw-write": "write",
  escape: "read",
};

function scan(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const scopes = new Map();
  const aliases = [];
  const findings = [];
  const top = { parent: null, bindings: new Map(), functionScope: true };
  const declare = (name, scope, value = null) => {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, value);
    else if (ts.isBindingPattern(name)) {
      for (const element of name.elements)
        if (ts.isBindingElement(element)) declare(element.name, scope);
    }
  };
  // Predeclare locals so shadowing works even before a declaration's position.
  function bind(node, scope) {
    if (
      node !== source &&
      (ts.isFunctionLike(node) ||
        ts.isBlock(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isCaseBlock(node))
    ) {
      if (ts.isFunctionDeclaration(node) && node.name) declare(node.name, scope);
      scope = { parent: scope, bindings: new Map(), functionScope: ts.isFunctionLike(node) };
    }
    scopes.set(node, scope);
    if (ts.isImportDeclaration(node) && node.importClause) {
      const module = node.moduleSpecifier.text;
      const schema =
        module === "@meridian/database" ||
        module === "@meridian/database/schema" ||
        (module.startsWith(".") &&
          path.posix
            .normalize(path.posix.join(path.posix.dirname(file), module))
            .includes("packages/database/src/schema/"));
      const imports = node.importClause.namedBindings;
      if (node.importClause.name) declare(node.importClause.name, scope);
      if (imports && ts.isNamespaceImport(imports)) {
        declare(
          imports.name,
          scope,
          schema ? "schema" : module === "drizzle-orm" ? "drizzle" : null,
        );
      } else if (imports) {
        for (const spec of imports.elements) {
          const original = (spec.propertyName ?? spec.name).text;
          const value =
            schema && tables.has(original)
              ? original
              : module === "drizzle-orm" &&
                  ["sql", "getTableColumns", "getTableName"].includes(original)
                ? original
                : module.startsWith("drizzle-orm/") && original === "alias"
                  ? "alias"
                  : null;
          declare(spec.name, scope, value);
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      let declarationScope = scope;
      if (
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped)
      ) {
        while (!declarationScope.functionScope) declarationScope = declarationScope.parent;
      }
      declare(node.name, declarationScope);
      if (ts.isIdentifier(node.name) && node.initializer)
        aliases.push({ node, scope: declarationScope });
    }
    if (ts.isParameter(node)) declare(node.name, scope);
    if ((ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name)
      declare(node.name, scope);
    ts.forEachChild(node, (child) => bind(child, scope));
  }
  bind(source, top);
  function binding(node) {
    if (!node) return null;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return binding(node.expression);
    if (ts.isIdentifier(node)) {
      for (let scope = scopes.get(node); scope; scope = scope.parent) {
        if (scope.bindings.has(node.text)) return scope.bindings.get(node.text);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = binding(node.expression);
      if (base === "schema" && tables.has(node.name.text)) return node.name.text;
      if (base === "drizzle" && ["sql", "getTableColumns", "getTableName"].includes(node.name.text))
        return node.name.text;
    }
    return null;
  }
  // alias() is a declaration, not a table escape. Iterate for aliases of aliases.
  for (let pass = 0; pass < aliases.length; pass++) {
    let changed = false;
    for (const { node, scope } of aliases) {
      const init = node.initializer;
      if (
        ts.isCallExpression(init) &&
        binding(init.expression) === "alias" &&
        tables.has(binding(init.arguments[0]))
      ) {
        const value = binding(init.arguments[0]);
        if (scope.bindings.get(node.name.text) !== value) {
          scope.bindings.set(node.name.text, value);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  function report(node, rule) {
    if (rule === "hidden" && file.startsWith(owner)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    // A SQL interpolation can be both a hidden column reference and a hidden
    // SQL mention on the same line; report that boundary breach only once.
    if (rule !== "hidden" || !findings.some((hit) => hit.line === line && hit.rule === rule))
      findings.push({ file, line, rule });
  }
  function sqlText(template) {
    if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
    let result = template.head.text;
    for (const span of template.templateSpans) {
      const table = binding(span.expression);
      const column =
        ts.isPropertyAccessExpression(span.expression) && binding(span.expression.expression);
      result +=
        (tables.has(table)
          ? table
          : tables.has(column)
            ? `${column}.${span.expression.name.text}`
            : "?") + span.literal.text;
    }
    return result;
  }
  function checkSql(node, raw) {
    // Preserve line breaks, remove SQL comments and string literals (not identifier quotes).
    const sql = raw.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    const identifier = '(?:"(?:[^"\\n]|"")*"|[a-z_][\\w$]*)';
    const tableName = '(?:"(?:documents|folders)"|(?:documents|folders))';
    const qualifiedTable = `(?:${identifier}\\s*\\.\\s*)?${tableName}`;
    // A word boundary alone accepts prefixes inside quoted names. Require the
    // entire relation, including its optional schema, before classifying SQL.
    const relation = `${qualifiedTable}(?![\\w$".])`;
    if (new RegExp(`\\b(?:update|into|delete\\s+from)\\s+${relation}`, "i").test(sql))
      report(node, "raw-write");
    const withoutDelete = sql.replace(new RegExp(`\\bdelete\\s+from\\s+${relation}`, "gi"), " ");
    if (new RegExp(`\\b(?:from|join)\\s+${relation}`, "i").test(withoutDelete))
      report(node, "raw-read");
    // SQL may name a table through a column interpolation, without FROM/JOIN.
    const mention = new RegExp(`(?<![\\w$"])${qualifiedTable}(?![\\w$"])`, "i");
    if (mention.test(sql) && /\bhidden\b/i.test(sql)) report(node, "hidden");
  }
  function mutationTarget(node) {
    while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (writes.has(node.expression.name.text)) return binding(node.arguments[0]);
      node = node.expression.expression;
    }
    return null;
  }
  function visit(node) {
    // The entire type subtree is inert, including typeof table.$inferSelect.
    if (ts.isTypeNode(node)) return;
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "hidden" && tables.has(binding(node.expression)))
        report(node, "hidden");
      if (
        tables.has(node.name.text) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "query"
      )
        report(node, "query");
    }
    if (ts.isTaggedTemplateExpression(node) && binding(node.tag) === "sql")
      checkSql(node, sqlText(node.template));
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const target = binding(node.arguments[0]);
      const exempt = ["alias", "getTableColumns", "getTableName"].includes(binding(callee));
      if (tables.has(target) && !exempt) {
        if (reads.has(method)) report(node, "from");
        else if (writes.has(method)) report(node, "write");
      }
      for (const [index, argument] of node.arguments.entries()) {
        if (
          tables.has(binding(argument)) &&
          !exempt &&
          !(index === 0 && (reads.has(method) || writes.has(method)))
        )
          report(node, "escape");
      }
      if (
        method === "raw" &&
        binding(callee.expression) === "sql" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        checkSql(node, node.arguments[0].text);
      if (["values", "set"].includes(method) && tables.has(mutationTarget(callee.expression))) {
        function keys(child) {
          if (
            (ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) &&
            child.name.getText(source).replace(/["']/g, "") === "hidden"
          )
            report(child, "hidden");
          ts.forEachChild(child, keys);
        }
        for (const argument of node.arguments) keys(argument);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

function filesBelow(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (
      [
        "node_modules",
        "dist",
        ".output",
        ".nx",
        "migrations",
        "__conformance__",
        "test-support",
        "__test-support__",
      ].includes(entry.name)
    )
      return [];
    if (entry.isDirectory()) return filesBelow(file);
    return /\.(ts|tsx|mts|mjs)$/.test(file) && !/\.(?:db\.)?test\.ts$/.test(file) ? [file] : [];
  });
}
function read(file) {
  return readFileSync(path.join(root, file), "utf8");
}
function fail(errors) {
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
}

const fixtureFiles = filesBelow(fixtures);
if (!fixtureFiles.length) throw new Error("Tree-visibility fixtures are missing");
for (const file of fixtureFiles) {
  const text = read(file);
  const expected = text
    .split("\n")
    .flatMap((line, index) =>
      [...line.matchAll(/\/\/ expect: ([\w-]+)/g)].map((match) => `${index + 1}:${match[1]}`),
    )
    .sort();
  const actual = scan(file, text)
    .map((hit) => `${hit.line}:${hit.rule}`)
    .sort();
  fail(
    expected.join("\n") === actual.join("\n")
      ? []
      : [`Fixture ${file} failed: expected [${expected}], got [${actual}]`],
  );
}

const { entries } = JSON.parse(read("tools/ci/tree-visibility-allowlist.json"));
const paths = new Set();
for (const entry of entries) {
  if (
    !entry.path ||
    !Array.isArray(entry.forms) ||
    !entry.forms.length ||
    entry.forms.some((form) => !["read", "write"].includes(form)) ||
    !entry.reason?.trim()
  )
    throw new Error(`Invalid allowlist entry: ${JSON.stringify(entry)}`);
  if (paths.has(entry.path)) throw new Error(`Duplicate allowlist path: ${entry.path}`);
  paths.add(entry.path);
}
function matches(glob, file) {
  const pattern = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${pattern}$`).test(file);
}
const files = [
  "apps/server/server",
  "apps/server/scripts",
  "tools",
  ...readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `packages/${entry.name}/src`),
]
  .flatMap(filesBelow)
  .filter(
    (file) => !file.startsWith(`${fixtures}/`) && !file.startsWith("packages/database/src/schema/"),
  );
const used = new Set();
const errors = [];
let count = 0;
for (const file of files) {
  for (const hit of scan(file, read(file))) {
    count++;
    const covering = entries.filter(
      (entry) =>
        hit.rule !== "hidden" && matches(entry.path, file) && entry.forms.includes(kinds[hit.rule]),
    );
    for (const entry of covering) used.add(entry.path);
    if (!covering.length)
      errors.push(`${file}:${hit.line}: ${hit.rule} (uncovered tree-visibility violation)`);
  }
}
for (const entry of entries)
  if (!used.has(entry.path)) errors.push(`Stale allowlist entry: ${entry.path}`);
fail(errors);
console.log(
  `Tree-visibility guard passed: ${fixtureFiles.length} fixtures, ${files.length} files, ${count} allowlisted findings.`,
);
