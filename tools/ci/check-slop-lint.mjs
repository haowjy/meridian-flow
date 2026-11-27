#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "@typescript/typescript6";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const BASELINE_PATH = resolve(ROOT, "tools/ci/slop-lint-baseline.json");
const CATEGORIES = [
  "swallowed-error",
  "suppression",
  "decision-id",
  "middle-dot",
  "row-note",
  "test-timing",
];
const CATEGORY_MESSAGES = {
  "test-timing":
    "Wait for the event itself or drive time with fake timers; real time varies by machine.",
  "swallowed-error": "Handle or surface the error instead of silently discarding it.",
  suppression: "Fix the type or lint error instead of adding a suppression.",
  "decision-id": "Delete the decision ID; explain the invariant in the comment instead.",
  "middle-dot":
    "Separate UI facts with spacing, weight or muted color; use a sentence or parentheses in text.",
  "row-note":
    "Pass the words as the row's `note` (or wrap them in LabelNote): a smaller text box centred in the row sits above the label's baseline.",
};
const ALLOW_PATTERN =
  /slop-lint:\s*allow\s+(swallowed-error|suppression|decision-id|middle-dot|row-note|test-timing)\s+(.+?)\s*$/i;
const ALLOW_MARKER = /slop-lint:\s*allow\b/i;
const SUPPRESSION_PATTERN = /\bbiome-ignore(?:-all)?\b|@ts-(?:ignore|expect-error|nocheck)\b/g;
const DECISION_PATTERN = /\b[DW]\d+\b/g;
const TEST_FILE_PATTERN = /\.test\.(ts|tsx)$/;
const SLEEP_HELPERS = new Set(["sleep", "delay", "wait"]);
const CLOCK_MATCHERS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
]);
const CLOCK_VALUE_NAME = /^(elapsed|duration|took)/i;

const args = new Set(process.argv.slice(2));
const updateBaseline = args.has("--update-baseline");

function fail(message) {
  console.error(`Slop-lint failed: ${message}`);
  process.exitCode = 1;
}

function relativePath(filePath) {
  return relative(ROOT, filePath).split(sep).join("/");
}

function isExcluded(filePath) {
  const path = filePath.split(sep).join("/");
  return (
    path.includes("/node_modules/") ||
    path.startsWith("node_modules/") ||
    path.includes("/dist/") ||
    path.includes("/build/") ||
    /(^|\/)(test|tests|__tests__|test-support|__fixtures__|fixtures|__conformance__)(\/|$)/.test(
      path,
    ) ||
    /\.(test|spec|type-test|typecheck)\.(ts|tsx)$/.test(path) ||
    /(?:\.gen|\.generated)\.(ts|tsx)$/.test(path)
  );
}

function trackedPaths() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.ts", "*.tsx"],
    { cwd: ROOT },
  ).toString();
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => resolve(ROOT, path));
}

function parseSource(filePath) {
  const text = readFileSync(filePath, "utf8");
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  return { lines: text.split("\n"), sourceFile, text };
}

function lineAt(lines, position) {
  return (lines[position] ?? "").replace(/\r$/, "");
}

function lineInfo(sourceFile, lines, position) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    lineNumber: location.line + 1,
    lineText: lineAt(lines, location.line).trim(),
  };
}

function addFinding(findings, sourceFile, lines, category, position, detail) {
  const info = lineInfo(sourceFile, lines, position);
  const path = relativePath(sourceFile.fileName);
  const key = `${path}\0${info.lineText}`;
  const existing = findings.get(key);
  if (existing) {
    existing.count += 1;
    existing.positions.push(info.lineNumber);
    return;
  }
  findings.set(key, {
    category,
    count: 1,
    detail,
    lineNumber: info.lineNumber,
    lineText: info.lineText,
    path,
    positions: [info.lineNumber],
  });
}

