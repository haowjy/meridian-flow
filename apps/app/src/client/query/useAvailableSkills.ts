/** Available skill listings for composer `/`: bound thread or selected Agent. */
import type { AgentSelection } from "@meridian/contracts/agents";
import type { ThreadAvailableSkill } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listSelectionAvailableSkills, listThreadAvailableSkills } from "@/client/api/threads-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

export type AvailableSkillsStatus = ListQueryStatus<ThreadAvailableSkill> & {
  skills: ThreadAvailableSkill[] | null;
};

export function useThreadAvailableSkills(threadId: string | null): AvailableSkillsStatus {
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = Boolean(threadId) && !isPendingCreation;
  const result = unwrapListQuery(
    useQuery({
      queryKey: threadQueryKeys.skills(threadId ?? ""),
      queryFn: async () => (await listThreadAvailableSkills(threadId as string)).skills,
      staleTime: 15_000,
      enabled,
    }),
  );
  if (!enabled) {
    return { ...result, data: null, status: "disabled", skills: null };
  }
  return { ...result, skills: result.data };
}

export function useSelectionAvailableSkills(
  selection: AgentSelection | null,
  projectId?: string | null,
): AvailableSkillsStatus {
  const enabled = selection !== null;
  const result = unwrapListQuery(
    useQuery({
      queryKey: [
        "available-skills",
        selection?.catalogEntryId ?? null,
        selection?.definitionRevisionId ?? null,
        projectId ?? null,
      ],
      queryFn: async () =>
        (
          await listSelectionAvailableSkills({
            catalogEntryId: selection?.catalogEntryId as string,
            definitionRevisionId: selection?.definitionRevisionId as string,
            projectId,
          })
        ).skills,
      staleTime: 15_000,
      enabled,
    }),
  );
  if (!enabled) {
    return { ...result, data: null, status: "disabled", skills: null };
  }
  return { ...result, skills: result.data };
}
