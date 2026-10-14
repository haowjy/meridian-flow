// @vitest-environment jsdom
/**
 * Apply is one lifecycle per draft: the changes leave the screen at the click and come back with the reason
 * on them if the Apply fails; a whole-draft Apply owns its claim from the click, preparation included.
 * These tests protect that contract, and that one draft has one whole-draft command at a time.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import * as Y from "yjs";
import * as draftsApi from "@/client/api/drafts-api";
import { HttpResponseError } from "@/client/api/http-client";
import { appliedIn, baseKeyOf } from "@/features/draft-review/review-frame";
import { applyChanges, applyChatChanges, applyDraft } from "./draft-command-executor";
import {
  appliedChanges,
  changeFailure,
  currentDraftCommandRecords,
  draftCommandFailure,
  pendingDraftCommand,
  reconcileChangeRecords,
  resetDraftCommandRecords,
  sentChangeApplies,
} from "./draft-command-record";
import { projectQueryKeys } from "./project-query-keys";

const draft = { projectId: "p", workId: "w", documentId: "d", itemKey: "x:d" };
let queryClient: QueryClient;
let apply: MockInstance<typeof draftsApi.applyDraftChanges>;
beforeEach(() => {
  resetDraftCommandRecords();
  queryClient = new QueryClient();
  // The item is listed, so the command knows its draft without a metadata read.
  queryClient.setQueryData(projectQueryKeys.workDrafts("p", "w"), [
    { draftId: "x", itemKey: "x:d", documentId: "d", tokens: {} },
  ]);
  apply = vi.spyOn(draftsApi, "applyDraftChanges");
});
afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

const prepared = (snapshot: string | null = "c25hcA==") => ({
  prepare: async () => ({ snapshot, synced: () => Promise.resolve() }),
});
const records = () => currentDraftCommandRecords();

/** Places in one Yjs text stand in for the places changes are pinned at. */
const placeholder = new Y.Doc().getText("text");
placeholder.insert(0, "x".repeat(40));
const pinAt = (index: number) => Y.createRelativePositionFromTypeIndex(placeholder, index);
const targets = (...ids: string[]) => ids.map((id) => ({ id, pin: pinAt(5) }));

/** A frame whose review_base reads `text` and whose groups carry these ids at these places. */
const schema = buildDocumentSchema();
function frameOf(text: string, ...groups: [id: string, at: number][]) {
  const block = schema.node("paragraph", null, schema.text(text));
  return {
    groups: groups.map(([id]) => ({ id })),
    pins: new Map(groups.map(([id, at]) => [id, pinAt(at)])),
    diff: { base: { blocks: [block] } },
  } as never;
}

it("takes the changes off the screen at the click, sends the prepared snapshot, and holds them off until the review's base changes", async () => {
  let answer!: (value: Awaited<ReturnType<typeof draftsApi.applyDraftChanges>>) => void;
  apply.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const sent = applyChanges(queryClient, {
    scope: "change",
    draft,
    targets: targets("h~1"),
    baseKey: baseKeyOf(frameOf("red")),
    ...prepared(),
  });
  expect(appliedChanges(records(), draft).map((entry) => entry.id)).toEqual(["h~1"]);
  expect(sentChangeApplies(records(), draft)).toBe(1);
  await vi.waitFor(() =>
    expect(apply).toHaveBeenCalledWith("p", "w", "d", {
      commandId: expect.any(String),
      draftId: "x",
      itemKey: "x:d",
      changeIds: ["h~1"],
      snapshot: "c25hcA==",
    }),
  );
  answer({
    status: "applied",
    itemKey: "x:d",
    itemClosed: false,
    overrode: [{ live: "dawn", applied: "dusk" }],
  } as never);
  expect(await sent).toEqual({
    kind: "applied",
    overrode: [{ live: "dawn", applied: "dusk" }],
    itemClosed: false,
  });
  expect(sentChangeApplies(records(), draft)).toBe(0);
  // Settled but the base patch has not arrived: still the same base, so the clicked change stays off.
  const entries = appliedChanges(records(), draft);
  expect(appliedIn(frameOf("red", ["h", 2], ["h~1", 5]), entries).ids).toEqual(new Set(["h~1"]));
  // The second of two identical changes was applied: once the base has moved on, the survivor is `h`
  // again and must show. Retirement follows the base, never an id disappearing.
  const moved = frameOf("green", ["h", 2]);
  expect(appliedIn(moved, entries).ids).toEqual(new Set());
  reconcileChangeRecords(draft, [{ id: "h", pin: pinAt(2) }], () => baseKeyOf(moved));
  expect(appliedChanges(records(), draft)).toEqual([]);
});

