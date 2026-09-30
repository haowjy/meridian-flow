/** Applies Work metadata and lifecycle changes as one atomic command. */

import type { WorkId } from "@meridian/contracts/runtime";
import {
  INVALID_WORK_STATUS,
  normalizeWorkStatus,
  WORK_STATUS_MAX_LENGTH,
  type Work,
  workLifecycleState,
} from "@meridian/contracts/works";
import { WorkLifecycleUnavailableError } from "./domain/work-lifecycle.js";
import {
  type UpdateWorkInput,
  WorkLockedError,
  type WorkRepository,
} from "./ports/work-repository.js";
import type { WorkContextNotices } from "./work-context-notices.js";

export type UpdateWorkCommandInput = UpdateWorkInput;
export type WorkTransition = { before: Work; after: Work; changed: boolean };

export class WorkStatusInvalidError extends Error {
  constructor() {
    super(
      `Work status must be one to three words and ${WORK_STATUS_MAX_LENGTH} characters or fewer`,
    );
    this.name = "WorkStatusInvalidError";
  }
}

export class WorkNameRequiredError extends Error {
  constructor() {
    super("Work name must be a non-empty string");
    this.name = "WorkNameRequiredError";
  }
}

/** Canonical metadata semantics for every human, model, and reversal caller. */
export function normalizeWorkUpdateInput(input: UpdateWorkCommandInput): UpdateWorkCommandInput {
  const optionalText = (value: string | null | undefined): string | null | undefined => {
    if (value === undefined || value === null) return value;
    const trimmed = value.trim();
    return trimmed || null;
  };
  const name = input.name?.trim();
  if (name !== undefined && !name) throw new WorkNameRequiredError();
  const status = input.status === undefined ? undefined : normalizeWorkStatus(input.status);
  if (status === INVALID_WORK_STATUS) throw new WorkStatusInvalidError();
  return {
    ...(name !== undefined ? { name } : {}),
    ...(input.goal !== undefined ? { goal: optionalText(input.goal) } : {}),
    ...(input.status !== undefined ? { status } : {}),
  };
}

export async function updateWorkTransition(
  deps: {
    works: WorkRepository;
    workContextNotices: Pick<WorkContextNotices, "workChanged">;
  },
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<WorkTransition> {
  const normalized = normalizeWorkUpdateInput(input);
  const result = await deps.works.transaction(async () => {
    const before = await deps.works.lockById(workId);
    if (!before) throw new WorkLifecycleUnavailableError(workId, "missing");
    const lifecycle = workLifecycleState(before);
    if (lifecycle !== "active") {
      throw new WorkLifecycleUnavailableError(workId, lifecycle, before.slug);
    }
    if (
      before.isNoWork &&
      (normalized.name !== undefined ||
        normalized.goal !== undefined ||
        normalized.status !== undefined)
    ) {
      throw new WorkLockedError();
    }
    const requested = {
      name: normalized.name === undefined ? before.name : normalized.name,
      goal: normalized.goal === undefined ? before.goal : normalized.goal,
      status: normalized.status === undefined ? before.status : normalized.status,
    };
    const changed =
      before.name !== requested.name ||
      before.goal !== requested.goal ||
      before.status !== requested.status;
    const work = changed ? await deps.works.update(workId, requested) : before;
    const result = {
      before,
      after: work,
      changed,
      contextChanged:
        before.name !== work.name || before.goal !== work.goal || before.status !== work.status,
    };
    if (result.contextChanged) await deps.workContextNotices.workChanged(work.id);
    return result;
  });
  return { before: result.before, after: result.after, changed: result.changed };
}

/** Changes archive lifecycle without overloading the AI-owned status text. */
export async function setWorkArchived(
  deps: {
    works: WorkRepository;
    workContextNotices: Pick<WorkContextNotices, "workChanged">;
  },
  workId: WorkId,
  archived: boolean,
): Promise<WorkTransition> {
  return deps.works.transaction(async () => {
    const before = await deps.works.lockById(workId);
    if (!before) throw new WorkLifecycleUnavailableError(workId, "missing");
    const lifecycle = workLifecycleState(before);
    if (lifecycle === "deleted") {
      throw new WorkLifecycleUnavailableError(workId, lifecycle, before.slug);
    }
    const after = archived ? await deps.works.archive(workId) : await deps.works.unarchive(workId);
    const result = { before, after, changed: before.archivedAt !== after.archivedAt };
    if (result.changed) await deps.workContextNotices.workChanged(after.id);
    return result;
  });
}
