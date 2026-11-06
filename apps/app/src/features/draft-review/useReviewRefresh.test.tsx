// @vitest-environment jsdom
/**
 * The review's one refresh owner: what makes the open review read its draft
 * again, and how often. Independent live Yjs documents and a real query client; the clock
 * is the only fake.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - review refresh debounce and invalidation ownership
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { createEditorSessions } from "@/test-support/editor-sessions";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useReviewRefresh } from "./useReviewRefresh";

let sessions: ReturnType<typeof createEditorSessions>;
let editVersion = 0;
beforeEach(() => {
  sessions = createEditorSessions();
  editVersion = 0;
});
afterEach(async () => {
  await sessions.dispose();
});

const review = { documentId: "document-a", itemKey: "draft-a" };
const metadataKey = projectQueryKeys.workDraftMetadata("p", "w", "document-a", "draft-a");

function Owner() {
  useReviewRefresh({
    projectId: "p",
    workId: "w",
    review,
    runtime: null,
    session: null,
    liveSession: sessions.get("room-a"),
  });
  return null;
}

async function mountOwner(run: (invalidated: () => string[]) => Promise<void>) {
  const client = new QueryClient();
  const invalidated: string[] = [];
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (filters) => {
    invalidated.push(
      JSON.stringify(filters?.queryKey) === JSON.stringify(metadataKey) ? "metadata" : "list",
    );
  });
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Owner />
    </QueryClientProvider>,
    () => run(() => invalidated),
  );
}

const edit = (roomKey: string) =>
  sessions.get(roomKey).document.getMap("edits").set("k", ++editVersion);
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => vi.useRealTimers());

describe("useReviewRefresh", () => {
  it("refreshes a stream that never pauses, rather than waiting for it to end", async () => {
    await mountOwner(async (invalidated) => {
      for (let i = 0; i < 30; i += 1) {
        await act(async () => edit("room-a"));
        await wait(200);
      }
      // 6s of writing with no pause longer than 200ms: it read along the way.
      expect(invalidated().filter((kind) => kind === "metadata").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("still reads a room change seen just before the live room re-binds", async () => {
    // A pull reaches the draft room; the Works catalog wake it raises re-renders the
    // editor, which briefly drops and re-binds its live room.
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    let rebind!: (bound: boolean) => void;
    function Host() {
      const [bound, setBound] = useState(true);
      rebind = setBound;
      useReviewRefresh({
        projectId: "p",
        workId: "w",
        review,
        runtime: null,
        session: null,
        liveSession: bound ? sessions.get("room-a") : null,
      });
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
      async () => {
        await act(async () => edit("room-a"));
        await wait(200);
        await act(async () => rebind(false));
        await act(async () => rebind(true));
        await wait(400);
        expect(invalidate).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: metadataKey }),
          expect.anything(),
        );
      },
    );
  });
});
