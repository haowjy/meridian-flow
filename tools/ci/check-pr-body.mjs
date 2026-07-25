/**
 * PR-body gate: every PR body must carry the sections of
 * .github/PULL_REQUEST_TEMPLATE.md, and UI-touching PRs must carry visual
 * evidence. The template is the single source — headings and scaffold lines
 * are read from it, so editing the template updates this gate without
 * touching this script.
 *
 * Structure is enforced here; truth is the reviewer's job. A section passes
 * when it contains at least one line the template didn't ship — pasting the
 * template unedited fails everywhere, and checkbox state is deliberately not
 * checked ("not applicable, because…" is a legitimate answer the template
 * invites).
 *
 * Usage: node tools/ci/check-pr-body.mjs <changed-files.txt> [body.md]
 *   PR_BODY — the body in CI (env, so attacker-controlled markdown never
 *             reaches the shell); the body.md argument is for checking a
 *             draft locally before `gh pr create`.
 */
import { readFileSync } from "node:fs";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

// Sources whose change obligates visual evidence: app/site UI and the design
// tokens every surface renders through. Tests change without changing pixels.
const UI_FILE = /^(apps\/(app|www)\/src\/.+\.(tsx|css)|packages\/design-tokens\/src\/.+)$/;
const TEST_FILE = /\.test\./;

// The escape hatch for UI-file diffs that change no pixels (pure refactors,
// type-only churn). Writing it is a reviewable claim, not a free pass.
const NO_VISUAL_CLAIM = /no visual change/i;
const IMAGE = /!\[[^\]]*\]\([^)]+\)|<img\s/;

const template = readFileSync(TEMPLATE_PATH, "utf8");
const headings = template
  .split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.trim());

// Every non-empty template line, comments stripped: the scaffold an author
// starts from. A body line only counts as authored if it isn't one of these.
const scaffoldLines = new Set(
  template
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);

/** Section content by heading: text between one `## ` heading and the next. */
function sectionContent(body, heading) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

function hasAuthoredLine(content) {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line && !scaffoldLines.has(line));
}

if (!process.argv[2] || (process.env.PR_BODY === undefined && !process.argv[3])) {
  console.error("usage: node tools/ci/check-pr-body.mjs <changed-files.txt> [body.md]");
  console.error("       (PR_BODY env replaces body.md in CI)");
  process.exit(1);
}

const body = process.env.PR_BODY ?? readFileSync(process.argv[3], "utf8");
// Trimmed like the body lines: a CRLF or copy-pasted entry must not slip past
// the anchored UI_FILE match and silently skip the visual-evidence rule.
const changedFiles = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const failures = [];

for (const heading of headings) {
  const content = sectionContent(body, heading);
  if (content === null) {
    failures.push(`missing section: ${heading}`);
  } else if (!hasAuthoredLine(content)) {
    failures.push(`section says nothing beyond the template scaffold: ${heading}`);
  }
}

const touchesUi = changedFiles.some((file) => UI_FILE.test(file) && !TEST_FILE.test(file));
if (touchesUi && !IMAGE.test(body) && !NO_VISUAL_CLAIM.test(body)) {
  failures.push(
    "UI sources changed but the body has no screenshot/GIF and no explicit " +
      '"no visual change" claim — the merge gate is visual',
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
