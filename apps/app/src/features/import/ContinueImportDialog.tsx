/**
 * Continue import: choose the same files again, check them in the browser
 * (nothing is sent), then send only what has not arrived. A selection that is
 * not the one the import started with is refused with the first difference.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState, useSyncExternalStore } from "react";
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
import { Progress } from "@/components/ui/progress";
import {
  compareDigests,
  compareStructure,
  outstanding,
  type SelectionDifference,
} from "./continue-check";
import type { ImportCoordinator } from "./import-coordinator";
import { fullyRead } from "./import-state";
import { type BuiltManifest, buildManifest, bytesToHash } from "./manifest";
import { namesSentence } from "./report-copy";
import { PickZone, useSelectionPicker } from "./SelectionPicker";
import { useSelectionReader } from "./use-selection-reader";

type Step =
  | { kind: "choose" }
  | { kind: "checking"; percent: number; files: number }
  | { kind: "match"; built: BuiltManifest; send: number }
  | { kind: "mismatch"; difference: SelectionDifference }
  | { kind: "failed" };

function differenceSentence(difference: SelectionDifference): string {
  const name = difference.name;
  switch (difference.kind) {
    case "changed":
      return t`${name} has changed since the import started.`;
    case "missing":
      return t`${name} is missing.`;
    case "extra":
      return t`${name} wasn't in the original selection.`;
    case "unreadable":
      return t`Couldn't read ${name}. Choose again.`;
  }
}

export function ContinueImportDialog({
  importId,
  coordinator,
  onClose,
}: {
  importId: string;
  coordinator: ImportCoordinator;
  onClose: () => void;
}) {
  const reader = useSelectionReader();
  const picker = useSelectionPicker(reader);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [attempt, setAttempt] = useState(0);
  const store = coordinator.store(importId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const names = namesSentence(
    state.local?.roots.map((root) => root.name) ??
      state.report?.roots.map((root) => root.name) ??
      [],
  );
  // The check needs every entry; read them as soon as the dialog opens.
  useEffect(() => {
    if (!fullyRead(store.getSnapshot().report)) void store.refresh(true);
  }, [store]);

  // A new selection is checked as soon as it has been read.
  useEffect(() => {
    if (reader.state.status !== "ready") {
      setStep({ kind: "choose" });
      return;
    }
    const selection = reader.state.selection;
    const control = new AbortController();
    (async () => {
      try {
        // Fresh, whole: what the server wants now decides what Continue sends.
        await store.refresh(true);
        const report = store.getSnapshot().report;
        if (!fullyRead(report)) throw new Error("report");
        const stored = { roots: report.roots, entries: [...report.entries.values()] };
        // A plan the server has not finished resumes only for the very same selection.
        const exact = report.summary.state === "planning";
        const structural = compareStructure(stored, selection, { exact });
        if (structural) return setStep({ kind: "mismatch", difference: structural });
        const files = selection.roots.reduce((sum, root) => sum + root.files.length, 0);
        const total = bytesToHash(selection);
        setStep({ kind: "checking", percent: 0, files });
        const built = await buildManifest(selection, {
          importId,
          destinationUri: report.summary.destination.folderUri,
          signal: control.signal,
          onHashed: (bytes) =>
            setStep({ kind: "checking", percent: total ? (bytes / total) * 100 : 100, files }),
        });
        const hashed = compareDigests(stored, built.manifest, { exact });
        if (hashed) return setStep({ kind: "mismatch", difference: hashed });
        setStep({ kind: "match", built, send: outstanding(stored.entries) });
      } catch {
        if (!control.signal.aborted) setStep({ kind: "failed" });
      }
    })();
    return () => control.abort();
  }, [reader.state, store, importId, attempt]);

  const send = () => {
    if (step.kind !== "match") return;
    const { built } = step;
    onClose();
    void coordinator.continueImport(importId, built);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[min(90svh,40rem)] max-w-lg flex-col gap-4"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement)
            .querySelector<HTMLElement>("button[data-first], button[data-primary]")
            ?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-lg leading-tight font-semibold tracking-tight">
            <Trans>Continue import</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Choose {names} again, as it was when the import started.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" {...picker.drag.props}>
          {picker.inputs}
          {reader.state.status !== "ready" ? (
            <PickZone state={reader.state} picker={picker} />
          ) : null}
          {step.kind === "checking" ? (
            <div role="status" className="grid gap-2">
              <p className="text-sm text-foreground">
                {plural(step.files, { one: "Checking # file…", other: "Checking # files…" })}
              </p>
              <Progress label={t`Checking`} value={step.percent} className="h-1.5" />
            </div>
          ) : null}
          {step.kind === "match" ? (
            <p role="status" className="text-sm text-foreground">
              {plural(step.send, {
                one: "# file hasn't arrived yet.",
                other: "# files haven't arrived yet.",
              })}
            </p>
          ) : null}
          {step.kind === "mismatch" ? (
            <div className="grid gap-2">
              <InlineErrorRow
                wrap
                message={t`This isn't the same selection. ${differenceSentence(step.difference)}`}
              />
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={picker.chooseAgain}>
                  <Trans>Choose again</Trans>
                </Button>
              </div>
            </div>
          ) : null}
          {step.kind === "failed" ? (
            <InlineErrorRow
              message={t`Couldn't check the selection. Try again.`}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline" className="[@media(pointer:coarse)]:min-h-11">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button
            type="button"
            data-primary
            aria-disabled={step.kind !== "match"}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
            onClick={send}
          >
            {step.kind === "match"
              ? plural(step.send, { one: "Send # file", other: "Send # files" })
              : t`Send`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
