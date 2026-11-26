export type SourceRange = { from: number; to: number };
export type Frontmatter = SourceRange & {
  kind: "frontmatter";
  text: string;
};
export type FrontmatterSplit = {
  frontmatter: Frontmatter | null;
  body: string;
};

export function splitFrontmatter(source: string): FrontmatterSplit {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(source);
  if (!opening) return { frontmatter: null, body: source };
  const closing = /^---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(source);
  if (!end) return { frontmatter: null, body: source };
  const to = end.index + end[0].length;
  return {
    frontmatter: {
      kind: "frontmatter",
      from: 0,
      to,
      text: source.slice(opening[0].length, end.index),
    },
    body: source.slice(to),
  };
}
