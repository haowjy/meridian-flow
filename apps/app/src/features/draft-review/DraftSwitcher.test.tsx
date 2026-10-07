// @vitest-environment jsdom
/**
 * The switcher's phone menu: Apply draft, Discard draft and the marks switch
 * appear only when the header hands them over (the desktop header keeps them in
 * the row), and the trigger is a 44px target.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DockRow } from "@/features/chat/docked-drafts";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftSwitcher, type DraftSwitcherProps } from "./DraftSwitcher";

const row = (documentId: string, name: string, isNewDocument = false) =>
  ({
    documentId,
    documentName: name,
    contextPath: `/${name}.md`,
    isNewDocument,
    draft: { draftId: `d-${documentId}`, documentId, documentName: name, isNewDocument },
  }) as unknown as DockRow;

const props = (overrides: Partial<DraftSwitcherProps> = {}): DraftSwitcherProps => ({
  rows: [row("a", "Chapter 12"), row("b", "Chapter 13")],
  currentDocumentId: "a",
  counts: new Map([["a", 6]]),
  onOpenChange: vi.fn(),
  draftOnly: false,
  disabled: false,
  onOpenDraft: vi.fn(),
  onShowLive: vi.fn(),
  onApplyAll: vi.fn(),
  onDiscardAll: vi.fn(),
  ...overrides,
});

function render(p: DraftSwitcherProps, run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <DraftSwitcher {...p} />
    </I18nProvider>,
    run,
  );
}

const item = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find((node) =>
    node.textContent?.includes(text),
  );

async function open() {
  const trigger = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-trigger]");
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("DraftSwitcher on a phone", () => {
  it("offers no whole-draft commands unless handed them", async () => {
    await render(props(), async () => {
      await open();
      expect(item("Apply draft")).toBeUndefined();
      expect(item("Discard draft")).toBeUndefined();
      expect(item("Show live version")).toBeDefined();
      expect(item("Hide changes")).toBeUndefined();
    });
  });

  it("carries Apply draft, Discard draft, Show live version and the marks switch", async () => {
    const draftCommands = { canApply: true, applying: false, onApply: vi.fn(), onDiscard: vi.fn() };
    const onChange = vi.fn();
    await render(
      props({ touch: true, draftCommands, marks: { visible: true, onChange } }),
      async () => {
        expect(document.querySelector("[data-slot=dropdown-menu-trigger]")?.className).toContain(
          "min-h-11",
        );
        await open();
        await act(async () => item("Apply draft")?.click());
        expect(draftCommands.onApply).toHaveBeenCalledOnce();
      },
    );
    await render(
      props({ touch: true, draftCommands, marks: { visible: true, onChange } }),
      async () => {
        await open();
        await act(async () => item("Discard draft")?.click());
        expect(draftCommands.onDiscard).toHaveBeenCalledOnce();
      },
    );
    await render(
      props({ touch: true, draftCommands, marks: { visible: false, onChange } }),
      async () => {
        await open();
        await act(async () => item("Show changes")?.click());
        expect(onChange).toHaveBeenCalledWith(true);
      },
    );
  });

  it("disables Apply draft while a command is in flight or nothing can be applied", async () => {
    const draftCommands = {
      canApply: false,
      applying: false,
      onApply: vi.fn(),
      onDiscard: vi.fn(),
    };
    await render(props({ touch: true, draftCommands }), async () => {
      await open();
      expect(item("Apply draft")?.getAttribute("data-disabled")).not.toBeNull();
    });
    await render(
      props({ touch: true, disabled: true, draftCommands: { ...draftCommands, canApply: true } }),
      async () => {
        await open();
        expect(item("Discard draft")?.getAttribute("data-disabled")).not.toBeNull();
      },
    );
  });
});
