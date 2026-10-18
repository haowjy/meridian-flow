/**
 * Apply steps inside a settlement transaction: planning them, taking the
 * batch's locks in the global order over everything they declare, and
 * combining their admission decisions. The pre-staging check and the
 * completion both call `planAndLock`, so they plan the same steps and lock the
 * same set in the same order.
 */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import { drafts } from "@meridian/database/schema";
import { asc, inArray } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { ApplyCheckResult } from "../domain/ports/pending-settlement-store.js";
import type {
  ApplyAdmission,
  ApplyItemHold,
  ApplyItemOutcome,
  SettlementApplyPlan,
  SettlementApplyStep,
  SettlementBatchScope,
  SettlementNamespaceLocks,
} from "../domain/ports/settlement-apply.js";

/** Where Apply's tree work joins settlement, and the namespace locks it needs. */
export type SettlementApply = {
  namespaces?: SettlementNamespaceLocks;
  steps: readonly SettlementApplyStep[];
};

export type PlannedStep = { step: number; kind: string; plan: SettlementApplyPlan };

/**
 * Plans every step from the scope, then locks, each over the whole batch at
 * once: Work rows, then draft rows, then one sorted namespace acquisition over the declared
 * documents' sources and explicit sources, then document mutation locks. Nothing
 * a step needs is locked later, so no step takes a namespace lock under a
 * document lock (file-access §5, contract §9.4).
 */
export async function planAndLock(
  db: DrizzleDb,
  settlementApply: SettlementApply,
  scope: SettlementBatchScope,
  members: { workIds: readonly WorkId[]; documentIds: readonly DocumentId[] },
  /** Work-first order's one owner (decision D17). */
  workBoundary: Pick<WorkProjectionMutation, "lockWorks">,
): Promise<PlannedStep[]> {
  const planned = await Promise.all(settlementApply.steps.map((step) => step.plan(scope)));
  const plans = planned.flatMap((plan, step) =>
    plan ? [{ step, kind: (settlementApply.steps[step] as SettlementApplyStep).kind, plan }] : [],
  );
  await workBoundary.lockWorks({
    works: [...members.workIds, ...plans.flatMap(({ plan }) => plan.workIds ?? [])],
  });
  const draftIds = sortedUnique(plans.flatMap(({ plan }) => plan.draftIds ?? []));
  if (draftIds.length > 0) {
    await db
      .select({ id: drafts.id })
      .from(drafts)
      .where(inArray(drafts.id, draftIds))
      .orderBy(asc(drafts.id))
      .for("no key update");
  }
  const documentIds = sortedUnique(plans.flatMap(({ plan }) => plan.namespaceDocumentIds ?? []));
  const sourceIds = sortedUnique(plans.flatMap(({ plan }) => plan.namespaceSourceIds ?? []));
  if (documentIds.length > 0 || sourceIds.length > 0) {
    if (!settlementApply.namespaces) {
      throw new Error("An Apply step needs namespace locks this store cannot take");
    }
    await settlementApply.namespaces.lockNamespaces({ documentIds, sourceIds });
  }
  for (const documentId of sortedUnique([
    ...members.documentIds,
    ...plans.flatMap(({ plan }) => plan.documentIds ?? []),
  ])) {
    await lockDocumentMutation(db, documentId);
  }
  return plans;
}

/** Every plan's completion decision, in order: any refusal refuses the batch; holds are unioned. */
export async function decideAdmission(
  plans: readonly PlannedStep[],
  decide: (plan: SettlementApplyPlan) => Promise<ApplyAdmission> | undefined,
): Promise<ApplyAdmission> {
  const hold = new Map<string, ApplyItemHold>();
  const outcomes: ApplyItemOutcome[] = [];
  for (const { plan } of plans) {
    const admission = await decide(plan);
    if (!admission) continue;
    if (admission.kind === "refuse") return admission;
    for (const held of admission.hold ?? []) {
      if (!hold.has(held.itemKey)) hold.set(held.itemKey, held);
    }
    outcomes.push(...(admission.outcomes ?? []));
  }
  return { kind: "proceed", hold: [...hold.values()], outcomes };
}

/**
 * Every plan's pre-staging decision. A step that holds items must hand back its
 * payload refined to exclude them; the refined payloads are what gets staged.
 */
export async function decideCheck(
  plans: readonly PlannedStep[],
  payloads: ReadonlyMap<string, JsonValue>,
): Promise<ApplyCheckResult> {
  const hold = new Map<string, ApplyItemHold>();
  const staged = new Map(payloads);
  for (const { kind, plan } of plans) {
    const admission = await plan.check?.();
    if (!admission) continue;
    if (admission.kind === "refuse") return admission;
    for (const held of admission.hold ?? []) {
      if (!hold.has(held.itemKey)) hold.set(held.itemKey, held);
    }
    if (admission.payload !== undefined) {
      staged.set(kind, admission.payload);
    } else if ((admission.hold?.length ?? 0) > 0 && payloads.has(kind)) {
      throw new Error(`Apply step ${kind} held items without refining its payload`);
    }
  }
  return { kind: "proceed", hold: [...hold.values()], payloads: staged };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
