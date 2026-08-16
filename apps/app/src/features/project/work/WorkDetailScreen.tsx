/** Focused Work detail composition with independently resilient resources. */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  MessageSquare,
  NotebookPen,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useWorkMutations } from "@/client/query/useWorks";
import { useWorkThreads } from "@/client/query/useWorkThreads";
import { Button } from "@/components/ui/button";
import type { ProjectRouteCommands } from "../routing/project-route";
import { WorkMetadata } from "./WorkMetadata";
import { ResourceError, WorkDialog, type WorkScreenProps } from "./WorkScreen";

export function WorkDetailScreen({
  projectId,
  work,
  routeCommands,
  onOpenThread,
}: WorkScreenProps & { work: Work }) {
  const mutation = useWorkMutations(projectId);
  const [dirty, setDirty] = useState(false);
  const [manage, setManage] = useState(false);
  const navigate = useCallback(
    (intent: () => void) => {
      if (!dirty || window.confirm("Discard your unsaved metadata changes?")) intent();
    },
    [dirty],
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  return (
    <div className="app-scroll">
      <article className="project-screen-column gap-10 pb-12">
        <div className="flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(() => void routeCommands.closeWork({ replace: true }))}
          >
            <ChevronLeft className="size-4" />
            <Trans>All Work</Trans>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setManage(true)}>
            {work.status === "archived" ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            <Trans>Manage Work</Trans>
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-meta text-muted-foreground">
            {work.status === "archived" ? <Trans>Archived</Trans> : <Trans>Active</Trans>}
          </span>
        </div>
        <WorkMetadata
          work={work}
          onDirtyChange={setDirty}
          save={(data) =>
            mutation.mutateAsync({ type: "update", workId: work.id, data }) as Promise<Work>
          }
        />
        <Drafts projectId={projectId} work={work} commands={routeCommands} />
        <div className="grid gap-6 @2xl/project-home:grid-cols-2">
          <TreeSummary
            projectId={projectId}
            work={work}
            scheme="scratch"
            icon={NotebookPen}
            commands={routeCommands}
          />
          <TreeSummary
            projectId={projectId}
            work={work}
            scheme="uploads"
            icon={Upload}
            commands={routeCommands}
          />
        </div>
        <Chats projectId={projectId} work={work} onOpenThread={onOpenThread} />
        <WorkDialog
          work={manage ? work : null}
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setManage(false)}
          onAction={(action) =>
            navigate(() =>
              mutation.mutate(action, {
                onSuccess: () => {
                  setManage(false);
                  if (action.type === "delete") void routeCommands.closeWork({ replace: true });
                },
              }),
            )
          }
        />
      </article>
    </div>
  );
}
function Drafts({
  projectId,
  work,
  commands,
}: {
  projectId: string;
  work: Work;
  commands: ProjectRouteCommands;
}) {
  const query = useWorkDrafts(projectId, work.id);
  const groups = activeWorkDraftGroups(query.groups);
  const workId = parseRequestId(work.id);
  return (
    <ResourceSection title="Pending drafts">
      {query.status === "loading" ? (
        <Loading />
      ) : query.status === "error" ? (
        <ResourceError label="Pending drafts" retry={query.refetch} />
      ) : groups.length ? (
        <ul className="divide-y divide-border-subtle rounded-lg border">
          {groups.map((group) => (
            <li key={group.documentId}>
              <button
                type="button"
                className="focus-ring flex min-h-11 w-full items-center justify-between px-4 py-3 text-left text-sm"
                onClick={() => {
                  if (group.contextPath && workId)
                    void commands.openWorkContext(
                      {
                        kind: "work-context",
                        workId,
                        scheme: "manuscript",
                        path: group.contextPath,
                      },
                      { replace: false },
                    );
                }}
              >
                <span>{group.documentName || group.contextPath || "Untitled manuscript"}</span>
                <span className="text-muted-foreground">{group.drafts.length} pending</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No pending drafts.</Empty>
      )}
    </ResourceSection>
  );
}
function TreeSummary({
  projectId,
  work,
  scheme,
  icon: Icon,
  commands,
}: {
  projectId: string;
  work: Work;
  scheme: "scratch" | "uploads";
  icon: typeof NotebookPen;
  commands: ProjectRouteCommands;
}) {
  const query = useProjectContextTree(projectId, scheme, { workId: work.id });
  const count = query.tree ? countFiles(query.tree) : 0;
  const label = scheme === "scratch" ? "Scratch" : "Uploads";
  const workId = parseRequestId(work.id);
  return (
    <ResourceSection title={label}>
      {query.isError ? (
        <ResourceError label={label} retry={query.refetch} />
      ) : !query.tree ? (
        <Loading />
      ) : (
        <button
          type="button"
          className="focus-ring flex min-h-16 w-full items-center gap-3 rounded-lg border px-4 text-left"
          onClick={() => {
            if (workId)
              void commands.openWorkContext(
                { kind: "work-context", workId, scheme },
                { replace: false },
              );
          }}
        >
          <Icon className="size-4" />
          <span>
            <span className="block text-sm font-medium">Open {label}</span>
            <span className="text-meta text-muted-foreground">
              {count ? `${count} items` : "Nothing here yet"}
            </span>
          </span>
        </button>
      )}
    </ResourceSection>
  );
}
function Chats({
  projectId,
  work,
  onOpenThread,
}: {
  projectId: string;
  work: Work;
  onOpenThread: (id: string) => void;
}) {
  const query = useWorkThreads(projectId, work.id);
  return (
    <ResourceSection title="Associated chats">
      {query.isError ? (
        <ResourceError label="Associated chats" retry={query.refetch} />
      ) : query.threads === null ? (
        <Loading />
      ) : query.threads.length ? (
        <ul className="divide-y divide-border-subtle rounded-lg border">
          {query.threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className="focus-ring flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left"
                onClick={() => onOpenThread(thread.id)}
              >
                <MessageSquare className="size-4" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {thread.title || "Untitled chat"}
                  </span>
                  <span className="text-meta text-muted-foreground">Open chat</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No chats are associated with this Work.</Empty>
      )}
    </ResourceSection>
  );
}
function ResourceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Loading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
function countFiles(node: ProjectContextTreeDirectory): number {
  return node.children.reduce(
    (sum, child) => sum + (child.kind === "dir" ? countFiles(child) : 1),
    0,
  );
}
