/** Static user-turn projection: original ranges, never label matches, grant authority.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - source-range projection and renderer precedence
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Markdown } from "./Markdown";
import {
  boundedRanges,
  type MarkdownReferenceOccurrence,
  type MarkdownSkillOccurrence,
} from "./reference-occurrences";

const skill = (from: number, to = from + 8): MarkdownSkillOccurrence => ({
  from,
  to,
  slug: "outline",
  name: "Outline",
  description: "Plan chapters",
});
const reference = (from: number, to: number): MarkdownReferenceOccurrence => ({
  from,
  to,
  kind: "document",
  documentId: "chapter-id",
  uri: "manuscript://chapter.md",
});
const render = (
  source: string,
  references: MarkdownReferenceOccurrence[] = [],
  skills: MarkdownSkillOccurrence[] = [],
) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Markdown
        breaks
        references={references}
        skills={skills}
        referenceResolutions={
          new Map([
            ["document:chapter-id", { kind: "document", id: "chapter-id", available: false }],
          ])
        }
      >
        {source}
      </Markdown>
    </TooltipProvider>,
  );

describe("source-authoritative transcript projection", () => {
  it("keeps boundedRanges rejection and ordering semantics", () => {
    expect(
      boundedRanges(
        [
          { from: -1, to: 2 },
          { from: 2, to: 4 },
          { from: 3, to: 5 },
          { from: 6, to: 6 },
          { from: 7, to: 9 },
          { from: 8.5, to: 9 },
          { from: 10, to: 20 },
        ],
        10,
      ),
    ).toEqual([
      { from: 2, to: 4 },
      { from: 7, to: 9 },
    ]);
  });
  it("uses only an exact full-link range for reference identity", () => {
    const source = "[**Chapter**](manuscript://chapter.md)";
    const html = render(source, [reference(0, source.length)]);
    expect(html).toContain('data-link-chip="dashed"');
    expect(html).toContain("<strong>Chapter</strong>");
    expect(render(source, [reference(1, source.length)])).toContain('data-link-chip="filled"');
    expect(render("Chapter", [reference(0, 7)])).not.toContain("data-link-chip");
    expect(render("[[Chapter]]", [reference(0, 11)])).not.toContain("data-link-chip");
    // A literal URI has no parsed link run, and therefore no identity.
    expect(render("manuscript://chapter.md", [reference(0, 23)])).not.toContain("data-link-chip");
  });
  it("preserves syntax links without granting submitted identity", () => {
    expect(render("[Chapter](manuscript://chapter.md)")).toContain('data-link-chip="filled"');
    expect(render("[web](https://example.com)")).toContain('target="_blank"');
  });
  it("projects exact skill tokens through escapes, entities, and user line breaks", () => {
    const source = "\\* &amp; /outline\nnext";
    const html = render(source, [], [skill(source.indexOf("/outline"))]);
    expect(html).toContain('data-composer-skill=""');
    expect(html).toContain("* &amp; ");
    expect(html).toContain("<br/>next");
    expect(render("**intro**__/outline__", [], [skill(11)])).toContain("data-composer-skill");
    expect(render("/outline /outline", [], [skill(9)]).match(/data-composer-skill/g)).toHaveLength(
      1,
    );
  });
  it("keeps code, cross-run tokens, incorrect slugs, tables and invalid ranges plain", () => {
    for (const [source, from] of [
      ["`/outline`", 1],
      ["```\n/outline\n```", 4],
      ["/out**line**", 0],
      ["/another", 0],
      ["| A |\n| --- |\n| /outline |", 16],
    ] as const) {
      expect(render(source, [], [skill(from)])).not.toContain("data-composer-skill");
    }
    expect(render("/outline", [], [skill(-1)])).not.toContain("data-composer-skill");
    expect(render("/outline", [], [skill(0, 7)])).not.toContain("data-composer-skill");
  });
  it("keeps an exact reference label intact instead of nesting a skill control", () => {
    const source = "[/outline](manuscript://chapter.md)";
    const html = render(source, [reference(0, source.length)], [skill(1)]);
    expect(html).toContain('data-link-chip="dashed"');
    expect(html).not.toContain("data-composer-skill");
  });
  it("does not keep an enclosing link around an authorized skill", () => {
    const source = "[/outline](https://example.com)";
    const html = render(source, [], [skill(1)]);
    expect(html).toContain("data-composer-skill");
    expect(html).not.toContain("<a ");
  });
});

it("does not lose text when Markdown removes multiline container prefixes", () => {
  const source = "> first\n> /outline tail";
  const html = render(source, [], [skill(source.indexOf("/outline"))]);
  expect(html).toContain("first<br/>/outline tail");
  expect(html).not.toContain("data-composer-skill");
});

it("projects a token whose slash is escaped without dropping neighboring text", () => {
  const html = render("\\/outline tail", [], [skill(1)]);
  expect(html).toContain("<p><span");
  expect(html).toContain("/outline</span> tail</p>");
});
