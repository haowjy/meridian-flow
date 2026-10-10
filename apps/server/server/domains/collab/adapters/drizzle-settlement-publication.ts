/**
 * Publication steps inside a settlement transaction: planning them, taking the
 * batch's locks in the global order over everything they declare, and
 * combining their admission decisions. The pre-staging check and the
 * completion both call `planAndLock`, so they plan the same steps and lock the
 * same set in the same order.
 */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import type { PublicationCheckResult } from "../domain/ports/pending-settlement-store.js";
import type {
  PublicationAdmission,
  PublicationItemHold,
  SettlementBatchScope,
  SettlementNamespaceLocks,
  SettlementPublicationPlan,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";

/** Where Apply's tree work joins settlement, and the namespace locks it needs. */
export type SettlementPublication = {
  namespaces?: SettlementNamespaceLocks;
  steps: readonly SettlementPublicationStep[];
};

export type PlannedStep = { step: number; kind: string; plan: SettlementPublicationPlan };

/**
 * Plans every step from the scope, then locks, each over the whole batch at
 * once: Work rows, then one sorted namespace acquisition over the declared
 * documents' sources and explicit sources, then document mutation locks. Nothing
 * a step needs is locked later, so no step takes a namespace lock under a
 * document lock (file-access §5, contract §9.4).
 */
export async function planAndLock(
  db: DrizzleDb,
  publication: SettlementPublication,
  scope: SettlementBatchScope,
  members: { workIds: readonly WorkId[]; documentIds: readonly DocumentId[] },
): Promise<PlannedStep[]> {
  const planned = await Promise.all(publication.steps.map((step) => step.plan(scope)));
  const plans = planned.flatMap((plan, step) =>
    plan ? [{ step, kind: (publication.steps[step] as SettlementPublicationStep).kind, plan }] : [],
  );
  await lockWorksInIdOrder(db, [
    ...new Set([...members.workIds, ...plans.flatMap(({ plan }) => plan.workIds ?? [])]),
  ]);
  const documentIds = sortedUnique(plans.flatMap(({ plan }) => plan.namespaceDocumentIds ?? []));
  const sourceIds = sortedUnique(plans.flatMap(({ plan }) => plan.namespaceSourceIds ?? []));
  if (documentIds.length > 0 || sourceIds.length > 0) {
    if (!publication.namespaces) {
      throw new Error("A publication step needs namespace locks this store cannot take");
    }
    await publication.namespaces.lockNamespaces({ documentIds, sourceIds });
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
  decide: (plan: SettlementPublicationPlan) => Promise<PublicationAdmission> | undefined,
): Promise<PublicationAdmission> {
  const hold = new Map<string, PublicationItemHold>();
  for (const { plan } of plans) {
    const admission = await decide(plan);
    if (!admission) continue;
    if (admission.kind === "refuse") return admission;
    for (const held of admission.hold ?? []) {
      if (!hold.has(held.itemKey)) hold.set(held.itemKey, held);
    }
  }
  return { kind: "proceed", hold: [...hold.values()] };
}

/**
 * Every plan's pre-staging decision. A step that holds items must hand back its
 * payload refined to exclude them; the refined payloads are what gets staged.
 */
export async function decideCheck(
  plans: readonly PlannedStep[],
  payloads: ReadonlyMap<string, JsonValue>,
): Promise<PublicationCheckResult> {
  const hold = new Map<string, PublicationItemHold>();
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
      throw new Error(`Publication step ${kind} held items without refining its payload`);
    }
  }
  return { kind: "proceed", hold: [...hold.values()], payloads: staged };
}

/** Every step's outer preparation over its payload: the branch leases the batch needs. */
export async function requiredBranchLeases(
  publication: SettlementPublication,
  payloads: ReadonlyMap<string, JsonValue>,
): Promise<string[]> {
  const branchIds: string[] = [];
  for (const step of publication.steps) {
    const payload = payloads.get(step.kind);
    if (payload === undefined || !step.prepare) continue;
    branchIds.push(...(await step.prepare(payload)).branchIds);
  }
  return sortedUnique(branchIds);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
