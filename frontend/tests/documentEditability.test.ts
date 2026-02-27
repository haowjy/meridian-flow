import { describe, expect, it } from "vitest";
import { computeDocumentEditable } from "@/features/documents/lib/documentEditability";

describe("computeDocumentEditable", () => {
  it("keeps non-collab behavior unchanged", () => {
    expect(
      computeDocumentEditable({
        isInitialized: true,
        activeDocumentId: "doc-1",
        documentId: "doc-1",
        isLoading: false,
        collabEnabled: false,
        collabConnectionState: "disconnected",
      }),
    ).toBe(true);
  });

  it("requires connected state for collab documents", () => {
    expect(
      computeDocumentEditable({
        isInitialized: true,
        activeDocumentId: "doc-1",
        documentId: "doc-1",
        isLoading: false,
        collabEnabled: true,
        collabConnectionState: "syncing",
      }),
    ).toBe(false);

    expect(
      computeDocumentEditable({
        isInitialized: true,
        activeDocumentId: "doc-1",
        documentId: "doc-1",
        isLoading: false,
        collabEnabled: true,
        collabConnectionState: "connected",
      }),
    ).toBe(true);
  });

  it("stays read-only when editor state is not ready", () => {
    expect(
      computeDocumentEditable({
        isInitialized: false,
        activeDocumentId: "doc-1",
        documentId: "doc-1",
        isLoading: false,
        collabEnabled: false,
        collabConnectionState: "connected",
      }),
    ).toBe(false);

    expect(
      computeDocumentEditable({
        isInitialized: true,
        activeDocumentId: "doc-2",
        documentId: "doc-1",
        isLoading: false,
        collabEnabled: true,
        collabConnectionState: "connected",
      }),
    ).toBe(false);

    expect(
      computeDocumentEditable({
        isInitialized: true,
        activeDocumentId: "doc-1",
        documentId: "doc-1",
        isLoading: true,
        collabEnabled: true,
        collabConnectionState: "connected",
      }),
    ).toBe(false);
  });
});
