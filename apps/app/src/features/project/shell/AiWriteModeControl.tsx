/**
 * AiWriteModeControl — the nav-rail radio that picks how AI edits land: Draft
 * (accumulate on the work branch for review) or Auto-apply (push straight to
 * the manuscript). Switching Draft → Auto-apply while pending changes exist is
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
import type { AiWriteMode } from "@meridian/contracts/works";
import { FilePen } from "lucide-react";
import { type ReactNode, type Ref, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

export type AiWriteModePresentation = "desktop" | "phone";

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
  presentation,
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
  presentation: AiWriteModePresentation;
  onChange: (value: AiWriteMode) => void;
  /**
   * Runs the confirm-and-push: server pushes the pending changes, then flips
   * `pushPolicy='auto'`, in that order (§3.4). Resolves `true` on success (mode
   * is now Auto-apply), `false` if the push failed and the writer stays in
   * Draft.
   */
  onApplyAndSwitch: () => Promise<boolean>;
}) {
  const phone = presentation === "phone";
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
    <fieldset
      className={cn(
        "min-w-0 shrink-0 border-0 border-t border-border-subtle",
        phone ? "px-3 py-3" : "mt-2 px-3 pt-2",
      )}
    >
      <legend className="visually-hidden">
        <Trans>AI write mode</Trans>
      </legend>
      <div className="mb-1.5 flex items-center gap-1.5 text-ink-muted">
        <FilePen className="size-3.5" aria-hidden />
        <SectionLabel>
          <Trans>AI write mode</Trans>
        </SectionLabel>
      </div>
      <Popover
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
      >
        <div className={cn("grid gap-1", phone ? "grid-cols-1" : "grid-cols-2")}>
          <AiWriteModeOption
            name={groupName}
            value="draft"
            selected={value === "draft"}
            disabled={disabled}
            phone={phone}
            onSelect={() => onChange("draft")}
          >
            <Trans>Draft</Trans>
          </AiWriteModeOption>
          {/* The popover anchors on the Auto-apply option so the confirm points
              back at the gesture that triggered it. */}
          <PopoverAnchor asChild>
            <AiWriteModeOption
              name={groupName}
              value="direct"
              selected={value === "direct"}
              disabled={disabled}
              phone={phone}
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
                  <Plural value={pendingCount} one="# pending change" other="# pending changes" />{" "}
                  to your manuscript now. After that, new AI edits apply on their own.
                </Trans>
              </PopoverDescription>
            )}
          </PopoverHeader>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={applying} onClick={closeConfirm}>
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" disabled={applying} onClick={() => void confirmApplyAndSwitch()}>
              {applying ? (
                <Trans>Applying…</Trans>
              ) : (
                // The count on the button reinforces the scope (product call
                // 2026-07-05); it is the same server-vended N the copy shows.
                <Trans>Apply {pendingCount} and switch</Trans>
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
  phone,
  onSelect,
  children,
  ref,
  ...anchorProps
}: {
  name: string;
  value: AiWriteMode;
  selected: boolean;
  disabled: boolean;
  phone: boolean;
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
        "focus-within:focus-ring rounded-md",
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
          "block rounded-md border border-border-subtle px-2 text-left text-xs leading-snug transition-colors",
          phone ? "min-h-11 py-2.5" : "py-1.5",
          // Unselected chips stay TRANSPARENT on the rail field (hairline
          // only) so the control reads on both the lacquered shelf (cream
          // remap) and the phone drawer's chrome — a bright card fill here
          // would be light-on-light under the shelf re-theme.
          selected
            ? "bg-sidebar-accent font-medium text-foreground"
            : "text-ink-muted hover:border-border-focus hover:bg-sidebar-accent/40 hover:text-foreground",
          disabled && "opacity-60",
        )}
      >
        {children}
      </span>
    </label>
  );
}
