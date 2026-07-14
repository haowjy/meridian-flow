/**
 * Durable-save boundary tests for `useTempDocumentSave` — the highest-risk
 * flow on the temp surface: a writer's words must never be lost, whatever
 * the server or their typing does mid-save.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDocsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type TempDocumentSave, useTempDocumentSave } from "./use-temp-document-save";

const mutateAsyncMock = vi.fn();

vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ mutateAsync: mutateAsyncMock }),
}));
// The lingui macro is compile-time only; tests execute the un-compiled call.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));

const PROJECT = "project-save-test";

function seedTempDocument() {
  const document = useTempDocsStore.getState().createTemp(PROJECT);
  useTempDocsStore.getState().updateSaveName(PROJECT, document.id, "opening-line", true);
  return useTempDocsStore
    .getState()
    .byProject[PROJECT]?.find((candidate) => candidate.id === document.id);
}

function tempDocument(id: string) {
  return useTempDocsStore.getState().byProject[PROJECT]?.find((candidate) => candidate.id === id);
}

async function withSaveHook(
  options: { capture?: () => string | null },
  run: (api: () => TempDocumentSave, seeded: { id: string }) => Promise<void>,
) {
  const seeded = seedTempDocument();
  if (!seeded) throw new Error("seed failed");
  let latest: TempDocumentSave | null = null;
  function Probe() {
    latest = useTempDocumentSave({
      projectId: PROJECT,
      activeThreadId: null,
      document: seeded as NonNullable<typeof seeded>,
      captureContent: options.capture ?? (() => "# words"),
      onOpenSaved: onOpenSavedMock,
      onVerificationFailed: onVerificationFailedMock,
    });
    return null;
  }
  await withReactRoot(<Probe />, async () => {
    await run(() => {
      if (!latest) throw new Error("hook not mounted");
      return latest;
    }, seeded);
  });
}

const onOpenSavedMock = vi.fn();
const onVerificationFailedMock = vi.fn();

beforeEach(() => {
  mutateAsyncMock.mockReset();
  onOpenSavedMock.mockReset();
  onVerificationFailedMock.mockReset();
  useTempDocsStore.setState({ byProject: {} });
});

describe("useTempDocumentSave", () => {
  it("removes the temp document after a clean save and opens the durable file", async () => {
    mutateAsyncMock.mockResolvedValue({ status: "created" });
    await withSaveHook({}, async (api, seeded) => {
      await act(async () => api().save());
      expect(onOpenSavedMock).toHaveBeenCalledWith("manuscript", "/opening-line");
      expect(tempDocument(seeded.id)).toBeUndefined();
      expect(onVerificationFailedMock).not.toHaveBeenCalled();
    });
  });

  it("keeps the temp document and reports conflict when the path exists", async () => {
    mutateAsyncMock.mockResolvedValue({ status: "conflict" });
    await withSaveHook({}, async (api, seeded) => {
      await act(async () => api().save());
      expect(api().saveState.kind).toBe("conflict");
      expect(tempDocument(seeded.id)).toBeDefined();
      expect(onOpenSavedMock).not.toHaveBeenCalled();
    });
  });

  it("keeps newer words when the writer typed during the save", async () => {
    mutateAsyncMock.mockImplementation(async () => {
      // Simulate typing mid-flight: bump the revision before the write lands.
      const id = Object.values(useTempDocsStore.getState().byProject)[0]?.[0]?.id;
      if (id) {
        useTempDocsStore
          .getState()
          .updateTemp(PROJECT, id, { type: "doc", content: [{ type: "paragraph" }] });
      }
      return { status: "created" };
    });
    await withSaveHook({}, async (api, seeded) => {
      await act(async () => api().save());
      // The snapshot saved and opened, but the temp doc (with newer words) stays.
      expect(onOpenSavedMock).toHaveBeenCalled();
      expect(tempDocument(seeded.id)).toBeDefined();
      expect(api().saveState).toEqual({ kind: "failed", reason: "newer-words" });
      expect(onVerificationFailedMock).toHaveBeenCalled();
    });
  });

  it("keeps the temp document when the durable write fails", async () => {
    mutateAsyncMock.mockRejectedValue(new Error("network"));
    await withSaveHook({}, async (api, seeded) => {
      await act(async () => api().save());
      expect(api().saveState).toEqual({ kind: "failed", reason: "generic" });
      expect(tempDocument(seeded.id)).toBeDefined();
      expect(onVerificationFailedMock).toHaveBeenCalled();
    });
  });

  it("rejects an invalid name without calling the server", async () => {
    await withSaveHook({}, async (api) => {
      act(() => api().rename("bad/name"));
      await act(async () => api().save());
      expect(mutateAsyncMock).not.toHaveBeenCalled();
      expect(api().saveState).toEqual({ kind: "failed", reason: "generic" });
    });
  });

  it("does nothing while the editor has not mounted", async () => {
    await withSaveHook({ capture: () => null }, async (api) => {
      await act(async () => api().save());
      expect(mutateAsyncMock).not.toHaveBeenCalled();
      expect(api().saveState.kind).toBe("editing");
    });
  });
});
