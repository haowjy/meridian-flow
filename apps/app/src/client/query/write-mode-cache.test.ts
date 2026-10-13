/** A chat's switch evidence never rewrites the Work's default, nor regresses a newer cached mode. */
import type { Thread } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { applyWriteModeAnswer, applyWriteModeDivider } from "./write-mode-cache";

it("leaves the Work's default to the Works refetch, and ignores an answer the snapshot already holds", () => {
  const client = new QueryClient();
  const works = { noWork: { id: "nw" }, works: [{ id: "w", defaultAiWriteMode: "direct" }] };
  client.setQueryData(projectQueryKeys.works("p"), works);
  const snapshot = (mode: string, turnIds: string[]) => ({
    thread: { id: "a", aiWriteMode: mode } as Thread,
    turns: turnIds.map((id) => ({ id })),
  });
  client.setQueryData(threadQueryKeys.snapshot("a"), snapshot("direct", ["d2"]));

  // Another chat's newer switch set the default to direct; A's delayed older divider arrives.
  applyWriteModeDivider(client, { projectId: "p", threadId: "a", mode: "draft" });
  expect(client.getQueryData(projectQueryKeys.works("p"))).toBe(works);
  expect(client.getQueryState(projectQueryKeys.works("p"))?.isInvalidated).toBe(true);

  // A replayed answer for a divider the snapshot already holds cannot regress the mode.
  client.setQueryData(threadQueryKeys.snapshot("a"), snapshot("direct", ["d1", "d2"]));
  applyWriteModeAnswer(client, { projectId: "p", threadId: "a", mode: "draft", turnId: "d1" });
  expect(
    client.getQueryData<{ thread: Thread }>(threadQueryKeys.snapshot("a"))?.thread.aiWriteMode,
  ).toBe("direct");
  // An answer the snapshot has not seen is newer evidence.
  applyWriteModeAnswer(client, { projectId: "p", threadId: "a", mode: "draft", turnId: "d3" });
  expect(
    client.getQueryData<{ thread: Thread }>(threadQueryKeys.snapshot("a"))?.thread.aiWriteMode,
  ).toBe("draft");
});
