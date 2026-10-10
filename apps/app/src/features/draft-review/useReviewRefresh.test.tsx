// @vitest-environment jsdom
/**
 * The review's one refresh owner: what makes the open review read its draft
 * again, and how often. Real Yjs documents and a real query client; the clock
 * is the only fake.
 */

import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { createEditorSessions } from "@/test-support/editor-sessions";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useReviewRefresh } from "./useReviewRefresh";

let sessions: ReturnType<typeof createEditorSessions>;
beforeEach(() => {
  sessions = createEditorSessions();
});
afterEach(async () => {
  await sessions.dispose();
});

const review = { documentId: "document-a", draftId: "draft-a" };
const previewKey = projectQueryKeys.workDraftPreview("p", "w", "document-a", "draft-a");

function Owner() {
  useReviewRefresh({
    projectId: "p",
    workId: "w",
    review,
    session: sessions.get("room-a"),
    liveSession: null,
  });
  return null;
}

async function mountOwner(run: (invalidated: () => string[]) => Promise<void>) {
  const client = new QueryClient();
  const invalidated: string[] = [];
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (filters) => {
    invalidated.push(
      JSON.stringify(filters?.queryKey) === JSON.stringify(previewKey) ? "preview" : "list",
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
  sessions.get(roomKey).document.getMap("edits").set("k", Math.random());
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => vi.useRealTimers());

describe("useReviewRefresh", () => {
  it("reads the draft and its list once after a burst of edits settles", async () => {
    await mountOwner(async (invalidated) => {
      await act(async () => {
        edit("room-a");
        edit("room-a");
        edit("room-a");
      });
      await wait(300);
      expect(invalidated()).toEqual([]);
      await act(async () => edit("room-a"));
      await wait(499);
      expect(invalidated()).toEqual([]);
      await wait(2);
      expect(invalidated().sort()).toEqual(["list", "preview"]);
    });
  });

  it("refreshes a stream that never pauses, rather than waiting for it to end", async () => {
    await mountOwner(async (invalidated) => {
      for (let i = 0; i < 30; i += 1) {
        await act(async () => edit("room-a"));
        await wait(200);
      }
      // 6s of writing with no pause longer than 200ms: it read along the way.
      expect(invalidated().filter((kind) => kind === "preview").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("completes discovery during sustained refreshes and reads trailing edits", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answers: Array<(room: string) => void> = [];
    const options = {
      queryKey: previewKey,
      queryFn: () => new Promise<string>((resolve) => answers.push(resolve)),
      staleTime: 0,
    };
    client.setQueryData(previewKey, "old-room");
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    let acquired: string | undefined;
    void client
      .fetchQuery(options)
      .then((room) => {
        acquired = room;
      })
      .catch(() => {});
    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Owner />
        </QueryClientProvider>,
        async () => {
          for (let i = 0; i < 20; i++) {
            await act(async () => edit("room-a"));
            await wait(200);
          }
          await act(async () => answers[0]?.("successor"));
          expect(acquired).toBe("successor");
          // Edits arrived while discovery was held: they need a fresh read too.
          expect(answers).toHaveLength(2);
          await act(async () => answers[1]?.("latest"));
          expect(client.getQueryData(previewKey)).toBe("latest");
        },
      );
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("reads nothing once the review is gone", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    let leave!: () => void;
    function Host() {
      const [open, setOpen] = useState(true);
      leave = () => setOpen(false);
      return open ? <Owner /> : null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
      async () => {
        await act(async () => edit("room-a"));
        await act(async () => leave());
        await wait(1000);
        expect(invalidate).not.toHaveBeenCalled();
      },
    );
  });
});
