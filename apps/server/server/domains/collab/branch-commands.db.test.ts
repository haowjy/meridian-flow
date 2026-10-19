/** A Discard retry that loses its grant after its twin commits still returns the stored outcome. */
import { randomUUID } from "node:crypto";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import { expect, it } from "vitest";
import {
  handleDiscardWorkDraftRequest,
  selectBranchRouteServices,
} from "../../lib/branch-review-route.js";
import { throwHttpInterrupt } from "../../shared/interrupt-boundary.js";
import {
  type BranchTreeStart,
  describeBranchTreeDb,
} from "../../test-support/branch-tree-suite.js";

/** A live chapter with two independent drafted changes in Ascension's draft. */
async function twoChanges(start: BranchTreeStart) {
  const { runtime, s } = await start();
  const ascension = await s.work("Ascension", "draft");
  const chapter = await s.model(ascension).create("chapter.md", "Opening.\n\nMiddle.\n\nEnd.");
  await s.model(ascension).edit("chapter.md", "Opening.", "Opening, drafted.");
  await s.model(ascension).edit("chapter.md", "End.", "End, drafted.");
  const deps = selectBranchRouteServices(runtime.app);
  const scope = { projectId: s.project.id, workId: ascension.id, userId: s.project.userId };
  const item = async () => {
    const found = (await s.items(ascension)).find((candidate) => candidate.documentId === chapter);
    if (!found) throw new Error("no chapter item");
    return found;
  };
  return { runtime, s, ascension, chapter, deps, scope, item };
}

describeBranchTreeDb("review commands (postgres)", (start) => {
  it.each([
    {
      name: "not found",
      refuse: () => createError({ statusCode: 404, message: "Draft not found" }),
    },
    {
      name: "archived",
      refuse: () => {
        try {
          throwHttpInterrupt(
            meridianErrorFromSystem("work_archived", "This Work is archived and read-only."),
            403,
          );
        } catch (refusal) {
          return refusal;
        }
      },
    },
  ])("12b: a twin that lost the race to its own command's effect answers the stored outcome when its grant is refused ($name)", async ({
    refuse,
  }) => {
    const c = await twoChanges(start);
    const { itemKey, branchId } = await c.item();
    const request = {
      branchId,
      itemKey,
      commandId: randomUUID(),
    } as Parameters<typeof handleDiscardWorkDraftRequest>[1]["request"];
    let twin: Awaited<ReturnType<typeof handleDiscardWorkDraftRequest>> | undefined;
    const authorize = c.deps.fileAccess.authorize.bind(c.deps.fileAccess);
    let first = true;
    const deps = {
      ...c.deps,
      fileAccess: {
        ...c.deps.fileAccess,
        // The twin's grant arrives after the first request has committed and tombstoned.
        authorize: async (...args: Parameters<typeof authorize>) => {
          if (first) {
            first = false;
            twin = await handleDiscardWorkDraftRequest(c.deps, {
              ...c.scope,
              documentId: c.chapter,
              request,
            });
            throw refuse();
          }
          return authorize(...args);
        },
      },
    } as typeof c.deps;
    const answered = await handleDiscardWorkDraftRequest(deps, {
      ...c.scope,
      documentId: c.chapter,
      request,
    });
    expect(twin?.body).toMatchObject({ status: "discarded" });
    expect(answered).toEqual(twin);
  });
});
