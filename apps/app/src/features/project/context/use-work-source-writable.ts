import { workLifecycleState } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";

export function useWorkSourceWritable(
  projectId: string,
  workId: string | null | undefined,
): boolean {
  const { works, noWork } = useWorks(projectId);
  if (!workId || workId === noWork?.id) return true;
  const work = works?.find((candidate) => candidate.id === workId);
  return Boolean(work && workLifecycleState(work) === "active");
}
