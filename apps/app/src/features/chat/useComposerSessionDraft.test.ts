// @vitest-environment jsdom
/** Tab/account isolation, lossless reload and the journal hand-off boundary. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { ComposerSessionDraft, useComposerSessionDraft } from "./useComposerSessionDraft";

const account = "01900000-0000-7000-8000-000000000002";
const scope = { kind: "chat", id: "chat-1" } as const;
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function change(text: string) {
  return { text, snapshot: serializeComposerDraft(plainComposerDoc(text)).draft };
}
afterEach(() => vi.useRealTimers());

describe("session composer drafts", () => {
  it("debounces writes, flushes the latest structured snapshot, and isolates accounts, destinations and tabs", () => {
    vi.useFakeTimers();
    const tab = storage();
    const owner = new ComposerSessionDraft(account, scope, () => tab);
    const write = vi.spyOn(tab, "setItem");
    owner.updateDraft(change("old"));
    const doc = plainComposerDoc("Compare ");
    doc.content?.[0]?.content?.push({
      type: "composerReference",
      attrs: {
        reference: {
          documentId: "01900000-0000-7000-8000-000000000001",
          uri: "manuscript://chapter.md",
          authority: { kind: "project", projectId: account },
          fileType: "markdown",
          label: "chapter.md",
          imageCapable: false,
          upload: null,
        },
      },
    });
    doc.content?.[0]?.content?.push({
      type: "composerUpload",
      attrs: {
        upload: { intakeId: "pending", name: "pending.png", state: "pending", error: null },
      },
    });
    const submitted = serializeComposerDraft(doc, 7);
    owner.updateDraft({ text: submitted.text, snapshot: submitted.draft });
    expect(write).not.toHaveBeenCalled();
    owner.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(write).toHaveBeenCalledTimes(1);
    const restored = new ComposerSessionDraft(account, scope, () => tab).initialDraft;
    if (!restored) throw new Error("Draft was not restored");
    expect(serializeComposerDraft(restored.doc).references).toEqual(submitted.references);
    expect(serializeComposerDraft(restored.doc).text).toBe(submitted.text);
    expect(JSON.stringify(restored)).not.toContain("composerUpload");
    expect(new ComposerSessionDraft("other", scope, () => tab).initialDraft).toBeNull();
    expect(
      new ComposerSessionDraft(account, { kind: "new-chat", id: scope.id }, () => tab).initialDraft,
    ).toBeNull();
    expect(new ComposerSessionDraft(account, scope, () => storage()).initialDraft).toBeNull();
  });

  it("cancels a queued draft write on journal hand-off, but preserves later writing and rejects foreign or malformed payloads", () => {
    vi.useFakeTimers();
    const tab = storage();
    const owner = new ComposerSessionDraft(account, scope, () => tab);
    owner.updateDraft(change("sent"));
    owner.handoff();
    vi.runAllTimers();
    expect(new ComposerSessionDraft(account, scope, () => tab).initialDraft).toBeNull();
    owner.updateDraft(change("later"));
    vi.runAllTimers();
    expect(new ComposerSessionDraft(account, scope, () => tab).initialDraft?.doc).toEqual(
      plainComposerDoc("later"),
    );
    tab.setItem(
      owner.key,
      JSON.stringify({ version: 1, accountId: "foreign", draft: change("foreign").snapshot }),
    );
    expect(new ComposerSessionDraft(account, scope, () => tab).initialDraft).toBeNull();
    tab.setItem(
      owner.key,
      JSON.stringify({
        version: 1,
        accountId: account,
        draft: {
          ...change("bad").snapshot,
          doc: { type: "doc", content: [{ type: "composerReference" }] },
        },
      }),
    );
    expect(new ComposerSessionDraft(account, scope, () => tab).initialDraft).toBeNull();
  });

  it("keeps authoring and hand-off usable when sessionStorage access throws", () => {
    const owner = new ComposerSessionDraft(account, scope, () => {
      throw new Error("denied");
    });
    expect(owner.initialDraft).toBeNull();
    expect(() => {
      owner.updateDraft(change("words"));
      owner.flush();
      owner.handoff();
    }).not.toThrow();
  });
});

it("hands the latest words between pane mounts before a debounced write or effect cleanup", async () => {
  vi.useFakeTimers();
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  let owner: ReturnType<typeof useComposerSessionDraft> | undefined;
  let restoredAtRender: string | null = null;
  function Pane() {
    owner = useComposerSessionDraft(account, { kind: "chat", id: "pane-handoff" });
    const snapshot = owner.initialDraft;
    restoredAtRender = snapshot ? serializeComposerDraft(snapshot.doc).text : null;
    return null;
  }
  try {
    await act(() => root.render(createElement(Pane, { key: "center" })));
    owner?.updateDraft(change("Just typed"));
    await act(() => root.render(createElement(Pane, { key: "dock" })));
    expect(restoredAtRender).toBe("Just typed");
  } finally {
    await act(() => root.unmount());
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
