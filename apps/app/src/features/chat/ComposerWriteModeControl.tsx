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
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { UpdateWorkWriteModeResponse, Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type ReactNode, type Ref, useId, useRef, useState } from "react";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useUpdateWorkWriteMode } from "@/client/query/useWorks";
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

import { activeDockedDraftGroups } from "./docked-drafts";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

/** Binds the presentation control to the Work resolved for the active thread. */
export function ComposerWriteModeControl({ projectId, work }: { projectId: string; work: Work }) {
  const updateWriteMode = useUpdateWorkWriteMode(projectId, work.id);
  const workDrafts = useWorkDrafts(projectId, work.id);
  const { openAiDraft } = useAiDraftLauncher();
  const draftsLoaded = workDrafts.groups !== null;
  const pendingGroups = activeDockedDraftGroups(workDrafts.groups);
  const firstPendingGroup =
    [...pendingGroups]
      .sort((left, right) =>
        (left.documentName ?? left.documentId)
          .toLowerCase()
          .localeCompare((right.documentName ?? right.documentId).toLowerCase()),
      )
      .at(0) ?? null;
  const firstPendingDraft = firstPendingGroup?.drafts[0] ?? null;

  return (
    <AiWriteModeControl
      value={work.aiWriteMode}
      disabled={updateWriteMode.isPending || !draftsLoaded}
      pendingChangeCount={draftsLoaded ? pendingGroups.length : null}
      reviewChangesAvailable={draftsLoaded ? firstPendingDraft !== null : null}
      onSelectDraft={() => updateWriteMode.mutate("draft")}
      onReviewChanges={() => {
        if (!firstPendingGroup || !firstPendingDraft) return;
        openAiDraft(
          {
            documentId: firstPendingGroup.documentId,
            contextPath: firstPendingGroup.contextPath ?? undefined,
            documentName: firstPendingGroup.documentName ?? undefined,
            isNewDocument: firstPendingDraft.isNewDocument === true,
          },
          firstPendingDraft.draftId,
        );
      }}
      onRequestAutoApply={(confirmedPush) =>
        updateWriteMode
          .mutateAsync(
            confirmedPush
              ? { aiWriteMode: "direct", confirmedPush: true }
              : { aiWriteMode: "direct" },
          )
          .catch(() => null)
      }
    />
  );
}

function AiWriteModeControl({
  value,
  disabled,
  pendingChangeCount,
  reviewChangesAvailable,
  onSelectDraft,
  onReviewChanges,
  onRequestAutoApply,
}: {
  value: AiWriteMode;
  disabled: boolean;
  /**
   * Content-aware pending document count shared with the dock. This is only a
   * fast path for opening the popover while the server request determines the
   * authoritative reviewable Work-draft count.
   */
  pendingChangeCount: number | null;
  reviewChangesAvailable: boolean | null;
  onSelectDraft: () => void;
  onReviewChanges: () => void;
  /**
   * Requests Auto-apply with or without explicit writer confirmation. The
   * unconfirmed response either completes a zero-pending switch or vends the
   * authoritative count; only the popover action passes `true`.
   */
  onRequestAutoApply: (confirmedPush: boolean) => Promise<UpdateWorkWriteModeResponse | null>;
}) {
  const groupName = useId();
  const autoApplyRef = useRef<HTMLInputElement>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);
  const [serverPendingCount, setServerPendingCount] = useState<number | null>(null);

  const selectAutoApply = async () => {
    if (applying) return;
    // The client count is only a fast path for showing the pending UI. The
    // unconfirmed request is always sent, even when this cache says zero; only
    // the server may decide that there is nothing requiring confirmation.
    if (value === "draft" && (pendingChangeCount ?? 0) > 0) {
      setPushFailed(false);
      setServerPendingCount(null);
      setConfirmOpen(true);
    }
    setApplying(true);
    const result = await onRequestAutoApply(false);
    setApplying(false);
    if (result?.status === "confirmation_required") {
      setServerPendingCount(result.pendingChangeCount);
      setConfirmOpen(true);
    } else if (result?.status === "updated") {
      setConfirmOpen(false);
    } else if (confirmOpen || (pendingChangeCount ?? 0) > 0) {
      setPushFailed(true);
    }
  };

  const confirmApplyAndSwitch = async () => {
    setApplying(true);
    setPushFailed(false);
    const result = await onRequestAutoApply(true);
    setApplying(false);
    if (result?.status === "updated") {
      setConfirmOpen(false);
    } else if (result?.status === "confirmation_required") {
      setServerPendingCount(result.pendingChangeCount);
      setPushFailed(true);
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

  const reviewChanges = () => {
    if (applying) return;
    setConfirmOpen(false);
    setPushFailed(false);
    onReviewChanges();
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
            onSelect={onSelectDraft}
            description={
              value === "draft" && pendingChangeCount !== null && pendingChangeCount > 0
                ? t`${pendingChangeCount} changes waiting for review`
                : undefined
            }
          >
            <Trans>Draft</Trans>
            {value === "draft" && pendingChangeCount !== null && pendingChangeCount > 0 ? (
              <span className="ml-1 rounded-full bg-primary/15 px-1 text-[10px] tabular-nums text-jade-text">
                ({pendingChangeCount})
              </span>
            ) : null}
          </AiWriteModeOption>
          {/* Anchor the warning to the consequential choice that opened it. */}
          <PopoverAnchor asChild>
            <AiWriteModeOption
              name={groupName}
              value="direct"
              selected={value === "direct"}
              disabled={false}
              inputRef={autoApplyRef}
              onSelect={() => void selectAutoApply()}
            >
              <Trans>Auto-apply</Trans>
            </AiWriteModeOption>
          </PopoverAnchor>
        </div>
        <PopoverContent
          align="start"
          side="top"
          className="w-72"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            autoApplyRef.current?.focus();
          }}
        >
          <PopoverHeader>
            <PopoverTitle>
              <Trans>Drafts are waiting</Trans>
            </PopoverTitle>
            {pushFailed ? (
              <p className="text-caption text-destructive" role="alert">
                <Trans>Couldn't apply everything. Nothing changed, so you're still in Draft.</Trans>
              </p>
            ) : serverPendingCount == null ? (
              <PopoverDescription className="text-caption">
                <Trans>Checking pending changes…</Trans>
              </PopoverDescription>
            ) : (
              <PopoverDescription className="text-caption">
                <Trans>
                  This Work has{" "}
                  <Plural value={serverPendingCount} one="# AI change" other="# AI changes" /> in
                  draft. Auto-apply stays off until every draft is applied or discarded.
                </Trans>
              </PopoverDescription>
            )}
          </PopoverHeader>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={applying} onClick={closeConfirm}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={applying || reviewChangesAvailable !== true}
              onClick={reviewChanges}
            >
              {reviewChangesAvailable === null ? (
                <Trans>Checking pending changes…</Trans>
              ) : (
                <Trans>Review changes</Trans>
              )}
            </Button>
            <Button
              size="sm"
              disabled={applying || serverPendingCount == null}
              onClick={() => void confirmApplyAndSwitch()}
            >
              {applying ? (
                <Trans>Applying…</Trans>
              ) : (
                <Plural
                  value={serverPendingCount ?? 0}
                  one="Apply # change and switch"
                  other="Apply # changes and switch"
                />
              )}
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
  inputRef,
  description,
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
  inputRef?: Ref<HTMLInputElement>;
  description?: string;
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
        ref={inputRef}
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        aria-description={description}
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
