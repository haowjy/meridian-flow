/**
 * A chat's write mode changed (a switch applied): bring the cached chat and its
 * Work's default to the new mode. The Work's default follows the last switch
 * (TL-D62-b), so a new chat in that Work starts in it.
 */
import type { AiWriteMode, WorksSnapshot } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import type { deserializeThreadSnapshot } from "@/client/api/threads-api";
import { projectQueryKeys } from "./project-query-keys";
import { patchThreadInProjectCaches } from "./project-thread-cache";
import { threadQueryKeys } from "./thread-query-keys";
import { installCommittedWork } from "./works-projection-acquisition";

export function applyWriteModeSwitch(
  client: QueryClient,
  input: { projectId: string; threadId: string; workId: string | null; mode: AiWriteMode },
): void {
  const { projectId, threadId, workId, mode } = input;
  patchThreadInProjectCaches(client, threadId, { aiWriteMode: mode });
  client.setQueryData<ReturnType<typeof deserializeThreadSnapshot>>(
    threadQueryKeys.snapshot(threadId),
    (snapshot) =>
      snapshot ? { ...snapshot, thread: { ...snapshot.thread, aiWriteMode: mode } } : snapshot,
  );
  const works = client.getQueryData<WorksSnapshot>(projectQueryKeys.works(projectId));
  const target = workId ?? works?.noWork.id;
  if (!target) return;
  installCommittedWork(client, projectId, target, (work) =>
    work ? { ...work, defaultAiWriteMode: mode } : work,
  );
}
