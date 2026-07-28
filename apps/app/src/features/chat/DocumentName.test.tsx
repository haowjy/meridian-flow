import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

const { navigation } = vi.hoisted(() => ({
  navigation: {
    open: null as ((uri: string) => void) | null,
    canOpen: null as ((uri: string) => boolean) | null,
  },
}));

vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => navigation.open,
  useChatContextRoutability: () => navigation.canOpen,
}));

const { DocumentName } = await import("./DocumentName");

function inProjectShell(canOpen: (uri: string) => boolean = () => true) {
  navigation.open = () => {};
  navigation.canOpen = canOpen;
}

function outsideProjectShell() {
  navigation.open = null;
  navigation.canOpen = null;
}

function render(path: string, props: { insideDoor?: boolean } = {}) {
  return renderToStaticMarkup(<DocumentName path={path} {...props} />);
}

describe("document names are doors", () => {
  it("renders a button when the shell can route to the document", () => {
    inProjectShell();

    const html = render("manuscript://chapter-1.md");

    expect(html).toContain("<button");
    expect(html).toContain("chapter-1");
    expect(html).toContain('aria-label="Open chapter-1"');
  });

  it("normalizes a bare write path before asking whether it can route", () => {
    const asked: string[] = [];
    inProjectShell((uri) => {
      asked.push(uri);
      return uri.startsWith("manuscript://");
    });

    // Most `write` input carries a bare path; without normalization the route
    // predicate rejects it and the row silently stops linking.
    expect(render("chapter-2.md")).toContain("<button");
    expect(asked).toEqual(["manuscript://chapter-2.md"]);
  });

  it("names the document and nothing else, wherever it lives", () => {
    inProjectShell();

    const html = render("kb://elara.md");

    // Where a document sits is not part of what a row claims; the door already
    // goes there.
    expect(html).toContain("elara");
    expect(html).not.toContain("Knowledge Base");
    expect(html).toContain('aria-label="Open elara"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("degradation is structural", () => {
  it("renders plain prose-toned text outside a project shell", () => {
    outsideProjectShell();

    const html = render("manuscript://chapter-1.md");

    expect(html).not.toContain("<button");
    expect(html).toContain("text-prose-foreground");
    // Muted with no underline reads as a disabled control; tone and decoration
    // move together.
    expect(html).not.toContain("text-muted-foreground");
    expect(html).not.toContain("underline");
  });

  it("renders plain text when the URI is not routable from here", () => {
    inProjectShell(() => false);

    expect(render("scratch://other-work/notes.md")).not.toContain("<button");
  });

  it("stays inert when an ancestor already carries the door", () => {
    inProjectShell();

    expect(render("manuscript://chapter-1.md", { insideDoor: true })).not.toContain("<button");
  });
});

describe("the resting handle", () => {
  it("carries a border-toned underline that goes jade on hover and focus", () => {
    inProjectShell();

    const html = render("manuscript://chapter-1.md");

    expect(html).toContain("underline");
    expect(html).toContain("decoration-border");
    expect(html).toContain("underline-offset-[3px]");
    expect(html).toContain("hover:text-jade-text");
    expect(html).toContain("focus-visible:text-jade-text");
  });
});
