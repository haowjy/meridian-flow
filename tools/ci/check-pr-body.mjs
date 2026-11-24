import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_HEADING,
  extractSection,
  parsePrChangelog,
} from "./pr-changelog.mjs";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

const PRODUCT_FILE = /^(apps|packages)\/.+\.(ts|tsx|css|mjs|js)$/;
const TEST_FILE = /\.test\.|\/test-support\/|\/__tests__\/|\/__test-support__\//;

const NO_BROWSER_CLAIM = /browser:\s*none\b/i;
const IMAGE = /!\[[^\]]*\](?:\([^)]+\)|\[[^\]]+\])|<img\s/;

const template = readFileSync(TEMPLATE_PATH, "utf8");
const headings = template
  .split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.trim());

const scaffoldLines = new Set(
  template
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);

function hasAuthoredLine(content) {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line && !scaffoldLines.has(line));
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const bodyPath = args.find((arg) => arg !== "--strict");

function currentPrBody() {
  try {
    return execFileSync("gh", ["pr", "view", "--json", "body", "--jq", ".body"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const body = bodyPath ? readFileSync(bodyPath, "utf8") : currentPrBody();
if (body === null) {
  const reason =
    "no PR for this branch; start a draft from .github/PULL_REQUEST_TEMPLATE.md and check it with `pnpm check:pr-body <body.md>`";
  if (strict) {
    console.error(`check:pr-body: failed — ${reason}.`);
    process.exit(1);
  }
  console.log(`check:pr-body: skipped — ${reason}.`);
  process.exit(0);
}
const changedFileText = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
  encoding: "utf8",
});
const changedFiles = changedFileText
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const failures = [];
const changelogGuidance = `write one-line bullets starting ${CHANGELOG_CATEGORIES.map((category) => `- ${category}:`).join(", ")}`;

for (const heading of headings) {
  const content = extractSection(body, heading);
  if (heading === CHANGELOG_HEADING) {
    const parsed = parsePrChangelog(body);
    if (content === null || !hasAuthoredLine(content) || parsed.kind === "invalid") {
      const reason = parsed.kind === "invalid" ? ` (${parsed.reason})` : "";
      failures.push(
        `invalid ${CHANGELOG_HEADING}${reason}: ${changelogGuidance}; keep each entry on one ` +
          "line with at most 300 characters of text and no continuation lines, sub-bullets, or " +
          "other content; or write one line as None. <reason>",
      );
    }
  } else if (content === null) {
    failures.push(`missing section: ${heading}`);
  } else if (!hasAuthoredLine(content)) {
    failures.push(`section says nothing beyond the template scaffold: ${heading}`);
  }
}

const touchesProduct = changedFiles.some(
  (file) => PRODUCT_FILE.test(file) && !TEST_FILE.test(file),
);
if (touchesProduct && !IMAGE.test(body) && !NO_BROWSER_CLAIM.test(body)) {
  failures.push(
    "product sources changed but the body has no browser screenshot or GIF and no " +
      '"Browser: none" claim with its reason: verification is a browser run (AGENTS.md)',
  );
}

if (failures.length > 0) {
  console.error(`PR body does not follow ${TEMPLATE_PATH}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nAgents: gh pr create --body-file bypasses GitHub's template " +
      "auto-fill; copy the template's sections into the body file.",
  );
  process.exit(1);
}

console.log(`PR body carries all ${headings.length} template sections.`);
