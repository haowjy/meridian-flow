/**
 * Shared parser for the structured Changelog section in pull request bodies.
 */

export const CHANGELOG_HEADING = "## Changelog";
export const CHANGELOG_CATEGORIES = ["Added", "Changed", "Fixed", "Removed"];

const ENTRY = /^- (Added|Changed|Fixed|Removed): (\S(?:.*\S)?)$/;
const NONE = /^None\. (\S(?:.*\S)?)$/;

function withoutComments(markdown) {
  return markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
}

/** Text between an exact level-two heading and the next level-two heading. */
export function extractSection(markdown, heading) {
  const lines = withoutComments(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

/** Parse already-extracted Changelog content without consulting the template. */
export function parseChangelogSection(content) {
  if (content === null) return { kind: "missing" };

  const lines = withoutComments(content)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.trimEnd());

  if (lines.length === 0) {
    return { kind: "invalid", reason: "the section is empty" };
  }

  const none = NONE.exec(lines[0]);
  if (none) {
    if (lines.length !== 1) {
      return { kind: "invalid", reason: "None. and its reason must be the only line" };
    }
    return { kind: "none", reason: none[1] };
  }
  if (lines[0] === "None." || lines[0].startsWith("None.")) {
    return { kind: "invalid", reason: "None. needs a non-empty reason on the same line" };
  }

  const entries = [];
  for (const line of lines) {
    const match = ENTRY.exec(line);
    if (!match) {
      return { kind: "invalid", reason: `invalid line: ${line}` };
    }
    const [, category, text] = match;
    if (Array.from(text).length > 300) {
      return { kind: "invalid", reason: `${category} entry text exceeds 300 characters` };
    }
    entries.push({ category, text });
  }

  return { kind: "entries", entries };
}

export function parsePrChangelog(body) {
  return parseChangelogSection(extractSection(body, CHANGELOG_HEADING));
}
