/** Selected-Work write-mode control shared by new and existing chat composers. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { UpdateWorkWriteModeResponse, Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type RefObject, useRef, useState } from "react";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useUpdateWorkWriteMode } from "@/client/query/useWorks";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
  type ComposerToolbarPanelContext,
} from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";

type WriteModeInteraction =
  | { workId: string; page: "choices"; phase: "idle" | "applying" }
  | {
      workId: string;
      page: "confirmation";
      phase: "checking" | "ready" | "applying" | "error";
      count: number | null;
    };

const choices = (workId: string): WriteModeInteraction => ({
  workId,
  page: "choices",
  phase: "idle",
});

export function useSelectedWorkWriteModeToolbarControl({
  projectId,
  work,
  openDraftReview,
}: {
  projectId: string;
  work: Work;
  openDraftReview: (
    group: {
      documentId: string;
      contextPath?: string;
      documentName?: string;
      isNewDocument?: boolean;
    },
    draftId: string,
  ) => void;
}): ComposerToolbarControl {
  const update = useUpdateWorkWriteMode(projectId, work.id);
  const drafts = useWorkDrafts(projectId, work.id);
  const groups = activeWorkDraftGroups(drafts.groups);
  const firstGroup =
    [...groups]
      .sort((a, b) =>
        (a.documentName ?? a.documentId).localeCompare(b.documentName ?? b.documentId),
      )
      .at(0) ?? null;
  const firstDraft = firstGroup?.drafts[0] ?? null;
  const draftRef = useRef<HTMLButtonElement | null>(null);
  const directRef = useRef<HTMLButtonElement | null>(null);
  const reviewRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [interaction, setInteraction] = useState<WriteModeInteraction>(() => choices(work.id));
  if (interaction.workId !== work.id) setInteraction(choices(work.id));
  const applying = interaction.phase === "applying" || interaction.phase === "checking";
  const failed = interaction.page === "confirmation" && interaction.phase === "error";
  const serverCount = interaction.page === "confirmation" ? interaction.count : null;
  const loaded = drafts.groups !== null;
  const requestAuto = async (confirmed: boolean, settle: (outcome: "close" | "stay") => void) => {
    if (applying) return;
    const localConfirmation = !confirmed && work.aiWriteMode === "draft" && groups.length > 0;
    setInteraction(
      confirmed
        ? {
            workId: work.id,
            page: "confirmation",
            phase: "applying",
            count: serverCount,
          }
        : localConfirmation
          ? { workId: work.id, page: "confirmation", phase: "checking", count: null }
          : { workId: work.id, page: "choices", phase: "applying" },
    );
    const result: UpdateWorkWriteModeResponse | null = await update
      .mutateAsync(
        confirmed ? { aiWriteMode: "direct", confirmedPush: true } : { aiWriteMode: "direct" },
      )
      .catch(() => null);
    if (result?.status === "updated") {
      setInteraction(choices(work.id));
      settle("close");
    } else if (result?.status === "confirmation_required") {
      setInteraction({
        workId: work.id,
        page: "confirmation",
        phase: confirmed ? "error" : "ready",
        count: result.pendingChangeCount,
      });
      settle("stay");
    } else {
      setInteraction({
        workId: work.id,
        page: "confirmation",
        phase: "error",
        count: serverCount,
      });
      settle("stay");
    }
  };
  const chooseDraft = (terminalClose: () => void) => {
    update.mutate("draft");
    setInteraction(choices(work.id));
    terminalClose();
  };
  const review = (terminalClose: () => void) => {
    if (!firstGroup || !firstDraft || applying) return;
    terminalClose();
    openDraftReview(
      {
        documentId: firstGroup.documentId,
        contextPath: firstGroup.contextPath ?? undefined,
        documentName: firstGroup.documentName ?? undefined,
        isNewDocument: firstDraft.isNewDocument === true,
      },
      firstDraft.draftId,
    );
  };
  const close = (terminalClose: () => void) => {
    if (applying) return;
    terminalClose();
    setInteraction(choices(work.id));
  };
  const value = work.aiWriteMode;
  const choicesDisabled = update.isPending || applying;
  const localizedValue = value === "draft" ? t`Draft` : t`Auto-apply`;
  const pageId =
    interaction.page === "choices" ? "choices" : failed ? "confirmation-error" : "confirmation";
  const focus =
    interaction.page === "choices"
      ? {
          pageId,
          repairRevision: [value, loaded, choicesDisabled, groups.length].join(":"),
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
          repairRevision: [applying, serverCount, firstDraft !== null, failed].join(":"),
          candidates: failed
            ? [
                { key: "confirm", ref: confirmRef },
                { key: "cancel", ref: cancelRef },
              ]
            : [
                { key: "review", ref: reviewRef },
                { key: "cancel", ref: cancelRef },
                { key: "confirm", ref: confirmRef },
              ],
          fallback: "content" as const,
        };
  const panelBody = (context: ComposerToolbarPanelContext) =>
    interaction.page === "confirmation" ? (
      <Confirmation
        failed={failed}
        count={serverCount}
        applying={applying}
        reviewAvailable={loaded ? firstDraft !== null : null}
        reviewRef={reviewRef}
        confirmRef={confirmRef}
        cancelRef={cancelRef}
        onCancel={() => close(context.terminalClose)}
        onReview={() => review(context.terminalClose)}
        onConfirm={() => {
          const lock = context.beginBlocking();
          if (lock.kind === "started") void requestAuto(true, lock.settle);
        }}
      />
    ) : (
      <WriteModeChoices
        value={value}
        disabled={choicesDisabled}
        loaded={loaded}
        pending={loaded ? groups.length : null}
        draftRef={draftRef}
        directRef={directRef}
        onDraft={() => chooseDraft(context.terminalClose)}
        onAuto={() => {
          const lock = context.beginBlocking();
          if (lock.kind === "started") void requestAuto(false, lock.settle);
        }}
      />
    );
  return {
    kind: "panel",
    id: "write-mode",
    priority: 200,
    interaction: update.isPending || applying ? "busy" : "enabled",
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

function WriteModeChoices({
  value,
  disabled,
  loaded,
  pending,
  draftRef,
  directRef,
  onDraft,
  onAuto,
}: {
  value: AiWriteMode;
  disabled: boolean;
  loaded: boolean;
  pending: number | null;
  draftRef: RefObject<HTMLButtonElement | null>;
  directRef: RefObject<HTMLButtonElement | null>;
  onDraft(): void;
  onAuto(): void;
}) {
  return (
    <div role="radiogroup" aria-label={t`AI write mode`} className="space-y-1">
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
  );
}

function Confirmation({
  failed,
  count,
  applying,
  reviewAvailable,
  reviewRef,
  confirmRef,
  cancelRef,
  onCancel,
  onReview,
  onConfirm,
}: {
  failed: boolean;
  count: number | null;
  applying: boolean;
  reviewAvailable: boolean | null;
  reviewRef: RefObject<HTMLButtonElement | null>;
  confirmRef: RefObject<HTMLButtonElement | null>;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onCancel(): void;
  onReview(): void;
  onConfirm(): void;
}) {
  return (
    <div className="px-1">
      <h2 className="font-semibold">
        <Trans>Drafts are waiting</Trans>
      </h2>
      {failed ? (
        <p className="mt-1 text-caption text-destructive" role="alert">
          <Trans>Couldn't apply everything. Nothing changed, so you're still in Draft.</Trans>
        </p>
      ) : count == null ? (
        <p className="mt-1 text-caption text-muted-foreground">
          <Trans>Checking pending changes…</Trans>
        </p>
      ) : (
        <p className="mt-1 text-caption text-muted-foreground">
          <Trans>
            This Work has <Plural value={count} one="# AI change" other="# AI changes" /> in draft.
          </Trans>
        </p>
      )}
      <div className="mt-3 flex flex-col gap-1">
        <Button
          ref={reviewRef}
          variant="secondary"
          size="sm"
          disabled={applying || reviewAvailable !== true}
          onClick={onReview}
        >
          {reviewAvailable === null ? (
            <Trans>Checking pending changes…</Trans>
          ) : (
            <Trans>Review changes</Trans>
          )}
        </Button>
        <Button ref={confirmRef} size="sm" disabled={applying || count == null} onClick={onConfirm}>
          {applying ? (
            <Trans>Applying…</Trans>
          ) : (
            <Plural
              value={count ?? 0}
              one="Apply # change and switch"
              other="Apply # changes and switch"
            />
          )}
        </Button>
        <Button ref={cancelRef} variant="ghost" size="sm" disabled={applying} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}
