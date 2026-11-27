import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { useMemo } from "react";
import { useWorks } from "@/client/query/useWorks";

export type WorkState =
  | { kind: "unknown" }
  | { kind: "active"; work: Work }
  | { kind: "ended"; work: Work; deleted: boolean };

type KnownWorks = {
  works: readonly Work[] | null;
  deleted: readonly Work[];
  noWork?: Work | null;
};

const UNKNOWN: WorkState = { kind: "unknown" };

export function workStateIn(
  { works, deleted, noWork }: KnownWorks,
  workId: string | null | undefined,
): WorkState {
  if (!workId) return UNKNOWN;
  const work =
    workId === noWork?.id
      ? noWork
      : (works?.find((one) => one.id === workId) ?? deleted.find((one) => one.id === workId));
  if (!work) return UNKNOWN;
  const lifecycle = workLifecycleState(work);
  return lifecycle === "active"
    ? { kind: "active", work }
    : { kind: "ended", work, deleted: lifecycle === "deleted" };
}

export function useWorkState(projectId: string, workId: string | null | undefined): WorkState {
  const { works, deleted, noWork } = useWorks(projectId);
  return useMemo(
    () => workStateIn({ works, deleted, noWork }, workId),
    [works, deleted, noWork, workId],
  );
}
