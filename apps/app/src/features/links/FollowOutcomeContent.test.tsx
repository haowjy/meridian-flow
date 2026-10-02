// @vitest-environment jsdom
/**
 * Create on a missing link, through the dialog a surface hosts: success closes
 * and opens what it made, failure stays on the dialog and leaves no orphan
 * reservation, and a double press creates once.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkFollowOutcome } from "@/core/editor/links";

import { LinkFollowDialog } from "./LinkFollowDialog";

const resources = {
  reserveDocument: vi.fn(),
  setLocation: vi.fn(),
  deleteDocument: vi.fn(),
};
let worksValue: {
  works: { id: string; slug: string | null }[] | null;
  noWork: { id: string } | null;
};

vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
}));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => worksValue }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;
let release: ReturnType<typeof vi.fn>;

function reservation(documentId = "doc-new") {
  release = vi.fn();
  return {
    key: { handle: "handle-1" },
    name: "Untitled 3",
    content: { kind: "opened", handle: { documentId, release } },
  };
}

const missing = (address: string): LinkFollowOutcome => ({
  state: "missing",
  target: { kind: "scheme", uri: address },
  address,
});

function render(outcome: LinkFollowOutcome, onClose = vi.fn(), onOpen = vi.fn()) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <LinkFollowDialog
          outcome={outcome}
          projectId="project-1"
          workId={null}
          onClose={onClose}
          onRetry={vi.fn()}
          onOpen={onOpen}
        />
      </QueryClientProvider>,
    ),
  );
  return { onClose, onOpen };
}

function createButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Create the document",
  );
  if (!button) throw new Error("no Create button");
  return button;
}

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  worksValue = { works: [{ id: "work-rev", slug: "revision" }], noWork: { id: "no-work" } };
  for (const fn of Object.values(resources)) fn.mockReset();
  resources.reserveDocument.mockResolvedValue(reservation());
  resources.setLocation.mockResolvedValue({ isLatest: true });
  resources.deleteDocument.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Create on a missing link", () => {
  it("makes the document at the address, closes, and opens it", async () => {
    const { onClose, onOpen } = render(missing("kb://characters/Lin Feng"));
    await act(async () => createButton().click());

    expect(resources.setLocation).toHaveBeenCalledWith(
      "project-1",
      { handle: "handle-1" },
      {
        scheme: "kb",
        folderPath: "characters",
        name: "Lin Feng.md",
        workId: null,
      },
    );
    expect(release).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith({ documentId: "doc-new" });
  });

  it("says so on the dialog and discards the reservation when placing it fails", async () => {
    resources.setLocation.mockRejectedValue(new Error("resource unavailable"));
    const { onClose, onOpen } = render(missing("manuscript://volume-1/Lin Mei.md"));
    await act(async () => createButton().click());

    expect(resources.deleteDocument).toHaveBeenCalledWith("project-1", { handle: "handle-1" });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "The document could not be created. Try again.",
    );
  });

  it("creates once for a double press", async () => {
    const { onOpen } = render(missing("manuscript://volume-1/Lin Mei.md"));
    await act(async () => {
      createButton().click();
      createButton().click();
    });

    expect(resources.reserveDocument).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("waits for the Works list instead of failing a Scratch address in a named Work", async () => {
    worksValue = { works: null, noWork: null };
    const client = new QueryClient();
    client.setQueryData(["projects", "project-1", "works"], {
      works: [{ id: "work-rev", slug: "revision" }],
      noWork: { id: "no-work" },
    });
    const onOpen = vi.fn();
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <LinkFollowDialog
            outcome={missing("scratch://@revision/plan.md")}
            projectId="project-1"
            workId={null}
            onClose={vi.fn()}
            onRetry={vi.fn()}
            onOpen={onOpen}
          />
        </QueryClientProvider>,
      ),
    );
    await act(async () => createButton().click());

    expect(resources.setLocation).toHaveBeenCalledWith(
      "project-1",
      { handle: "handle-1" },
      expect.objectContaining({ scheme: "scratch", workId: "work-rev", workSlug: "revision" }),
    );
    expect(onOpen).toHaveBeenCalledWith({ documentId: "doc-new" });
  });

  it("offers no Create for an address naming another kind of file", () => {
    render(missing("manuscript://maps/map.png"));
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Create the document"),
    ).toBe(false);
  });
});
