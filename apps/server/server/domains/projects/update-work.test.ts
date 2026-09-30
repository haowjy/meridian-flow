/** Work update command coverage for metadata and lifecycle atomicity. */
import type { WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { WorkLifecycleUnavailableError } from "./domain/work-lifecycle.js";
import {
  normalizeWorkUpdateInput,
  setWorkArchived,
  updateWorkTransition,
  WorkNameRequiredError,
  WorkStatusInvalidError,
} from "./update-work.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000801";

describe("updateWork", () => {
  it.each([
    {
      raw: { name: "  Revised  ", goal: "  Finish it  " },
      normalized: { name: "Revised", goal: "Finish it" },
    },
    {
      raw: { goal: " \n\t " },
      normalized: { goal: null },
    },
    {
      raw: { status: "  Needs\n outline  " },
      normalized: { status: "Needs outline" },
    },
  ])("normalizes shared metadata intent: $raw", ({ raw, normalized }) => {
    expect(normalizeWorkUpdateInput(raw)).toEqual(normalized);
  });

  it.each([
    "one two three four",
    "x".repeat(33),
  ])("rejects invalid AI-owned status: %s", (status) => {
    expect(() => normalizeWorkUpdateInput({ status })).toThrow(WorkStatusInvalidError);
  });

  it.each([
    { kind: "blank", name: " \n\t ", normalized: null },
  ])("validates $kind Name intent at the metadata boundary", ({ name, normalized }) => {
    if (normalized === null) {
      expect(() => normalizeWorkUpdateInput({ name })).toThrow(WorkNameRequiredError);
      return;
    }
    expect(normalizeWorkUpdateInput({ name })).toEqual({ name: normalized });
  });

  it("emits one Work refresh for a compound metadata and status command", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    const changed: string[] = [];

    await updateWorkTransition(
      {
        works,
        workContextNotices: {
          async workChanged(workId) {
            changed.push(workId);
          },
        },
      },
      existing.id,
      { name: "Revised", goal: "Finish it", status: "Drafting" },
    );

    expect(changed).toEqual([existing.id]);
  });

  it("refreshes Work context when the goal changes", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    let refreshes = 0;

    await updateWorkTransition(
      {
        works,
        workContextNotices: {
          async workChanged() {
            refreshes += 1;
          },
        },
      },
      existing.id,
      { goal: "Reach the gate" },
    );

    expect(refreshes).toBe(1);
  });

  it("returns the locked Work without writing when every requested field is identical", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({
      projectId: PROJECT_ID,
      name: "Draft",
      goal: "Finish it",
    });
    const update = vi.spyOn(works, "update");
    const workChanged = vi.fn(async () => {});

    const transition = await updateWorkTransition(
      { works, workContextNotices: { workChanged } },
      existing.id,
      {
        name: " Draft ",
        goal: "Finish it",
        status: null,
      },
    );

    expect(transition).toEqual({ before: existing, after: existing, changed: false });
    expect(update).not.toHaveBeenCalled();
    expect(workChanged).not.toHaveBeenCalled();
  });

  it("treats omitted optional fields as preserved and explicit nulls as clearing", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({
      projectId: PROJECT_ID,
      name: "Draft",
      goal: "Finish it",
    });
    const update = vi.spyOn(works, "update");

    const omitted = await updateWorkTransition(
      { works, workContextNotices: { async workChanged() {} } },
      existing.id,
      { name: "Draft" },
    );
    expect(omitted.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();

    const cleared = await updateWorkTransition(
      { works, workContextNotices: { async workChanged() {} } },
      existing.id,
      { goal: null },
    );
    expect(cleared).toMatchObject({
      before: { goal: "Finish it" },
      after: { goal: null },
      changed: true,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("updates and clears AI-owned status without changing archive lifecycle", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    const update = vi.spyOn(works, "update");
    const deps = { works, workContextNotices: { async workChanged() {} } };

    await expect(
      updateWorkTransition(deps, existing.id, {
        name: "Revised",
        status: "Drafting",
      }),
    ).resolves.toMatchObject({
      before: { name: "Draft", status: null, archivedAt: null },
      after: { name: "Revised", status: "Drafting", archivedAt: null },
      changed: true,
    });
    await expect(updateWorkTransition(deps, existing.id, { status: "" })).resolves.toMatchObject({
      after: { status: null, archivedAt: null },
      changed: true,
    });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("refuses archived metadata edits until an explicit unarchive", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    const deps = { works, workContextNotices: { async workChanged() {} } };
    await setWorkArchived(deps, existing.id, true);

    await expect(
      updateWorkTransition(deps, existing.id, { name: "Still blocked" }),
    ).rejects.toBeInstanceOf(WorkLifecycleUnavailableError);
    await setWorkArchived(deps, existing.id, false);
    await expect(
      updateWorkTransition(deps, existing.id, { name: "Revised" }),
    ).resolves.toMatchObject({ after: { name: "Revised", archivedAt: null } });
  });

  it("rolls metadata back when the lifecycle change fails", async () => {
    const base = createInMemoryWorkRepository();
    const existing = await base.create({ projectId: PROJECT_ID, name: "Draft" });
    const works = {
      ...base,
      async update(_id: WorkId) {
        throw new Error("update interrupted");
      },
    };

    await expect(
      updateWorkTransition({ works, workContextNotices: { async workChanged() {} } }, existing.id, {
        name: "Revised",
        status: "Drafting",
      }),
    ).rejects.toThrow("update interrupted");
    await expect(works.findById(existing.id)).resolves.toMatchObject({
      name: "Draft",
      status: null,
    });
  });
});
