/**
 * A Work's drafts as the writer changes them: `+ New draft`, `Delete draft` and its Undo, each a
 * command the driver delivers. The list a surface shows is the server's read with every command
 * this tab has not seen a read include laid over it (`projectWorkDrafts`), so a new draft shows
 * and a deleted one leaves at once, offline too.
 */
import type {
  CommandDriver,
  CommandKind,
  CommandRecord,
  HttpRequest,
} from "@meridian/command-driver";
import { type DraftId, newDraftId, type WorkId } from "@meridian/contracts";
import type { WorkDraft } from "@meridian/contracts/drafts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { listWorkDrafts } from "@/client/api/drafts-api";
import type { CommandDomain } from "@/client/commands/driver-context";
import { useCommandDriver, useCommands } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { refreshDraftReads } from "./useOwnerDrafts";

const KINDS = {
  create: "draft_create",
  delete: "draft_delete",
  restore: "draft_restore",
} as const;

/** `draft`: the draft as the writer saw it, which the list shows until the server's read has it. */
type DraftCommandBody = {
  projectId: string;
  workId: string;
  draft: WorkDraft;
};

const lane = (workId: string) => `work-drafts:${workId}`;

export function workDraftsQueryOptions(projectId: string, workId: string) {
  return {
    queryKey: projectQueryKeys.workDrafts(projectId, workId),
    queryFn: () => listWorkDrafts(workId),
    staleTime: 15_000,
  };
}

/**
 * The Work's drafts with this tab's unseen commands over them, oldest command last: a create or a
 * restore lists its draft, a delete takes it out. A command that never reached the server shows
 * nothing.
 */
export function projectWorkDrafts(
  records: readonly CommandRecord[],
  workId: string,
  server: readonly WorkDraft[],
): WorkDraft[] {
  let drafts = [...server];
  for (const record of records) {
    if (!Object.values(KINDS).includes(record.kind as never)) continue;
    if (record.state === "never" || (record.state === "done" && record.observed)) continue;
    const body = record.body as DraftCommandBody;
    if (body.workId !== workId) continue;
    drafts = drafts.filter((draft) => draft.id !== body.draft.id);
    if (record.kind !== KINDS.delete) drafts.push(body.draft);
  }
  // A deleted default passes the mark on at the server: until its read, the oldest left holds it.
  if (drafts.length > 0 && !drafts.some((draft) => draft.isDefault))
    drafts = drafts.map((draft, at) => (at === 0 ? { ...draft, isDefault: true } : draft));
  return drafts.sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt),
  );
}

export function draftCommandsDomain(client: QueryClient): CommandDomain {
  let bound: CommandDriver | null = null;
  const settled = (record: CommandRecord) => {
    const { projectId, workId } = record.body as DraftCommandBody;
    const since = record.settledAt ?? Date.now();
    void client
      .refetchQueries({ queryKey: projectQueryKeys.workDrafts(projectId, workId) })
      .then(() => bound?.observe((each) => each.id === record.id));
    // Its chats moved to the default, and its changes left every list and count.
    void refreshDraftReads(client, projectId, new Set([undefined]), since);
  };
  const kind = (request: (body: DraftCommandBody) => HttpRequest): CommandKind => ({
    version: 1,
    migrate: (body) => body as DraftCommandBody,
    request: (record) => request(record.body as DraftCommandBody),
    onSettled: settled,
  });
  const path = (body: DraftCommandBody, rest = "") => `/api/works/${body.workId}/drafts${rest}`;
  const kinds: Record<string, CommandKind> = {
    [KINDS.create]: kind((body) => ({
      method: "POST",
      path: path(body),
      body: { draftId: body.draft.id, name: body.draft.name },
    })),
    [KINDS.delete]: kind((body) => ({
      method: "DELETE",
      path: path(body, `/${body.draft.id}`),
      body: {},
    })),
    [KINDS.restore]: kind((body) => ({
      method: "POST",
      path: path(body, `/${body.draft.id}/restore`),
      body: {},
    })),
  };
  return {
    kinds,
    bind: (driver) => {
      bound = driver;
      return () => {
        if (bound === driver) bound = null;
      };
    },
  };
}

export type WorkDraftsState = {
  /** Default first, then by creation; null until the first read. */
  drafts: readonly WorkDraft[] | null;
  /** `+ New draft`: lists it at once and returns its id, to show it. */
  create: (name: string) => DraftId | null;
  /** `Delete draft`, whose Undo is `restore` with the same draft. */
  remove: (draft: WorkDraft) => void;
  restore: (draft: WorkDraft) => void;
};

/** A named Work's drafts; `workId` null reads nothing (No Work owns no drafts). */
export function useWorkDrafts(projectId: string, workId: string | null): WorkDraftsState {
  const query = useQuery({
    ...workDraftsQueryOptions(projectId, workId ?? ""),
    enabled: projectReadEnabled(Boolean(workId)),
  });
  const records = useCommands();
  const driver = useCommandDriver();
  const queryClient = useQueryClient();
  const server = query.data?.drafts;
  const drafts = useMemo(
    () => (workId && server ? projectWorkDrafts(records, workId, server) : null),
    [records, workId, server],
  );
  return useMemo(() => {
    const send = (kind: string, draft: WorkDraft) => {
      if (!driver || !workId) return false;
      const body: DraftCommandBody = { projectId, workId, draft };
      void submitCommand(driver, { kind, lanes: [lane(workId)], body });
      return true;
    };
    return {
      drafts,
      create: (name) => {
        if (!workId) return null;
        const draft: WorkDraft = {
          id: newDraftId(),
          workId: workId as WorkId,
          name,
          isDefault: false,
          pendingDocumentCount: 0,
          pendingFolderCount: 0,
          createdAt: new Date().toISOString(),
        };
        // An empty draft has an empty list: seed it, so its pages don't wait on a read.
        queryClient.setQueryData(projectQueryKeys.drafts(projectId, draft.id), {
          items: [],
          folders: [],
          saw: {},
          readAt: Date.now(),
        });
        return send(KINDS.create, draft) ? draft.id : null;
      },
      remove: (draft) => void send(KINDS.delete, draft),
      restore: (draft) => void send(KINDS.restore, draft),
    };
  }, [drafts, driver, workId, projectId, queryClient]);
}
