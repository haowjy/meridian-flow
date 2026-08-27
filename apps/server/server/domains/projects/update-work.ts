/** Applies Work metadata and lifecycle changes as one atomic command. */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Work, WorkStatus } from "@meridian/contracts/works";
import type { UpdateWorkInput, WorkRepository } from "./ports/work-repository.js";
import type { WorkContextDelivery } from "./work-context-delivery.js";

export type UpdateWorkCommandInput = UpdateWorkInput & { status?: WorkStatus };
export type WorkTransition = { before: Work; after: Work; changed: boolean };

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
  return {
    ...(name !== undefined ? { name } : {}),
    ...(input.goal !== undefined ? { goal: optionalText(input.goal) } : {}),
    ...(input.description !== undefined ? { description: optionalText(input.description) } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
}

export async function updateWork(
  deps: {
    works: WorkRepository;
    workContextDelivery: Pick<WorkContextDelivery, "projectChanged">;
  },
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<Work> {
  return (await updateWorkTransition(deps, workId, input)).after;
}

export async function updateWorkTransition(
  deps: {
    works: WorkRepository;
    workContextDelivery: Pick<WorkContextDelivery, "projectChanged">;
  },
  workId: WorkId,
  input: UpdateWorkCommandInput,
): Promise<WorkTransition> {
  const normalized = normalizeWorkUpdateInput(input);
  const result = await deps.works.transaction(async () => {
    const before = await deps.works.lockById(workId);
    if (!before || before.deletedAt) throw new Error(`Work not found: ${workId}`);
    const requested = {
      name: normalized.name === undefined ? before.name : normalized.name,
      goal: normalized.goal === undefined ? before.goal : normalized.goal,
      description:
        normalized.description === undefined ? before.description : normalized.description,
      status: normalized.status ?? before.status,
    };
    const changed =
      before.name !== requested.name ||
      before.goal !== requested.goal ||
      before.description !== requested.description ||
      before.status !== requested.status;
    const work = changed ? await deps.works.update(workId, requested) : before;
    const result = {
      before,
      after: work,
      changed,
      contextChanged:
        before.name !== work.name || before.goal !== work.goal || before.status !== work.status,
    };
    if (result.contextChanged) await deps.workContextDelivery.projectChanged(work.projectId);
    return result;
  });
  return { before: result.before, after: result.after, changed: result.changed };
}