function unwrap(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isSwallowedExpression(expression) {
  const value = unwrap(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined") ||
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    (ts.isObjectLiteralExpression(value) && value.properties.length === 0)
  );
}

function collectSwallowedErrors(sourceFile, lines, findings) {
  function visit(node) {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      addFinding(
        findings,
        sourceFile,
        lines,
        "swallowed-error",
        node.getStart(sourceFile),
        "empty catch block",
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments.length === 1
    ) {
      const callback = node.arguments[0];
      if (
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        ((callback.body && !ts.isBlock(callback.body) && isSwallowedExpression(callback.body)) ||
          (ts.isBlock(callback.body) && callback.body.statements.length === 0))
      ) {
        addFinding(
          findings,
          sourceFile,
          lines,
          "swallowed-error",
          node.getStart(sourceFile),
          ".catch callback discards the rejection",
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// The raw scanner loses its place after a template with a substitution, so comments come from the parse tree, and JsxText is skipped because its words are text
function comments(sourceFile, text) {
  const byStart = new Map();
  const add = (pos, end) => {
    byStart.set(pos, { text: text.slice(pos, end), start: pos });
  };
  function visit(node) {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    if (node.getChildCount(sourceFile) === 0) {
      ts.forEachLeadingCommentRange(text, node.pos, add);
      ts.forEachTrailingCommentRange(text, node.end, add);
      return;
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  }
  visit(sourceFile);
  return [...byStart.values()];
}

function inBacktick(text, position) {
  let open = -1;
  for (let index = 0; index < position; index += 1) {
    if (text[index] !== "`") continue;
    if (open === -1) open = index;
    else open = -1;
  }
  return open !== -1;
}

function collectCommentFindings(sourceFile, text, lines, findings, directives) {
  for (const comment of comments(sourceFile, text)) {
    const allow = comment.text.match(ALLOW_PATTERN);
    if (allow || ALLOW_MARKER.test(comment.text)) {
      const info = lineInfo(sourceFile, lines, comment.start);
      directives.push({
        category: allow?.[1].toLowerCase() ?? "invalid",
        lineNumber: info.lineNumber,
        path: relativePath(sourceFile.fileName),
        reason: allow[2].trim(),
        used: false,
      });
    }

    for (const match of comment.text.matchAll(SUPPRESSION_PATTERN)) {
      addFinding(
        findings.get("suppression"),
        sourceFile,
        lines,
        "suppression",
        comment.start + match.index,
        `suppression ${match[0]}`,
      );
    }

    for (const match of comment.text.matchAll(DECISION_PATTERN)) {
      const absoluteMatch = comment.start + match.index;
      const preceding = text[absoluteMatch - 1];
      if (preceding === "@" || inBacktick(comment.text, match.index)) continue;
      addFinding(
        findings.get("decision-id"),
        sourceFile,
        lines,
        "decision-id",
        absoluteMatch,
        `decision ID ${match[0]}`,
      );
    }
  }
}

function stringText(node) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  ) {
    return node.text;
  }
  return null;
}

function collectMiddleDotFindings(sourceFile, lines, findings) {
  function visit(node) {
    const text = stringText(node);
    if (text?.includes("\u00b7")) {
      for (const match of text.matchAll(/\u00b7/g)) {
        addFinding(
          findings,
          sourceFile,
          lines,
          "middle-dot",
          node.getStart(sourceFile) + match.index,
          "middle dot used as a separator",
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const ROW_COMPONENTS = new Set([
  "DropdownMenuItem",
  "DropdownMenuCheckboxItem",
  "DropdownMenuRadioItem",
  "DropdownMenuSubTrigger",
  "ContextMenuItem",
  "ContextMenuSubTrigger",
  "SelectItem",
  "EditorMenuItem",
  "EditorMenuCheckboxItem",
  "EditorMenuRadioItem",
  "EditorMenuSubTrigger",
]);
const SMALL_TEXT = /\btext-xs\b|\brole\.rowSecondary\b|\btext-\[(?:length:)?[\d.]+(?:px|r?em)\]/;
const OWN_LINES = /\bflex-col\b|\bitems-baseline\b/;

function jsxClassName(element) {
  const attributes = ts.isJsxElement(element)
    ? element.openingElement.attributes
    : element.attributes;
  for (const attribute of attributes.properties) {
    if (ts.isJsxAttribute(attribute) && attribute.name.getText() === "className") {
      return attribute.initializer?.getText() ?? "";
    }
  }
  return "";
}

function jsxTag(element) {
  return (ts.isJsxElement(element) ? element.openingElement : element).tagName.getText();
}

function isJsx(node) {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function isRowElement(element) {
  return (
    ROW_COMPONENTS.has(jsxTag(element)) || jsxClassName(element).includes("dropdownRowVariants(")
  );
}

function suggestionRowContents(element) {
  if (jsxTag(element) !== "SuggestionMenu") return [];
  const contents = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "content"
    ) {
      contents.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  const rows = (
    ts.isJsxElement(element) ? element.openingElement : element
  ).attributes.properties.filter(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === "rows",
  );
  for (const attribute of rows) visit(attribute);
  return contents;
}

function collectRowNoteFindings(sourceFile, lines, findings) {
  function inRow(node) {
    if (isJsx(node)) {
      const className = jsxClassName(node);
      if (SMALL_TEXT.test(className)) {
        addFinding(
          findings,
          sourceFile,
          lines,
          "row-note",
          node.getStart(sourceFile),
          `small text <${jsxTag(node)}> beside a row's label`,
        );
      }
      if (OWN_LINES.test(className) || !ts.isJsxElement(node)) return;
      for (const child of node.children) inRow(child);
      return;
    }
    ts.forEachChild(node, inRow);
  }
  function visit(node) {
    if (isJsx(node)) {
      if (isRowElement(node)) {
        if (!OWN_LINES.test(jsxClassName(node)) && ts.isJsxElement(node)) {
          for (const child of node.children) inRow(child);
        }
      }
      for (const content of suggestionRowContents(node)) inRow(content);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function isPositiveLiteral(node) {
  return node !== undefined && ts.isNumericLiteral(node) && Number(node.text) > 0;
}

function resolvesPromise(callback) {
  if (ts.isIdentifier(callback) && /^(r|res)$/.test(callback.text)) return true;
  return /\bresolve\b/.test(callback.getText());
}

function readsClock(node) {
  if (ts.isIdentifier(node) && CLOCK_VALUE_NAME.test(node.text)) return true;
  const text = ts.isCallExpression(node) ? node.expression.getText() : "";
  if (text === "performance.now" || text === "Date.now") return true;
  return ts.forEachChild(node, readsClock) ?? false;
}

function clockAssertionValue(call) {
  const matcher = call.expression;
  if (!ts.isPropertyAccessExpression(matcher) || !CLOCK_MATCHERS.has(matcher.name.text)) {
    return undefined;
  }
  const expectation = matcher.expression;
  if (!ts.isCallExpression(expectation) || expectation.expression.getText() !== "expect") {
    return undefined;
  }
  return expectation.arguments[0];
}

function collectTestTimingFindings(sourceFile, text, lines, findings) {
  if (text.includes("useFakeTimers")) return;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : "";
      const [first, second] = node.arguments;
      const sleeps =
        (callee === "setTimeout" && isPositiveLiteral(second) && resolvesPromise(first)) ||
        (SLEEP_HELPERS.has(callee) && isPositiveLiteral(first));
      const clockValue = clockAssertionValue(node);
      if (sleeps) {
        addFinding(
          findings,
          sourceFile,
          lines,
          "test-timing",
          node.getStart(sourceFile),
          "test waits a fixed real time",
        );
      } else if (clockValue && readsClock(clockValue)) {
        addFinding(
          findings,
          sourceFile,
          lines,
          "test-timing",
          node.getStart(sourceFile),
          "test asserts on the wall clock",
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function collectTestTimingDirectives(sourceFile, lines, directives) {
  lines.forEach((line, index) => {
    const allow = line.match(ALLOW_PATTERN);
    if (allow?.[1].toLowerCase() !== "test-timing") return;
    directives.push({
      category: "test-timing",
      lineNumber: index + 1,
      path: relativePath(sourceFile.fileName),
      reason: allow[2].trim(),
      used: false,
    });
  });
}

function collectFindings() {
  const findings = new Map(CATEGORIES.map((category) => [category, new Map()]));
  const directives = [];
  const paths = trackedPaths();
  for (const filePath of paths.filter((path) => !isExcluded(path))) {
    const { lines, sourceFile, text } = parseSource(filePath);
    collectSwallowedErrors(sourceFile, lines, findings.get("swallowed-error"));
    collectCommentFindings(sourceFile, text, lines, findings, directives);
    collectMiddleDotFindings(sourceFile, lines, findings.get("middle-dot"));
    if (filePath.endsWith(".tsx"))
      collectRowNoteFindings(sourceFile, lines, findings.get("row-note"));
  }
  for (const filePath of paths.filter((path) => TEST_FILE_PATTERN.test(path))) {
    const { lines, sourceFile, text } = parseSource(filePath);
    collectTestTimingFindings(sourceFile, text, lines, findings.get("test-timing"));
    collectTestTimingDirectives(sourceFile, lines, directives);
  }

  for (const category of CATEGORIES) {
    for (const finding of findings.get(category).values()) {
      const directive = directives.find(
        (candidate) =>
          candidate.category === category &&
          candidate.path === finding.path &&
          !candidate.used &&
          candidate.reason &&
          category !== "middle-dot" &&
          candidate.lineNumber >= finding.lineNumber - 1 &&
          candidate.lineNumber <= finding.lineNumber,
      );
      if (directive) {
        directive.used = true;
        findings.get(category).delete(`${finding.path}\0${finding.lineText}`);
      }
    }
  }

  return { directives, findings };
}

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (parsed.version !== 1 || !parsed.categories || typeof parsed.categories !== "object") {
      throw new Error("expected version 1 and categories");
    }
    return parsed;
  } catch (error) {
    throw new Error(`cannot read ${relativePath(BASELINE_PATH)}: ${error.message}`);
  }
}

function baselineMaps(baseline) {
  return new Map(
    CATEGORIES.map((category) => {
      const entries = baseline.categories[category];
      if (!Array.isArray(entries)) {
        throw new Error(`baseline category ${category} must be an array`);
      }
      return [
        category,
        new Map(
          entries.map((entry) => {
            if (
              !entry ||
              typeof entry.path !== "string" ||
              typeof entry.line !== "string" ||
              !Number.isInteger(entry.count) ||
              entry.count < 1
            ) {
              throw new Error(`invalid ${category} baseline entry`);
            }
            return [`${entry.path}\0${entry.line}`, entry];
          }),
        ),
      ];
    }),
  );
}

function sortedEntries(findings) {
  return [...findings.values()]
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.lineText.localeCompare(right.lineText),
    )
    .map((finding) => ({ path: finding.path, line: finding.lineText, count: finding.count }));
}

function writeBaseline(findings) {
  const baseline = {
    version: 1,
    categories: Object.fromEntries(
      CATEGORIES.map((category) => [category, sortedEntries(findings.get(category))]),
    ),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

function main() {
  const { directives, findings } = collectFindings();
  let baseline;
  try {
    baseline = readBaseline();
  } catch (error) {
    if (updateBaseline && error.message.includes("ENOENT")) {
      writeBaseline(findings);
      console.log(`Slop-lint baseline created at ${relativePath(BASELINE_PATH)}.`);
      return;
    }
    throw error;
  }
  if (updateBaseline) {
    for (const category of CATEGORIES) {
      baseline.categories[category] ??= sortedEntries(findings.get(category));
    }
  }
  const allowed = baselineMaps(baseline);
  const newFindings = [];
  const staleFindings = [];

  for (const category of CATEGORIES) {
    const observed = findings.get(category);
    const known = allowed.get(category);
    for (const finding of observed.values()) {
      const baselineEntry = known.get(`${finding.path}\0${finding.lineText}`);
      const allowedCount = baselineEntry?.count ?? 0;
      if (finding.count > allowedCount) {
        newFindings.push({
          ...finding,
          count: finding.count - allowedCount,
          detail: `${finding.detail}; ${CATEGORY_MESSAGES[category]}`,
        });
      }
    }
    for (const entry of known.values()) {
      const current = observed.get(`${entry.path}\0${entry.line}`)?.count ?? 0;
      if (current < entry.count) staleFindings.push({ category, entry, current });
    }
  }

  const invalidDirectives = directives.filter((directive) => !directive.used);
  if (invalidDirectives.length > 0) {
    fail(
      "stale or malformed exceptions:\n" +
        invalidDirectives
          .map(
            (directive) =>
              `  ${directive.path}:${directive.lineNumber}: add a matching finding or delete the exception`,
          )
          .join("\n"),
    );
  }

  if (newFindings.length > 0) {
    fail(
      "new findings:\n" +
        newFindings
          .map(
            (finding) =>
              `  ${finding.path}:${finding.lineNumber} ${finding.lineText}\n    ${finding.detail}`,
          )
          .join("\n"),
    );
  }

  if (updateBaseline) {
    if (newFindings.length > 0) {
      fail(
        "baseline can only shrink; remove the finding or add a visible exception before refreshing",
      );
    } else {
      writeBaseline(findings);
      console.log(`Slop-lint baseline refreshed at ${relativePath(BASELINE_PATH)}.`);
    }
  } else if (staleFindings.length > 0) {
    fail(
      "baseline has removed findings; refresh it to record the reduction:\n" +
        staleFindings
          .map(({ category, entry }) => `  ${category}: ${entry.path}: ${entry.line}`)
          .join("\n"),
    );
  }

  if (process.exitCode) return;
  const counts = CATEGORIES.map((category) => {
    const count = [...findings.get(category).values()].reduce(
      (sum, finding) => sum + finding.count,
      0,
    );
    return `${category} ${count}`;
  }).join(", ");
  const exceptionCount = directives.filter((directive) => directive.used).length;
  console.log(`Slop-lint passed (${counts}; ${exceptionCount} visible exceptions).`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
