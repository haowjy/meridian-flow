/**
 * Shared parser for the structured Changelog section in pull request bodies.
 */

export const CHANGELOG_HEADING = "## Changelog";
export const CHANGELOG_CATEGORIES = ["Added", "Changed", "Fixed", "Removed"];

const ENTRY = /^- (Added|Changed|Fixed|Removed): (\S(?:.*\S)?)$/;
const NONE = /^None\. (\S(?:.*\S)?)$/;
const PLACEHOLDER = /^<.*>$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function withoutComments(markdown) {
  return markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
}

/** Level-two sections outside fenced code blocks, with duplicate headings preserved. */
function scanSections(markdown) {
  const lines = withoutComments(markdown).split("\n");
  const headings = [];
  let fence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`);
      if (closing.test(line)) fence = undefined;
      continue;
    }

    const opening = FENCE_OPEN.exec(line);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }

    const text = line.trim();
    if (text.startsWith("## ")) headings.push({ text, index });
  }

  return headings.map(({ text, index }, headingIndex) => {
    const end = headings[headingIndex + 1]?.index ?? lines.length;
    return { heading: text, content: lines.slice(index + 1, end).join("\n") };
  });
}

/** Text under the first matching heading; fenced examples never count as sections. */
export function extractSection(markdown, heading) {
  return scanSections(markdown).find((section) => section.heading === heading)?.content ?? null;
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
    if (PLACEHOLDER.test(text)) {
      return {
        kind: "invalid",
        reason: "replace the template placeholder with what changed",
      };
    }
    entries.push({ category, text });
  }

  return { kind: "entries", entries };
}

export function parsePrChangelog(body) {
  const sections = scanSections(body).filter((section) => section.heading === CHANGELOG_HEADING);
  if (sections.length > 1) {
    return { kind: "invalid", reason: `duplicate ${CHANGELOG_HEADING} section` };
  }
  return parseChangelogSection(sections[0]?.content ?? null);
}