it.each([
  {
    label: "a bare server error",
    answer: () => Promise.reject(new HttpResponseError("boom", 500, undefined)),
    code: "server-error",
  },
  {
    label: "a change the server cannot find",
    answer: () => Promise.resolve({ status: "not_found" as const, itemKey: "x:d" }),
    code: "gone",
  },
])("brings the changes back with the reason on them: $label", async ({ answer, code }) => {
  apply.mockImplementation(answer as never);
  const outcome = await applyChanges(queryClient, {
    scope: "change",
    draft,
    targets: targets("g1"),
    baseKey: "k1",
    ...prepared(),
  });
  expect(outcome).toEqual({ kind: "failed" });
  expect(appliedChanges(records(), draft)).toEqual([]);
  expect(changeFailure(records(), draft, { id: "g1", pin: pinAt(5) })?.code).toBe(code);
  // An unrelated change that inherited the id is not the one that failed.
  expect(changeFailure(records(), draft, { id: "g1", pin: pinAt(9) })).toBeNull();
  // A peer removed the clicked change while the Apply waited: only that twin is listed. The failure moves
  // to the file (the Apply still did not land) and never to the twin.
  reconcileChangeRecords(draft, [{ id: "g1", pin: pinAt(9) }], () => "k1");
  expect(changeFailure(records(), draft, { id: "g1", pin: pinAt(9) })).toBeNull();
  expect(draftCommandFailure(records(), draft)?.code ?? null).toBe(
    code === "gone" ? null : `apply-${code}`,
  );
});

it("a whole-draft Apply owns the draft's one claim from the click, through preparation, and a preparation failure lands on the draft", async () => {
  let ready!: () => void;
  const preparing = new Promise<void>((resolve) => (ready = resolve));
  const first = applyDraft(queryClient, {
    scope: "item",
    draft,
    prepare: async () => {
      await preparing;
      throw new Error("metadata request failed");
    },
  });
  expect(pendingDraftCommand(records(), draft)).toEqual({ mode: "apply" });
  expect(await applyDraft(queryClient, { scope: "item", draft, ...prepared() })).toEqual({
    kind: "blocked",
  });
  ready();
  expect(await first).toEqual({ kind: "failed" });
  expect(apply).not.toHaveBeenCalled();
  expect(pendingDraftCommand(records(), draft)).toBeNull();
  expect(draftCommandFailure(records(), draft)?.code).toBe("apply-offline");
});

it("the strip's Apply is pending at the click, reads the room inside the command, releases it on every path, and a failed read lands on the file", async () => {
  const release = vi.fn();
  const plan = {
    targets: targets("g1"),
    prepared: { snapshot: "c25hcA==", synced: () => Promise.resolve(), release },
  };
  apply.mockResolvedValue({
    status: "applied",
    itemKey: "x:d",
    itemClosed: false,
    overrode: [],
  } as never);

  let reading!: () => void;
  const waiting = new Promise<void>((resolve) => (reading = resolve));
  const sent = applyChatChanges(queryClient, draft, async () => {
    await waiting;
    return plan;
  });
  expect(pendingDraftCommand(records(), draft)).toEqual({ mode: "apply" });
  reading();
  expect(await sent).toMatchObject({ kind: "applied" });
  expect(apply.mock.calls[0]?.[3]).toMatchObject({ changeIds: ["g1"] });
  expect(release).toHaveBeenCalledTimes(1);

  // The attribution request fails: nothing is sent, the file says so.
  const failed = await applyChatChanges(queryClient, draft, async () => {
    throw new Error("attribution request failed");
  });
  expect(failed).toEqual({ kind: "failed" });
  expect(draftCommandFailure(records(), draft)?.code).toBe("apply-offline");

  // Offline: blocked before any room is read, so nothing is retained to leak.
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const acquire = vi.fn();
  expect(await applyChatChanges(queryClient, draft, acquire)).toEqual({ kind: "blocked" });
  expect(acquire).not.toHaveBeenCalled();
});
