// @vitest-environment jsdom
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { Markdown } from "./Markdown";
import { TranscriptLinkNavigationContext } from "./TranscriptReference";

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

describe("transcript references", () => {
  it("activates only an exact stable-id and URI resolution", async () => {
    const open = vi.fn();
    const documentId = "33333333-3333-4333-8333-333333333333";
    await withReactRoot(
      <Markdown
        references={[{ from: 0, to: 12, documentId, uri: "uploads://@/gate-map.png" }]}
        referenceResolutions={
          new Map([
            [
              documentId,
              { documentId, uri: "uploads://@/gate-map.png", label: "Gate Map", available: true },
            ],
          ])
        }
        onOpenReference={open}
      >
        [[Gate Map]]
      </Markdown>,
      () => {
        const button = document.querySelector<HTMLElement>(
          '[role="link"]:not([aria-disabled="true"])',
        );
        expect(button?.textContent).toBe("Gate Map");
        button?.click();
        expect(open).toHaveBeenCalledWith(documentId);
      },
    );
  });
  it("renders a URI mismatch quietly as text", async () => {
    const documentId = "33333333-3333-4333-8333-333333333333";
    await withReactRoot(
      <Markdown
        references={[{ from: 0, to: 12, documentId, uri: "uploads://@/old.png" }]}
        referenceResolutions={
          new Map([
            [documentId, { documentId, uri: "uploads://@/new.png", label: "New", available: true }],
          ])
        }
      >
        [[Gate Map]]
      </Markdown>,
      () => {
        expect(
          document.querySelector<HTMLElement>('[role="link"]:not([aria-disabled="true"])'),
        ).toBeNull();
        expect(document.body.textContent).toContain("Gate Map");
      },
    );
  });
});

describe("model-authored wiki syntax", () => {
  it.each([
    "static",
    "streaming",
  ] as const)("renders recognized links without granting authority in %s mode", async (mode) => {
    await withReactRoot(
      <Markdown mode={mode}>
        {
          "[[Gate]] and [the tower]([[Tower]])\n\n`[[literal]]` and \\[\\[escaped]] and [[unfinished"
        }
      </Markdown>,
      () => {
        expect(document.body.textContent).toContain("Gate and the tower");
        expect(document.body.textContent).toContain("[[literal]]");
        expect(document.body.textContent).toContain("[[escaped]]");
        expect(document.body.textContent).toContain("[[unfinished");
        expect(document.querySelector('a[href^="[["]')).toBeNull();
        expect(document.querySelector('[role="link"]:not([aria-disabled="true"])')).toBeNull();
      },
    );
  });
});

describe("original source authority", () => {
  it.each([
    "static",
    "streaming",
  ] as const)("keeps source offsets through entities and fenced blocks in %s", async (mode) => {
    const uri = "uploads://@/gate.png";
    const source = `\`\`\`text\n[[code]]\n\`\`\`\n\n\nBefore &amp; then ${uri} after\n\n[[Gate]]`;
    const from = source.indexOf(uri);
    const wiki = source.lastIndexOf("[[Gate]]");
    const open = vi.fn();
    await withReactRoot(
      <Markdown
        mode={mode}
        references={[
          { from, to: from + uri.length, documentId: "one", uri },
          { from: wiki, to: source.length, documentId: "two", uri },
        ]}
        referenceResolutions={
          new Map([
            ["one", { documentId: "one", uri, label: "Map", available: true }],
            ["two", { documentId: "two", uri, label: "Gate", available: true }],
          ])
        }
        onOpenReference={open}
      >
        {source}
      </Markdown>,
      () => {
        expect(document.body.textContent).toContain("Before & then Map after");
        expect(document.querySelector("code")?.textContent).toContain("[[code]]");
        const links = document.querySelectorAll<HTMLElement>('[role="link"]');
        expect(links).toHaveLength(2);
        links[1]?.click();
        expect(open).toHaveBeenCalledWith("two");
        expect(document.querySelector('a [role="link"]')).toBeNull();
      },
    );
  });
  it("uses the latest authority for sequential same-text messages", async () => {
    for (const documentId of ["first", "second"]) {
      const open = vi.fn();
      await withReactRoot(
        <Markdown
          references={[{ from: 0, to: 8, documentId, uri: "manuscript://@/gate.md" }]}
          referenceResolutions={
            new Map([
              [
                documentId,
                { documentId, uri: "manuscript://@/gate.md", label: documentId, available: true },
              ],
            ])
          }
          onOpenReference={open}
        >
          {"[[Gate]]"}
        </Markdown>,
        () => {
          document.querySelector<HTMLElement>('[role="link"]')?.click();
          expect(open).toHaveBeenCalledWith(documentId);
        },
      );
    }
  });
  it("renders a canonical autolink as one readable control", async () => {
    const uri = "uploads://@/gate.png";
    const source = `<${uri}>`;
    await withReactRoot(
      <Markdown references={[{ from: 0, to: source.length, documentId: "one", uri }]}>
        {source}
      </Markdown>,
      () => {
        expect(document.body.textContent).toBe("gate.png");
        expect(document.querySelector("a")).toBeNull();
      },
    );
  });
});

