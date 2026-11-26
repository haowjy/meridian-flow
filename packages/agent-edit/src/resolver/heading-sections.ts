function slugForHeadingText(text: string): string {
  return (
    text
      .normalize("NFKD")
      .toLowerCase()
      .trim()
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

export function normalizeRequestedSlug(slug: string): string {
  return slug.toLowerCase().replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function headingSlugs(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return texts.map((text) => {
    const base = slugForHeadingText(text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  });
}

export function sectionEndIndex(
  count: number,
  headingIndex: number,
  levelAt: (index: number) => number | undefined,
): number {
  const level = levelAt(headingIndex) ?? 1;
  for (let index = headingIndex + 1; index < count; index += 1) {
    const next = levelAt(index);
    if (next !== undefined && next <= level) return index - 1;
  }
  return count - 1;
}

export function sectionNotFoundMessage(slug: string): string {
  return `Section "#${slug}" was not found.`;
}

interface MarkdownSection {
  heading: string;
  slug: string;
  start: number;
  end: number;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function markdownSections(markdown: string): {
  lines: string[];
  sections: MarkdownSection[];
} {
  const lines = markdown.split("\n");
  const headings: Array<{ index: number; level: number; text: string }> = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const opened = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opened?.[0] === fence[0] && opened.length >= fence.length) fence = null;
      return;
    }
    if (opened) {
      fence = opened;
      return;
    }
    const match = ATX_HEADING.exec(line);
    if (match?.[1]) headings.push({ index, level: match[1].length, text: match[2] ?? "" });
  });
  const levels = new Map(headings.map(({ index, level }) => [index, level]));
  const slugs = headingSlugs(headings.map(({ text }) => text));
  return {
    lines,
    sections: headings.map(({ index }, position) => ({
      heading: lines[index] as string,
      slug: slugs[position] as string,
      start: index,
      end: sectionEndIndex(lines.length, index, (line) => levels.get(line)) + 1,
    })),
  };
}
