/** Import activity cards and their inline decisions, shared by desktop and the phone sheet. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { IMPORT_NEEDS_LOOK_REASONS, type ImportScheme } from "@meridian/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useProject } from "@/client/query/useProjectList";
import { useActivityToast, useToastVisible } from "@/components/app/toast-registry";
import { Button } from "@/components/ui/button";
import { projectAddressHref } from "@/features/project/routing/project-address";
import { useImportsSnapshot } from "./ImportsProvider";
import type { ImportCoordinator, TrackedImport } from "./import-coordinator";
import { useImportMilestone } from "./milestones";
import { readPicked } from "./read-picked";
import { failureSentence } from "./reason-copy";
import { PickInputs } from "./SelectionPicker";
import { toastPresentation } from "./toast-presentation";

export function ImportToasts({ coordinator }: { coordinator: ImportCoordinator }) {
  const { imports } = useImportsSnapshot(coordinator);
  return imports
    .filter((item) => !item.dismissed)
    .map((item) => <ImportToast key={item.importId} item={item} coordinator={coordinator} />);
}
function ImportToast({
  item,
  coordinator,
}: {
  item: TrackedImport;
  coordinator: ImportCoordinator;
}) {
  const { importId, summary, local, detail } = item;
  const visible = useToastVisible(importId);
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const project = useProject(summary.projectId);
  const otherProject = !location.pathname.startsWith(`/p/${summary.projectId}/`);
  const scheme = (
    summary.label.kind === "export" ? "manuscript" : summary.destination.folderUri.split(":")[0]
  ) as ImportScheme;
  const { catalog } = useContextCatalogView(summary.projectId, scheme, {});
  const presentation = toastPresentation(summary, local, Date.now());
  const { state } = presentation;
  useImportMilestone(state, presentation.title);
  useEffect(() => {
    if (summary.state === "finished" && detail?.state !== "finished" && !local.error && !local.busy)
      void coordinator.loadDetail(importId);
  }, [summary.state, detail, coordinator, importId, local.error, local.busy]);
  useEffect(() => {
    if (state !== "done" || !visible || local.error) return;
    const timer = setTimeout(() => {
      void coordinator.acknowledge(importId);
    }, 6000);
    return () => clearTimeout(timer);
  }, [state, visible, local.error, coordinator, importId]);
  const spec = useMemo(() => {
    const pick = () => (summary.label.kind === "files" ? files : folder).current?.click();
    const button = (label: string, run: () => void, primary = false) => (
      <Button
        key={label}
        size="sm"
        variant={primary ? "default" : "ghost"}
        disabled={local.busy}
        onClick={run}
      >
        {label}
      </Button>
    );
    const stop = () => coordinator.askStop(importId, true);
    const retry = () => {
      void coordinator.retry(importId);
    };
    const actions =
      state === "stop" ? (
        <>
          {button(t`Keep going`, () => coordinator.askStop(importId, false))}
          {button(
            t`Stop and discard`,
            () => {
              void coordinator.stop(importId);
            },
            true,
          )}
        </>
      ) : state === "done" || state === "needs-look" ? (
        button(
          t`Show`,
          () => {
            const root = summary.root ? catalog?.normalized.entries.get(summary.root.id) : null;
            const parent = summary.destination.folderId
              ? catalog?.normalized.entries.get(summary.destination.folderId)
              : null;
            const path =
              root?.kind === "folder"
                ? root.path.join("/")
                : parent?.kind === "folder"
                  ? parent.path.join("/")
                  : "";
            void navigate({
              to: projectAddressHref({
                projectId: summary.projectId,
                destination: { kind: "browse", scheme, path },
                work: { kind: "absent" },
              }),
            });
          },
          true,
        )
      ) : state === "expired" ? null : state === "refused" ? (
        button(t`Try again`, retry, true)
      ) : (
        <>
          {local.stopLost ? null : button(t`Stop`, stop)}
          {state === "paused" || state === "wrong-root" ? (
            button(t`Continue…`, pick, true)
          ) : state === "missing" ? (
            <>
              {button(t`Pick again`, pick)}
              {button(
                t`Import without them`,
                () => {
                  void coordinator.withoutMissing(importId);
                },
                true,
              )}
            </>
          ) : state === "stalled" ? (
            button(t`Retry`, retry, true)
          ) : state === "failed" ? (
            button(t`Try again`, retry, true)
          ) : null}
        </>
      );
    const problems =
      detail?.entries.filter(
        (entry) =>
          entry.state === "failed" ||
          IMPORT_NEEDS_LOOK_REASONS.some((reason) => reason === entry.reason),
      ) ?? [];
    const skipped =
      detail?.entries
        .filter((entry) => entry.state === "skipped" && !problems.includes(entry))
        .map(
          (entry) => entry.path || detail.roots.find((root) => root.rootId === entry.rootId)?.name,
        ) ?? [];
    return {
      title: presentation.title,
      detail: presentation.detail,
      progress: presentation.progress,
      actions,
      onClose: ["done", "needs-look", "expired", "refused"].includes(state)
        ? () => {
            void coordinator.acknowledge(importId);
          }
        : undefined,
      children: (
        <div className="space-y-2">
          {otherProject && project ? <p>{project.title}</p> : null}
          {presentation.note ? <p>{presentation.note}</p> : null}
          {presentation.fallback ? <p>{presentation.fallback}</p> : null}
          {local.stopLost ? (
            <p>
              <Trans>It finished before it could stop.</Trans>
            </p>
          ) : null}
          {local.error && state !== "refused" ? (
            <div role="alert" className="text-destructive">
              {local.error}
              {local.stopLost || (summary.state === "finished" && detail?.state !== "finished")
                ? button(t`Retry`, () => {
                    void coordinator.loadDetail(importId);
                  })
                : null}
            </div>
          ) : null}
          {state === "needs-look" ? (
            <details>
              <summary className="cursor-pointer text-foreground">
                <Trans>See files</Trans>
              </summary>
              <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                {problems.map((entry) => (
                  <li key={entry.entryId}>
                    <span className="block break-words text-foreground">
                      {entry.path ||
                        detail?.roots.find((root) => root.rootId === entry.rootId)?.name}
                    </span>
                    {failureSentence(entry.reason)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {skipped.length ? (
            <p className="break-words">
              <Trans>Not imported: {skipped.join(", ")}</Trans>
            </p>
          ) : null}
        </div>
      ),
    };
  }, [
    presentation.title,
    presentation.detail,
    presentation.progress,
    presentation.note,
    presentation.fallback,
    state,
    summary,
    local,
    detail,
    coordinator,
    importId,
    catalog,
    navigate,
    scheme,
    otherProject,
    project,
  ]);
  useActivityToast(importId, spec);
  return (
    <PickInputs
      folderRef={folder}
      filesRef={files}
      onPick={(picked) => {
        void readPicked(picked).then((selection) => coordinator.continue(importId, selection));
      }}
    />
  );
}
