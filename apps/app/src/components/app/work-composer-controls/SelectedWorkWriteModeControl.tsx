/** Selected-Work write-mode control shared by new and existing chat composers. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type {
  PendingChangesChoice,
  UpdateWorkWriteModeResponse,
  Work,
} from "@meridian/contracts/protocol";
import { type AiWriteMode, isWorkArchived } from "@meridian/contracts/works";
import { type RefObject, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { useUpdateWorkWriteMode, useWorkDrafts } from "@/client/query/useWorkDrafts";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
  type ComposerToolbarPanelContext,
} from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";

/**
 * The confirmation page's lifecycle. `checking` waits for the server's count,
 * `submitting` carries the writer's choice, `failed` keeps it for the retry,
 * and `archivedMidway` is a refused Apply because the Work was archived while
 * the switch ran.
 */
type ConfirmationPhase = "checking" | "ready" | "submitting" | "failed" | "archivedMidway";

/**
 * A plain switch (nothing pending locally) stays on the choices page, failure
 * included. The confirmation page always has a count: the local one until the
 * server's arrives, so a failed first check still names what is pending.
 */
type WriteModeInteraction =
  | { workId: string; page: "choices"; phase: "idle" | "switching" | "failed" }
  | {
      workId: string;
      page: "confirmation";
      phase: ConfirmationPhase;
      count: number;
      choice: PendingChangesChoice | null;
    };

const choices = (workId: string): WriteModeInteraction => ({
  workId,
  page: "choices",
  phase: "idle",
});

export function useSelectedWorkWriteModeToolbarControl({
  projectId,
  work,
}: {
  projectId: string;
  work: Work;
}): ComposerToolbarControl {
  const update = useUpdateWorkWriteMode(projectId, work.id);
  const drafts = useWorkDrafts(projectId, work.id);
  const files = drafts.files ?? [];
  const draftRef = useRef<HTMLButtonElement | null>(null);
  const directRef = useRef<HTMLButtonElement | null>(null);
  const applyRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [interaction, setInteraction] = useState<WriteModeInteraction>(() => choices(work.id));
  if (interaction.workId !== work.id) setInteraction(choices(work.id));
  const confirmation = interaction.page === "confirmation" ? interaction : null;
  const requesting =
    interaction.phase === "switching" ||
    interaction.phase === "checking" ||
    interaction.phase === "submitting";
  const archived = isWorkArchived(work) || confirmation?.phase === "archivedMidway";
  const loaded = drafts.files !== null;
  const requestAuto = async (
    choice: PendingChangesChoice | null,
    settle: (outcome: "close" | "stay") => void,
  ) => {
    if (requesting) return;
    const confirming = confirmation !== null || files.length > 0;
    const confirm = (
      phase: ConfirmationPhase,
      count = confirmation?.count ?? files.length,
    ): WriteModeInteraction => ({ workId: work.id, page: "confirmation", phase, count, choice });
    setInteraction(
      confirming
        ? confirm(choice === null ? "checking" : "submitting")
        : { workId: work.id, page: "choices", phase: "switching" },
    );
    const outcome = await update
      .mutateAsync(
        choice === null ? { aiWriteMode: "direct" } : { aiWriteMode: "direct", pending: choice },
      )
      .then(
        (result: UpdateWorkWriteModeResponse) => result,
        (cause: unknown) =>
          isMeridianApiError(cause) && cause.code === "work_archived"
            ? ("archived" as const)
            : ("failed" as const),
      );
    if (outcome === "archived" || outcome === "failed") {
      setInteraction(
        confirming
          ? confirm(outcome === "archived" ? "archivedMidway" : "failed")
          : { workId: work.id, page: "choices", phase: "failed" },
      );
      settle("stay");
    } else if (outcome.status === "updated") {
      setInteraction(choices(work.id));
      settle("close");
    } else {
      // A chosen request that still asks for confirmation didn't take the choice.
      setInteraction(confirm(choice === null ? "ready" : "failed", outcome.pendingChangeCount));
      settle("stay");
    }
  };
  const chooseDraft = (terminalClose: () => void) => {
    update.mutate({ aiWriteMode: "draft" });
    setInteraction(choices(work.id));
    terminalClose();
  };
  const close = (terminalClose: () => void) => {
    if (requesting) return;
    terminalClose();
    setInteraction(choices(work.id));
  };
  const value = work.aiWriteMode;
  const choicesDisabled = update.isPending || requesting;
  const localizedValue = value === "draft" ? t`Draft` : t`Auto-apply`;
  const failed = confirmation?.phase === "failed";
  const pageId = writeModePageId(confirmation?.phase ?? null, archived);
  const focus =
    confirmation === null
      ? {
          pageId,
          repairRevision: [value, loaded, choicesDisabled, files.length].join(":"),
          candidates: [
            ...(value === "draft" && loaded && !choicesDisabled
              ? [{ key: "selected:draft", ref: draftRef }]
              : value === "direct" && !choicesDisabled
                ? [{ key: "selected:direct", ref: directRef }]
                : []),
            ...(!choicesDisabled ? [{ key: "first:direct", ref: directRef }] : []),
          ],
          fallback: "content" as const,
        }
      : {
          pageId,
          repairRevision: [confirmation.phase, confirmation.count, archived].join(":"),
          // Keep is the choice that changes nothing already written, so it takes
          // focus first; after a failed Apply, focus stays on the retry.
          candidates:
            failed && confirmation.choice === "apply" && !archived
              ? [
                  { key: "apply", ref: applyRef },
                  { key: "cancel", ref: cancelRef },
                ]
              : [
                  { key: "keep", ref: keepRef },
                  { key: "cancel", ref: cancelRef },
                ],
          fallback: "content" as const,
        };
  const panelBody = (context: ComposerToolbarPanelContext) => {
    if (confirmation === null) {
      return (
        <WriteModeChoices
          value={value}
          disabled={choicesDisabled}
          failed={interaction.phase === "failed"}
          loaded={loaded}
          pending={loaded ? files.length : null}
          draftRef={draftRef}
          directRef={directRef}
          onDraft={() => chooseDraft(context.terminalClose)}
          onAuto={() => {
            // Already auto-apply: there is nothing to switch, even with kept changes.
            if (value === "direct") return close(context.terminalClose);
            const lock = context.beginBlocking();
            if (lock.kind === "started") void requestAuto(null, lock.settle);
          }}
        />
      );
    }
    const choose = (choice: PendingChangesChoice) => {
      const lock = context.beginBlocking();
      if (lock.kind === "started") void requestAuto(choice, lock.settle);
    };
    return (
      <Confirmation
        work={work}
        archived={archived}
        phase={confirmation.phase}
        choice={confirmation.choice}
        count={confirmation.count}
        applyRef={applyRef}
        keepRef={keepRef}
        cancelRef={cancelRef}
        onCancel={() => close(context.terminalClose)}
        onApply={() => choose("apply")}
        onKeep={() => choose("keep")}
      />
    );
  };
  return {
    kind: "panel",
    id: "write-mode",
    priority: 200,
    interaction: update.isPending || requesting ? "busy" : "enabled",
    item: {
      ariaLabel: t`AI write mode: ${localizedValue}`,
      label: <Trans>Write mode</Trans>,
      value: localizedValue,
    },
    inline: ({ trigger }) => (
      <ComposerCurrentValueTrigger
        binding={trigger}
        ariaLabel={t`AI write mode: ${localizedValue}`}
      >
        {localizedValue}
      </ComposerCurrentValueTrigger>
    ),
    panel: {
      ariaLabel: t`AI write mode`,
      size: "compact",
      focus,
      render: panelBody,
    },
  };
}