it("updates same-text resolution and authority without a stale Streamdown closure", async () => {
  let update!: (state: { id: string; available: boolean }) => void;
  const open = vi.fn();
  const uri = "manuscript://@/gate.md";
  function Message() {
    const [state, setState] = useState({ id: "first", available: false });
    update = setState;
    return (
      <Markdown
        references={[{ from: 0, to: 8, documentId: state.id, uri }]}
        referenceResolutions={
          new Map([
            [state.id, { documentId: state.id, uri, label: state.id, available: state.available }],
          ])
        }
        onOpenReference={open}
      >
        {"[[Gate]]"}
      </Markdown>
    );
  }
  await withReactRoot(<Message />, async () => {
    expect(document.querySelector('[aria-disabled="true"]')).not.toBeNull();
    await act(async () => update({ id: "first", available: true }));
    document.querySelector<HTMLElement>('[role="link"]')?.click();
    expect(open).toHaveBeenLastCalledWith("first");
    await act(async () => update({ id: "second", available: true }));
    document.querySelector<HTMLElement>('[role="link"]')?.click();
    expect(open).toHaveBeenLastCalledWith("second");
  });
});

it("routes model-authored links through the scoped host and keeps context actions read-only", async () => {
  const navigate = vi.fn();
  await withReactRoot(
    <TranscriptLinkNavigationContext.Provider value={navigate}>
      <Markdown>{"[the gate]([[Gate]])"}</Markdown>
    </TranscriptLinkNavigationContext.Provider>,
    async () => {
      const link = document.querySelector<HTMLElement>('[role="link"]');
      expect(link?.textContent).toBe("the gate");
      await act(async () => link?.click());
      expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "wikilink", name: "Gate" });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await act(async () =>
        link?.dispatchEvent(
          new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
      );
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain("Open link");
      expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Remove");
    },
  );
});

it("keeps unavailable syntax keyboard-inspectable without navigation", async () => {
  await withReactRoot(<Markdown>{"[[Gate]]"}</Markdown>, async () => {
    const trigger = document.querySelector<HTMLElement>('[role="link"][aria-disabled="true"]');
    expect(trigger?.textContent).toBe("Gate");
    await act(async () =>
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ContextMenu",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("[[Gate]]");
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });
});

it.each([
  "static",
  "streaming",
] as const)("preserves alias prose when the destination resolves in %s", async (mode) => {
  const source = "[[Gate|the northern entrance]]";
  const uri = "manuscript://@/gate.md";
  const open = vi.fn();
  await withReactRoot(
    <Markdown
      mode={mode}
      references={[{ from: 0, to: source.length, documentId: "gate", uri }]}
      referenceResolutions={
        new Map([
          ["gate", { documentId: "gate", uri, label: "Renamed destination", available: true }],
        ])
      }
      onOpenReference={open}
    >
      {source}
    </Markdown>,
    () => {
      const link = document.querySelector<HTMLElement>('[role="link"]');
      expect(link?.textContent).toBe("the northern entrance");
      link?.click();
      expect(open).toHaveBeenCalledWith("gate");
    },
  );
});

it("preserves an explicitly authored label equal to its URI", async () => {
  const uri = "scratch://@revision/guide.md";
  const source = `[${uri}](${uri})`;
  await withReactRoot(
    <Markdown
      references={[{ from: 0, to: source.length, documentId: "guide", uri }]}
      referenceResolutions={
        new Map([
          ["guide", { documentId: "guide", uri, label: "Renamed destination", available: true }],
        ])
      }
    >
      {source}
    </Markdown>,
    () => {
      expect(document.querySelector('[role="link"]')?.textContent).toBe(uri);
    },
  );
});

it.each([
  "literal",
  "autolink",
])("uses resolved titles for a %s URI without an authored label", async (kind) => {
  const uri = "scratch://@revision/guide.md";
  const source = kind === "literal" ? uri : `<${uri}>`;
  await withReactRoot(
    <Markdown
      references={[{ from: 0, to: source.length, documentId: "guide", uri }]}
      referenceResolutions={
        new Map([["guide", { documentId: "guide", uri, label: "Resolved title", available: true }]])
      }
    >
      {source}
    </Markdown>,
    () => expect(document.querySelector('[role="link"]')?.textContent).toBe("Resolved title"),
  );
});
