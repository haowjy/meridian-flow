import type { WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import {
  requireWorkDraftOwner,
  threadExecutionContext,
  WorkRequiredError,
} from "./thread-execution-context.js";

const WORK_ID = "00000000-0000-4000-8000-000000000201" as WorkId;
const NO_WORK_ID = "00000000-0000-4000-8000-000000000202" as WorkId;

describe("threadExecutionContext", () => {
  it("uses a named Work's column and draft owner", () => {
    expect(
      threadExecutionContext({
        id: WORK_ID,
        slug: testWorkSlug("arc"),
        aiWriteMode: "draft",
      }),
    ).toEqual({
      scope: { kind: "work", workId: WORK_ID, workSlug: testWorkSlug("arc") },
      aiWriteMode: "draft",
      draftOwner: { kind: "work", workId: WORK_ID },
    });
  });

  it("keeps Auto-apply live on a named Work", () => {
    expect(
      threadExecutionContext({
        id: WORK_ID,
        slug: testWorkSlug("arc"),
        aiWriteMode: "direct",
      }),
    ).toEqual({
      scope: { kind: "work", workId: WORK_ID, workSlug: testWorkSlug("arc") },
      aiWriteMode: "direct",
      draftOwner: null,
    });
  });

  it("uses No Work's column instead of forcing direct", () => {
    expect(
      threadExecutionContext({
        id: NO_WORK_ID,
        slug: null,
        aiWriteMode: "draft",
      }),
    ).toEqual({
      scope: { kind: "work", workId: NO_WORK_ID, workSlug: null },
      aiWriteMode: "draft",
      draftOwner: { kind: "work", workId: NO_WORK_ID },
    });
  });

  it("keeps Auto-apply live on No Work", () => {
    expect(
      threadExecutionContext({
        id: NO_WORK_ID,
        slug: null,
        aiWriteMode: "direct",
      }),
    ).toEqual({
      scope: { kind: "work", workId: NO_WORK_ID, workSlug: null },
      aiWriteMode: "direct",
      draftOwner: null,
    });
  });
});

describe("requireWorkDraftOwner", () => {
  it("returns the Work draft owner", () => {
    const context = threadExecutionContext({
      id: NO_WORK_ID,
      slug: null,
      aiWriteMode: "draft",
    });
    expect(requireWorkDraftOwner(context, "write.diff")).toEqual({
      kind: "work",
      workId: NO_WORK_ID,
    });
  });

  it("still requires a draft owner for write.diff in Auto-apply", () => {
    const context = threadExecutionContext({
      id: NO_WORK_ID,
      slug: null,
      aiWriteMode: "direct",
    });
    expect(() => requireWorkDraftOwner(context, "write.diff")).toThrow(WorkRequiredError);
  });
});