/**
 * Checking is its own page so the arriving count enters the dialog and
 * focuses its first choice instead of leaving focus on the dialog itself.
 */
function writeModePageId(phase: ConfirmationPhase | null, archived: boolean): string {
  if (phase === null) return "choices";
  if (phase === "checking") return "confirmation-checking";
  if (archived) return "confirmation-archived";
  return phase === "failed" ? "confirmation-error" : "confirmation";
}

function WriteModeChoices({
  value,
  disabled,
  failed,
  loaded,
  pending,
  draftRef,
  directRef,
  onDraft,
  onAuto,
}: {
  value: AiWriteMode;
  disabled: boolean;
  /** The last plain switch failed; the writer is still in Draft. */
  failed: boolean;
  loaded: boolean;
  pending: number | null;
  draftRef: RefObject<HTMLButtonElement | null>;
  directRef: RefObject<HTMLButtonElement | null>;
  onDraft(): void;
  onAuto(): void;
}) {
  return (
    <>
      <div
        role="radiogroup"
        aria-label={t`AI write mode`}
        className="space-y-[var(--chat-space-row)]"
      >
        <Button
          ref={draftRef}
          role="radio"
          aria-checked={value === "draft"}
          variant="ghost"
          className={dropdownRowVariants({ selected: value === "draft" })}
          disabled={disabled || !loaded}
          onClick={onDraft}
        >
          <span className="min-w-0 flex-1 text-left">
            <Trans>Draft</Trans>
          </span>
          {pending ? <span className="shrink-0">({pending})</span> : null}
        </Button>
        <Button
          ref={directRef}
          role="radio"
          aria-checked={value === "direct"}
          variant="ghost"
          className={dropdownRowVariants({ selected: value === "direct" })}
          disabled={disabled}
          onClick={onAuto}
        >
          <Trans>Auto-apply</Trans>
        </Button>
      </div>
      {failed ? (
        <p
          className="mt-[var(--chat-space-inline)] px-[var(--chat-space-inline)] text-caption text-destructive"
          role="alert"
        >
          <Trans>Couldn't switch, so you're still in Draft.</Trans>
        </p>
      ) : null}
    </>
  );
}

