// @vitest-environment jsdom
/** Real TipTap settlement and upload-ownership behavior. */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({ t: (value: TemplateStringsArray) => value.join("") }));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Write" }));

import {
  Composer,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
  type ComposerSubmitOutcome,
  type ComposerUploadPort,
} from "./Composer";

let root: Root;
let host: HTMLDivElement;
async function mount(
  onSubmit: (
    value: ComposerSubmitEnvelope,
  ) => ComposerSubmitOutcome | Promise<ComposerSubmitOutcome>,
  extra: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const ref = createRef<ComposerHandle>();
  await act(async () => root.render(<Composer ref={ref} onSubmit={onSubmit} {...extra} />));
  return ref;
}
async function send() {
  await act(async () =>
    (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click(),
  );
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const outcome = (
  envelope: ComposerSubmitEnvelope,
  kind: ComposerSubmitOutcome["kind"],
): ComposerSubmitOutcome => ({
  kind,
  submissionId: envelope.submissionId,
  acceptedRevision: envelope.acceptedRevision,
});
const textSnapshot = (text: string, revision: number) => ({
  revision,
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
  },
  selection: { anchor: text.length + 1, head: text.length + 1 },
  ownedUploads: [],
});
describe("Composer draft changes", () => {
  it("emits one authoritative snapshot with atomic JSON, selection, and owned uploads", async () => {
    const onDraftChange = vi.fn();
    const ref = await mount((e) => outcome(e, "accepted"), { onDraftChange });
    const upload = {
      intakeId: "intake-change",
      documentId: "01900000-0000-7000-8000-000000000007",
      uri: "uploads://@/change.png" as const,
      locationRevision: "revision-7",
    };
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerReference",
              attrs: {
                reference: {
                  documentId: upload.documentId,
                  uri: upload.uri,
                  fileType: "image",
                  authority: { kind: "none", projectId: "project-1" },
                  label: "change",
                  spelling: "[[change]]",
                  imageCapable: true,
                  upload,
                },
              },
            },
          ],
        },
      ],
    };
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 4,
        doc,
        selection: { anchor: 1, head: 2 },
        ownedUploads: [upload],
      }),
    );
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const change = onDraftChange.mock.calls[0]?.[0];
    expect(change.text).toBe("[[change]]");
    expect(change.snapshot.doc).toEqual(doc);
    expect(change.snapshot.selection).toEqual({ anchor: 1, head: 2 });
    expect(change.snapshot.ownedUploads).toEqual([upload]);
    expect(change.snapshot.revision).toBe(ref.current?.snapshot().revision);
  });
});

describe("Composer settlement", () => {
  it("preserves a newer revision against an older accepted result", async () => {
    let settle!: (value: ComposerSubmitOutcome) => void;
    let frozen!: ComposerSubmitEnvelope;
    const ref = await mount((e) => {
      frozen = e;
      return new Promise((r) => {
        settle = r;
      });
    });
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("first", 1)));
    await send();
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("newer", 2)));
    await act(async () => settle(outcome(frozen, "accepted")));
    expect(ref.current?.getDraft()).toBe("newer");
  });
  it("restores the exact snapshot and backward selection on definite rejection", async () => {
    let frozen!: ComposerSubmitEnvelope;
    const ref = await mount((e) => {
      frozen = e;
      return outcome(e, "rejected");
    });
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 4,
        doc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "abcdef" }] }],
        },
        selection: { anchor: 5, head: 3 },
        ownedUploads: [],
      }),
    );
    await send();
    expect(ref.current?.snapshot().doc).toEqual(frozen.draft.doc);
    expect(ref.current?.snapshot().selection).toEqual({ anchor: 5, head: 3 });
  });
  it("leaves an ambiguous draft visible and locked", async () => {
    const ref = await mount((e) => outcome(e, "ambiguous"));
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("uncertain", 1)));
    await send();
    expect(ref.current?.getDraft()).toBe("uncertain");
    expect(
      (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
describe("Composer upload deletion", () => {
  it("deletes a detached ready draft upload but never an accepted clear", async () => {
    const deleteDraft = vi.fn(async () => {});
    const port: ComposerUploadPort = { intake: vi.fn(), deleteDraft };
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: port,
      uploadScope: { kind: "none", projectId: "p" },
    });
    const upload = {
      intakeId: "i",
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "uploads://@/map.png" as const,
      locationRevision: "r1",
    };
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerReference",
              attrs: {
                reference: {
                  documentId: upload.documentId,
                  uri: upload.uri,
                  fileType: "image",
                  authority: { kind: "none", projectId: "p" },
                  label: "map",
                  spelling: "[[map]]",
                  imageCapable: true,
                  upload,
                },
              },
            },
          ],
        },
      ],
    };
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 1,
        doc,
        selection: { anchor: 1, head: 2 },
        ownedUploads: [upload],
      }),
    );
    await send();
    expect(deleteDraft).not.toHaveBeenCalled();
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 2,
        doc,
        selection: { anchor: 1, head: 2 },
        ownedUploads: [upload],
      }),
    );
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 3,
        doc: { type: "doc", content: [{ type: "paragraph" }] },
        selection: { anchor: 1, head: 1 },
        ownedUploads: [],
      }),
    );
    expect(deleteDraft).toHaveBeenCalledWith(upload, { kind: "none", projectId: "p" });
  });
  it("blocks pending intake, retains failure, and retries the stable intake identity", async () => {
    const intake = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage failed"))
      .mockResolvedValueOnce({
        documentId: "01900000-0000-7000-8000-000000000002",
        uri: "uploads://@/note.txt",
        fileType: "text",
        locationRevision: "r2",
      });
    const port: ComposerUploadPort = { intake, deleteDraft: vi.fn() };
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: port,
      uploadScope: { kind: "none", projectId: "p" },
    });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["note"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const failed = host.querySelector('[data-composer-upload="failed"]') as HTMLElement;
    expect(failed).not.toBeNull();
    expect(
      (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => failed.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(intake).toHaveBeenCalledTimes(2);
    expect(intake.mock.calls[1]?.[0].intakeId).toBe(intake.mock.calls[0]?.[0].intakeId);
    expect(ref.current?.snapshot().ownedUploads[0]).toMatchObject({ locationRevision: "r2" });
  });

  it("enables prose with a finalized No Work upload only after its intake settles", async () => {
    let resolveIntake!: (value: {
      documentId: string;
      uri: `uploads://${string}`;
      fileType: "image";
      locationRevision: string;
    }) => void;
    const intake = vi.fn(
      () =>
        new Promise<{
          documentId: string;
          uri: `uploads://${string}`;
          fileType: "image";
          locationRevision: string;
        }>((resolve) => {
          resolveIntake = resolve;
        }),
    );
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: { intake, deleteDraft: vi.fn() },
      uploadScope: { kind: "none", projectId: "p" },
    });
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("Opening", 1)));
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["map"], "map.png", { type: "image/png" })],
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const sendButton = host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(intake).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "none", projectId: "p" } }),
    );

    await act(async () =>
      resolveIntake({
        documentId: "01900000-0000-7000-8000-000000000003",
        uri: "uploads://@/map.png",
        fileType: "image",
        locationRevision: "r3",
      }),
    );
    expect(sendButton.disabled).toBe(false);
  });
});
