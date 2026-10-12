/** Preview selected exclusions before starting a native, stateless browser download. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ExportOutsideArea, ProjectExportPreview } from "@meridian/contracts";
import { useEffect, useId, useRef, useState } from "react";
import {
  downloadProjectExport,
  previewProjectExport,
  projectExportUrl,
} from "@/client/api/project-export-api";
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
  const [result, setResult] = useState<ProjectExportPreview>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    const signal = AbortSignal.any([request.signal, accountSignal]);
    setResult(undefined);
    setFailed(false);
    setLoading(true);
    const timer = setTimeout(() => {
      void previewProjectExport(projectId, { scratch, uploads }, signal).then(
        (preview) => {
          if (signal.aborted) return;
          setResult(preview);
          setLoading(false);
        },
        () => {
          if (signal.aborted) return;
          setFailed(true);
          setLoading(false);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      request.abort();
    };
  }, [projectId, scratch, uploads, accountSignal, retry]);
  const start = () => {
    if (accountSignal.aborted) return;
    downloadProjectExport(projectExportUrl(projectId, { scratch, uploads }));
    announce(t`Exporting ${project}.`);
    onClose();
  };
  const labels: Record<ExportOutsideArea, string> = {
    scratch: t`Scratch`,
    uploads: t`Uploads`,
    user: t`your User files`,
    deleted: t`documents that were deleted`,
  };
  const where = result
    ? new Intl.ListFormat(i18n.locale, { type: "disjunction" }).format(
        (["scratch", "uploads", "user", "deleted"] as const)
          .filter((area) => result.outsideLinks.byArea[area] > 0)
          .map((area) => labels[area]),
      )
    : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
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
          <DialogDescription>
            <Trans>
              A ZIP of Markdown files and folders that Obsidian can open. Includes Manuscript,
              Knowledge Base and Unfiled.
            </Trans>
          </DialogDescription>
        </DialogHeader>
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
            <Switch id={`${id}-uploads`} checked={uploads} onCheckedChange={setUploads} />
          </label>
          <div role="status" aria-live="polite" className="space-y-3 text-sm text-ink-muted">
            {loading ? (
              <p className="text-caption">
                <Trans>Checking links…</Trans>
              </p>
            ) : null}
            {result && !accountSignal.aborted ? (
              <>
                {result.outsideLinks.count > 0 ? (
                  <p>
                    {plural(result.outsideLinks.count, {
                      one: `# link points to ${where}, which won't be included.`,
                      other: `# links point to ${where}, which won't be included.`,
                    })}{" "}
                    <Trans>They'll stay as Meridian links and won't open in Obsidian.</Trans>
                  </p>
                ) : null}
                {result.pendingDrafts > 0 ? (
                  <p>
                    {plural(result.pendingDrafts, {
                      one: "# draft the AI hasn't applied won't be included.",
                      other: "# drafts the AI hasn't applied won't be included.",
                    })}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          {failed ? (
            <InlineErrorRow
              message={t`Couldn't load the preview.`}
              onRetry={() => setRetry((value) => value + 1)}
            />
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={start}>
            <Trans>Export</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