/**
 * D40's switch dialog. Mode and pending changes are separate: the writer
 * applies them now or keeps them for review. An archived Work's draft is
 * frozen, so keeping them is the only choice and the copy says why.
 */
function Confirmation({
  work,
  archived,
  phase,
  choice,
  count,
  applyRef,
  keepRef,
  cancelRef,
  onCancel,
  onApply,
  onKeep,
}: {
  work: Work;
  archived: boolean;
  phase: ConfirmationPhase;
  choice: PendingChangesChoice | null;
  count: number;
  applyRef: RefObject<HTMLButtonElement | null>;
  keepRef: RefObject<HTMLButtonElement | null>;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onCancel(): void;
  onApply(): void;
  onKeep(): void;
}) {
  const busy = phase === "checking" || phase === "submitting";
  const name = work.name;
  return (
    <div className="px-[var(--chat-space-inline)]">
      <h2 className="font-semibold">
        {work.isNoWork ? (
          <Trans>
            Switch to <span className="whitespace-nowrap">auto-apply?</span>
          </Trans>
        ) : (
          <Trans>
            Switch {name} to <span className="whitespace-nowrap">auto-apply?</span>
          </Trans>
        )}
      </h2>
      {phase === "failed" ? (
        <p className="mt-[var(--chat-space-inline)] text-caption text-destructive" role="alert">
          {choice === "apply" ? (
            <Trans>Couldn't apply every change, so you're still in Draft.</Trans>
          ) : (
            <Trans>Couldn't switch, so you're still in Draft.</Trans>
          )}
        </p>
      ) : phase === "archivedMidway" ? (
        <p className="mt-[var(--chat-space-inline)] text-caption text-destructive" role="alert">
          <Trans>{name} was archived during the switch, so you're still in Draft.</Trans>
        </p>
      ) : null}
      <p className="mt-[var(--chat-space-inline)] text-caption text-muted-foreground">
        {phase === "checking" ? (
          <Trans>Checking pending changes…</Trans>
        ) : (
          <SwitchSummary work={work} archived={archived} count={count} />
        )}
      </p>
      <div className="mt-[var(--chat-space-block)] flex flex-col gap-[var(--chat-space-inline)]">
        {archived ? (
          <Button ref={keepRef} size="sm" disabled={busy} onClick={onKeep}>
            {phase === "submitting" ? <Trans>Switching…</Trans> : <Trans>Switch</Trans>}
          </Button>
        ) : (
          <>
            <Button ref={applyRef} size="sm" disabled={busy} onClick={onApply}>
              {phase === "submitting" && choice === "apply" ? (
                <Trans>Applying…</Trans>
              ) : (
                <Plural value={count} one="Apply it now" other="Apply them now" />
              )}
            </Button>
            <Button ref={keepRef} variant="secondary" size="sm" disabled={busy} onClick={onKeep}>
              {phase === "submitting" && choice === "keep" ? (
                <Trans>Switching…</Trans>
              ) : (
                <Plural value={count} one="Keep it for review" other="Keep them for review" />
              )}
            </Button>
          </>
        )}
        <Button ref={cancelRef} variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

/** The dialog's body: what is pending, and where AI changes go after the switch. */
function SwitchSummary({
  work,
  archived,
  count,
}: {
  work: Work;
  archived: boolean;
  count: number;
}) {
  const name = work.name;
  if (archived) {
    return (
      <Plural
        value={count}
        one={`${name} is archived, so its # pending change stays frozen. Unarchive it to review that change. AI changes to project files will go live right away.`}
        other={`${name} is archived, so its # pending changes stay frozen. Unarchive it to review them. AI changes to project files will go live right away.`}
      />
    );
  }
  return work.isNoWork ? (
    <Trans>
      You have <Plural value={count} one="# pending change" other="# pending changes" /> waiting for
      review. From now on, AI changes go live right away.
    </Trans>
  ) : (
    <Trans>
      {name} has <Plural value={count} one="# pending change" other="# pending changes" /> waiting
      for review. From now on, AI changes go live right away.
    </Trans>
  );
}
