import { workLifecycleState } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";

/**
 * Whether a Work's own source (its Scratch) takes changes: No Work's always, a named Work's while
 * it is neither archived nor deleted. An ended Work's still reads and copies out. Fails closed: a
 * Work the list doesn't show yet is read-only.
 */
export function useWorkSourceWritable(
  projectId: string,
  workId: string | null | undefined,
): boolean {
  const { works, noWork } = useWorks(projectId);
  if (!workId || workId === noWork?.id) return true;
  const work = works?.find((candidate) => candidate.id === workId);
  return Boolean(work && workLifecycleState(work) === "active");
}
