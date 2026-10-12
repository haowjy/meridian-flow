/** Prepare an export with visible failure/summary; the browser owns download progress. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ExportOutsideArea } from "@meridian/contracts";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { downloadProjectExport, startProjectExport } from "@/client/api/project-export-api";
import { announce } from "@/client/stores/thread-store/announcements";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

export function ExportProjectDialog({
  accountSignal,
  projectId,
  project,
  onClose,
}: {
  accountSignal: AbortSignal;
  projectId: string;
  project: string;
  onClose(): void;
}) {
  const { i18n } = useLingui();
  const id = useId();
  const [scratch, setScratch] = useState(false);
  const [uploads, setUploads] = useState(false);
  const firstSwitch = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  const close = () => {
    alive.current = false;
    request.current?.abort();
    onClose();
  };
  const mutation = useMutation({
    mutationFn: (variables: { scratch: boolean; uploads: boolean; signal: AbortSignal }) =>
      startProjectExport(
        projectId,
        { scratch: variables.scratch, uploads: variables.uploads },
        variables.signal,
      ),
    onSuccess(result, variables) {
      if (!alive.current || variables.signal.aborted) return;
      downloadProjectExport(result.downloadUrl);
      announce(t`Exporting ${project}.`);
    },
  });
  const start = () => {
    if (mutation.isPending) return;
    request.current?.abort();
    request.current = new AbortController();
    mutation.mutate({
      scratch,
      uploads,
      signal: AbortSignal.any([request.current.signal, accountSignal]),
    });
  };
  const labels: Record<ExportOutsideArea, string> = {
    scratch: t`Scratch`,
    uploads: t`Uploads`,
    user: t`your User files`,
    deleted: t`documents that were deleted`,
  };
  const result = mutation.variables?.signal.aborted ? undefined : mutation.data;
  const where = result
    ? new Intl.ListFormat(i18n.locale, { type: "disjunction" }).format(
        (["scratch", "uploads", "user", "deleted"] as const)
          .filter((area) => result.outsideLinks.areas.includes(area))
          .map((area) => labels[area]),
      )
    : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstSwitch.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Export {project}</Trans>
          </DialogTitle>
          {result ? (
            <div role="status" className="space-y-4">
              <DialogDescription>
                <Trans>Your browser is downloading {result.fileName}.</Trans>
              </DialogDescription>
              <div className="space-y-3 text-sm">
                {result.outsideLinks.count > 0 ? (
                  <p>
                    {plural(result.outsideLinks.count, {
                      one: `# link points to ${where}, which isn't included.`,
                      other: `# links point to ${where}, which aren't included.`,
                    })}{" "}
                    <Trans>They stay as Meridian links and won't open in Obsidian.</Trans>
                  </p>
                ) : null}
                {result.pendingDrafts > 0 ? (
                  <p>
                    {plural(result.pendingDrafts, {
                      one: "# draft the AI hasn't applied isn't included.",
                      other: "# drafts the AI hasn't applied aren't included.",
                    })}
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <DialogDescription>
              <Trans>
                A ZIP of Markdown files and folders that Obsidian can open. Includes Manuscript,
                Knowledge Base and Unfiled.
              </Trans>
            </DialogDescription>
          )}
        </DialogHeader>
        {result ? null : (
          <div className="space-y-4">
            <label htmlFor={`${id}-scratch`} className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">
                  <Trans>Include Scratch</Trans>
                </span>
                <span className="block text-caption text-ink-muted">
                  <Trans>Notes the AI kept, grouped by Work.</Trans>
                </span>
              </span>
              <Switch
                id={`${id}-scratch`}
                ref={firstSwitch}
                checked={scratch}
                onCheckedChange={setScratch}
                disabled={mutation.isPending}
              />
            </label>
            <label htmlFor={`${id}-uploads`} className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">
                  <Trans>Include Uploads</Trans>
                </span>
                <span className="block text-caption text-ink-muted">
                  <Trans>Files attached in chat, grouped by Work.</Trans>
                </span>
              </span>
              <Switch
                id={`${id}-uploads`}
                checked={uploads}
                onCheckedChange={setUploads}
                disabled={mutation.isPending}
              />
            </label>
            {mutation.isError ? (
              <InlineErrorRow message={t`Couldn't start the export.`} onRetry={start} />
            ) : null}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={close}>
              <Trans>Done</Trans>
            </Button>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline">
                  <Trans>Cancel</Trans>
                </Button>
              </DialogClose>
              <Button disabled={mutation.isPending} onClick={start}>
                {mutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="size-4 animate-spin" />
                    <Trans>Preparing…</Trans>
                  </>
                ) : (
                  <Trans>Export</Trans>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
