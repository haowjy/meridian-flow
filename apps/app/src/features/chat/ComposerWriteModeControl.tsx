/**
 * ComposerWriteModeControl — the compact composer control for how AI edits in
 * this conversation's Work land: Draft (accumulate for review) or Auto-apply
 * (push straight to the manuscript). Switching while pending changes exist is
 * consequential — the server pushes every pending change first — so it confirms
 * through a popover anchored on the Auto-apply option (spec §3.4, "confirm and
 * push").
 *
 * The confirmation is advisory, not the safety mechanism: enforcement is
 * server-side (the client-only mode-lock was deleted). The error state reflects
 * the §3.4 guarantee honestly — policy flips only after the pushes commit, so a
 * failed push leaves the writer in Draft with nothing changed.
 */
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type ReactNode, type Ref, useId, useState } from "react";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useUpdateWorkWriteMode, useWorks } from "@/client/query/useWorks";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { pendingDockedDraftCount } from "./docked-drafts";

export function contextWork(works: Work[] | null, workId: string): Work | null {
  return works?.find((candidate) => candidate.id === workId) ?? null;
}

/** Binds the presentation control to the Work resolved for the active thread. */
export function ComposerWriteModeControl({
  projectId,
  workId,
}: {
  projectId: string;
  workId: string;
}) {
  const { works } = useWorks(projectId);
  const work = contextWork(works, workId);
  const updateWriteMode = useUpdateWorkWriteMode(projectId, workId);
  const workDrafts = useWorkDrafts(projectId, workId);

  if (!work) return null;

  return (
    <AiWriteModeControl
      value={work.aiWriteMode}
      disabled={updateWriteMode.isPending || workDrafts.groups == null}
      pendingChangeCount={pendingDockedDraftCount(workDrafts.groups)}
      onChange={(aiWriteMode) =>
        updateWriteMode.mutate(
          aiWriteMode === "direct" ? { aiWriteMode, confirmedPush: true } : aiWriteMode,
        )
      }
      onApplyAndSwitch={() =>
        // The server pushes the whole work branch before changing the policy.
        // Any non-updated result leaves the writer in Draft.
        new Promise<boolean>((resolve) => {
          updateWriteMode.mutate(
            { aiWriteMode: "direct", confirmedPush: true },
            {
              onSuccess: (result) => resolve(result.status === "updated"),
              onError: () => resolve(false),
            },
          );
        })
      }
    />
  );
}

/**
 * The confirm-and-push count the writer sees. Its caller derives this from the
 * same content-aware draft groups as the dock, so an empty dock cannot coexist
 * with a warning about invisible changes. `null` collapses to 0.
 */
export function confirmPushCount(pendingChangeCount: number | null): number {
  return pendingChangeCount ?? 0;
}

/**
 * Whether clicking Auto-apply must confirm-and-push rather than flip silently:
 * only when leaving Draft with pending changes (§3.4). N = 0 is a free flip.
 */
export function shouldConfirmPush(value: AiWriteMode, pendingChangeCount: number | null): boolean {
  return value === "draft" && confirmPushCount(pendingChangeCount) > 0;
}

export function AiWriteModeControl({
  value,
  disabled,
  pendingChangeCount,
  onChange,
  onApplyAndSwitch,
}: {
  value: AiWriteMode;
  disabled: boolean;
  /**
   * Content-aware pending document count shared with the dock. `null` is
   * treated as no pending changes and permits a silent switch.
   */
  pendingChangeCount: number | null;
  onChange: (value: AiWriteMode) => void;
  /**
   * Runs the confirm-and-push: server pushes the pending changes, then flips
   * `pushPolicy='auto'`, in that order (§3.4). Resolves `true` on success (mode
   * is now Auto-apply), `false` if the push failed and the writer stays in
   * Draft.
   */
  onApplyAndSwitch: () => Promise<boolean>;
}) {
  const groupName = useId();
  const pendingCount = confirmPushCount(pendingChangeCount);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);

  const selectAutoApply = () => {
    // N = 0 is a free, silent flip (§3.4). Only pending changes need the
    // confirm-and-push, and only when leaving Draft.
    if (shouldConfirmPush(value, pendingChangeCount)) {
      setPushFailed(false);
      setConfirmOpen(true);
      return;
    }
    onChange("direct");
  };

  const confirmApplyAndSwitch = async () => {
    setApplying(true);
    setPushFailed(false);
    const ok = await onApplyAndSwitch();
    setApplying(false);
    if (ok) {
      setConfirmOpen(false);
    } else {
      // Policy did not flip (§3.4) — keep the popover open and tell the truth.
      setPushFailed(true);
    }
  };

  const closeConfirm = () => {
    if (applying) return;
    setConfirmOpen(false);
    setPushFailed(false);
  };

  return (
    <fieldset className="min-w-0 shrink-0 border-0">
      <legend className="visually-hidden">
        <Trans>AI write mode</Trans>
      </legend>
      <Popover
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
      >
        <div className="flex items-center rounded-lg bg-foreground/6 p-0.5">
          <AiWriteModeOption
            name={groupName}
            value="draft"
            selected={value === "draft"}
            disabled={disabled}
            onSelect={() => onChange("draft")}
          >
            <Trans>Draft</Trans>
          </AiWriteModeOption>
          {/* Anchor the warning to the consequential choice that opened it. */}
          <PopoverAnchor asChild>
            <AiWriteModeOption
              name={groupName}
              value="direct"
              selected={value === "direct"}
              disabled={disabled}
              onSelect={selectAutoApply}
            >
              <Trans>Auto-apply</Trans>
            </AiWriteModeOption>
          </PopoverAnchor>
        </div>
        <PopoverContent align="start" side="top" className="w-72">
          <PopoverHeader>
            <PopoverTitle>
              <Trans>Switch to Auto-apply?</Trans>
            </PopoverTitle>
            {pushFailed ? (
              <p className="text-caption text-destructive" role="alert">
                <Trans>Couldn't apply everything. Nothing changed, so you're still in Draft.</Trans>
              </p>
            ) : (
              <PopoverDescription className="text-caption">
                <Trans>
                  This applies all{" "}
                  <Plural
                    value={pendingCount}
                    one="# pending draft change"
                    other="# pending draft changes"
                  />{" "}
                  to the live manuscript now. After that, new AI edits apply automatically.
                </Trans>
              </PopoverDescription>
            )}
          </PopoverHeader>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={applying} onClick={closeConfirm}>
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" disabled={applying} onClick={() => void confirmApplyAndSwitch()}>
              {applying ? <Trans>Applying…</Trans> : <Trans>Apply {pendingCount} and switch</Trans>}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </fieldset>
  );
}

function AiWriteModeOption({
  name,
  value,
  selected,
  disabled,
  onSelect,
  children,
  ref,
  ...anchorProps
}: {
  name: string;
  value: AiWriteMode;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: AiWriteMode) => void;
  children: ReactNode;
  // Threaded so `PopoverAnchor asChild` can attach to the label DOM node and
  // position the confirm popover on the option itself.
  ref?: Ref<HTMLLabelElement>;
}) {
  return (
    <label
      ref={ref}
      className={cn(
        "focus-within:focus-ring rounded-[calc(var(--radius-lg)-2px)]",
        disabled ? "cursor-default" : "cursor-pointer",
      )}
      {...anchorProps}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="visually-hidden"
      />
      <span
        className={cn(
          "block h-7 rounded-[calc(var(--radius-lg)-2px)] px-2 text-xs leading-7 transition-colors",
          selected
            ? "bg-background font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
          disabled && "opacity-60",
        )}
      >
        {children}
      </span>
    </label>
  );
}
