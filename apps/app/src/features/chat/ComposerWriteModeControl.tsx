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

import { pendingDockedDraftCount } from "./docked-drafts";

/** Binds the presentation control to the Work resolved for the active thread. */
export function ComposerWriteModeControl({ projectId, work }: { projectId: string; work: Work }) {
  const updateWriteMode = useUpdateWorkWriteMode(projectId, work.id);
  const workDrafts = useWorkDrafts(projectId, work.id);

  return (
    <AiWriteModeControl
      value={work.aiWriteMode}
      disabled={updateWriteMode.isPending || workDrafts.groups == null}
      pendingChangeCount={pendingDockedDraftCount(workDrafts.groups)}
      onSelectDraft={() => updateWriteMode.mutate("draft")}
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
  onSelectDraft,
  onRequestAutoApply,
}: {
  value: AiWriteMode;
  disabled: boolean;
  /**
   * Content-aware pending document count shared with the dock. This is only a
   * fast path for opening the popover while the server request determines the
   * authoritative journal-row count.
   */
  pendingChangeCount: number | null;
  onSelectDraft: () => void;
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
              <Trans>Switch to Auto-apply?</Trans>
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
                  This applies all{" "}
                  <Plural
                    value={serverPendingCount}
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
            <Button
              size="sm"
              disabled={applying || serverPendingCount == null}
              onClick={() => void confirmApplyAndSwitch()}
            >
              {applying ? (
                <Trans>Applying…</Trans>
              ) : (
                <Trans>Apply {serverPendingCount ?? 0} and switch</Trans>
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
