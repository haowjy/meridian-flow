// @vitest-environment jsdom

import type { JsonValue, ListTurnLiveLineageResponse } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { ThreadStoreProvider } from "@/client/stores";
import type { ToolView } from "./group-delivery-segments";
import { NamespaceChangeLine } from "./NamespaceChangeRow";
import { toolView } from "./report-test-fixtures";
import { ToolRow } from "./ToolRow";

const THREAD = "thread-1";
const TURN = "turn-1";
const DOCUMENT = "doc-2";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function deleteCall(): ToolView {
  const result: JsonValue = {
    schema: "meridian.agent-edit.v1",
    command: "delete",
    status: "success",
    phase: "committed",
    path: "manuscript://ch2.md",
    write: { id: "w1" },
    namespace: { kind: "deleted" },
  };
  const base = toolView({ toolCallId: "call-1", toolName: "write", result });
  return {
    ...base,
    input: { command: "delete", path: "manuscript://ch2.md" },
    metadata: { stagedNamespaceChange: true, documentId: DOCUMENT },
    keyBlock: { ...base.keyBlock, turnId: TURN },
  };
}

/** The server: the turn's lineage, and what a restore answers. */
function serve(restore: {
  status: number;
  body: unknown;
  restores: boolean;
  wait?: Promise<void>;
}) {
  let deleteStatus: "active" | "reversed" = "active";
  const lineage = (): ListTurnLiveLineageResponse => ({
    documents: [],
    receipt: { state: "live-active", control: "undo" },
    namespaceChanges: [
      {
        documentId: DOCUMENT,
        wId: 1,
        kind: "delete",
        fromUri: "manuscript://ch2.md",
        toUri: null,
        status: deleteStatus,
      },
    ],
  });
  const restoreRequests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/turns/${TURN}/restore-delete`) && init?.method === "POST") {
        restoreRequests.push(JSON.parse(String(init.body)));
        await restore.wait;
        if (restore.restores) deleteStatus = "reversed";
        return Response.json(restore.body, { status: restore.status });
      }
      if (url.endsWith(`/turns/${TURN}/live-lineage`)) return Response.json(lineage());
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return { restoreRequests };
}

describe("a delete row's Restore", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function renderRow() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadStoreProvider now={0}>
            <div data-testid="row">
              <ToolRow tool={deleteCall()} threadId={THREAD} />
            </div>
            <div data-testid="receipt">
              <ReceiptLines />
            </div>
          </ThreadStoreProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(restoreButton()).not.toBeNull());
  }

  function restoreButton(place: "row" | "receipt" = "row") {
    return host.querySelector<HTMLButtonElement>(
      `[data-testid="${place}"] button[aria-label="Restore ch2"]`,
    );
  }

  function text(place: "row" | "receipt") {
    return host.querySelector(`[data-testid="${place}"]`)?.textContent ?? "";
  }

  it("shares pending between receipt and tool row without claiming success", async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = serve({
      status: 200,
      body: { status: "restored", documentId: DOCUMENT, uri: "manuscript://ch2.md" },
      restores: true,
      wait,
    });
    await renderRow();
    await act(async () => restoreButton("receipt")?.click());
    await vi.waitFor(() => {
      expect(text("receipt")).toContain("Restoring…");
      expect(text("row")).toContain("Restoring…");
    });
    expect(host.textContent).not.toContain("Restored");
    expect(restoreButton("row")).toBeNull();
    expect(restoreButton("receipt")).toBeNull();
    await act(async () => finish());
    await vi.waitFor(() => expect(text("row")).toContain("Restored"));
    expect(text("receipt")).toContain("Restored");
    expect(server.restoreRequests).toHaveLength(1);
  });

  it("restores the document and the row says so", async () => {
    const server = serve({
      status: 200,
      body: { status: "restored", documentId: DOCUMENT, uri: "manuscript://ch2.md" },
      restores: true,
    });
    await renderRow();
    expect(host.textContent).toContain("Deleted ch2");

    await act(async () => restoreButton()?.click());

    await vi.waitFor(() => expect(host.textContent).toContain("Restored"));
    expect(restoreButton()).toBeNull();
    expect(server.restoreRequests).toEqual([{ documentId: DOCUMENT }]);
  });

  it("restores from the turn's receipt, and the row follows", async () => {
    const server = serve({
      status: 200,
      body: { status: "restored", documentId: DOCUMENT, uri: "manuscript://ch2.md" },
      restores: true,
    });
    await renderRow();
    expect(restoreButton("receipt")).not.toBeNull();

    await act(async () => restoreButton("receipt")?.click());

    await vi.waitFor(() => expect(text("receipt")).toContain("Restored"));
    expect(text("row")).toContain("Restored");
    expect(restoreButton("receipt")).toBeNull();
    expect(restoreButton("row")).toBeNull();
    expect(server.restoreRequests).toEqual([{ documentId: DOCUMENT }]);
  });

  it("does not claim restoration when there is no matching deletion", async () => {
    serve({ status: 409, body: { status: "nothing_to_restore" }, restores: false });
    await renderRow();
    await act(async () => restoreButton()?.click());
    await vi.waitFor(() => expect(text("row")).toContain("There is no deletion to restore."));
    expect(host.textContent).not.toContain("Restored");
  });

  it("puts a refusal on the row and offers Restore again", async () => {
    serve({
      status: 409,
      body: { status: "location_taken", uri: "manuscript://ch2.md" },
      restores: false,
    });
    await renderRow();

    await act(async () => restoreButton()?.click());

    await vi.waitFor(() =>
      expect(host.querySelector("[data-restore-note]")?.textContent).toBe(
        "Couldn't restore it. Something else is at ch2.md now.",
      ),
    );
    expect(host.textContent).not.toContain("Restored");
    expect(restoreButton()).not.toBeNull();
  });

  it("rolls back a 409 it doesn't know and asks to try again", async () => {
    serve({
      status: 409,
      body: { status: 409, message: "The document changed under the request" },
      restores: false,
    });
    await renderRow();

    await act(async () => restoreButton()?.click());

    await vi.waitFor(() =>
      expect(host.querySelector("[data-restore-note]")?.textContent).toBe(
        "Couldn't restore it. Try again.",
      ),
    );
    expect(host.textContent).not.toContain("Restored");
    expect(restoreButton()).not.toBeNull();
  });
});

/** The receipt's lines, fed the way the turn feeds them: from the turn's lineage. */
function ReceiptLines() {
  const lineage = useTurnLiveLineage(THREAD, TURN);
  return lineage.namespaceChanges?.map((change) => (
    <NamespaceChangeLine
      key={`${change.documentId}:${change.wId}`}
      change={change}
      threadId={THREAD}
      turnId={TURN}
    />
  ));
}
