/** One write-mode controller rendered through inline and overflow toolbar hosts. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { UpdateWorkWriteModeResponse, Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type RefObject, useRef, useState } from "react";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useUpdateWorkWriteMode } from "@/client/query/useWorks";
import {
  ComposerCurrentValueTrigger,
  type ComposerToolbarControl,
} from "@/components/app/composer-toolbar";
import type { ComposerToolbarPanelContext } from "@/components/app/composer-toolbar/types";
import { Button } from "@/components/ui/button";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";
import { cn } from "@/lib/utils";
import { activeDockedDraftGroups } from "./docked-drafts";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export function useComposerWriteModeToolbarControl({
  projectId,
  work,
}: {
  projectId: string;
  work: Work;
}): ComposerToolbarControl {
  const update = useUpdateWorkWriteMode(projectId, work.id);
  const drafts = useWorkDrafts(projectId, work.id);
  const { openAiDraft } = useAiDraftLauncher();
  const groups = activeDockedDraftGroups(drafts.groups);
  const firstGroup =
    [...groups]
      .sort((a, b) =>
        (a.documentName ?? a.documentId).localeCompare(b.documentName ?? b.documentId),
      )
      .at(0) ?? null;
  const firstDraft = firstGroup?.drafts[0] ?? null;
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<"choices" | "confirmation">("choices");
  const [applying, setApplying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [serverCount, setServerCount] = useState<number | null>(null);
  const loaded = drafts.groups !== null;
  const requestAuto = async (confirmed: boolean, settle: (outcome: "close" | "stay") => void) => {
    if (applying) return;
    if (!confirmed && work.aiWriteMode === "draft" && groups.length > 0) {
      setView("confirmation");
      setServerCount(null);
    }
    setApplying(true);
    setFailed(false);
    const result: UpdateWorkWriteModeResponse | null = await update
      .mutateAsync(
        confirmed ? { aiWriteMode: "direct", confirmedPush: true } : { aiWriteMode: "direct" },
      )
      .catch(() => null);
    setApplying(false);
    if (result?.status === "updated") settle("close");
    else if (result?.status === "confirmation_required") {
      setServerCount(result.pendingChangeCount);
      setView("confirmation");
      settle("stay");
      if (confirmed) setFailed(true);
    } else {
      setView("confirmation");
      setFailed(true);
      settle("stay");
    }
  };
  const chooseDraft = (terminalClose: () => void) => {
    update.mutate("draft");
    terminalClose();
  };
  const review = (terminalClose: () => void) => {
    if (!firstGroup || !firstDraft || applying) return;
    terminalClose();
    openAiDraft(
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
    setView("choices");
    setFailed(false);
  };
  const value = work.aiWriteMode;
  const panelBody = (context: ComposerToolbarPanelContext) =>
    view === "confirmation" ? (
      <Confirmation
        failed={failed}
        count={serverCount}
        applying={applying}
        reviewAvailable={loaded ? firstDraft !== null : null}
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
        disabled={!loaded || update.isPending}
        pending={loaded ? groups.length : null}
        initialFocusRef={initialFocusRef}
        onDraft={() => chooseDraft(context.terminalClose)}
        onAuto={() => {
          const lock = context.beginBlocking();
          if (lock.kind === "started") void requestAuto(false, lock.settle);
        }}
      />
    );
  return {
    id: "write-mode",
    priority: 200,
    inline: ({ triggerRef, activate, active, locked }) => (
      <ComposerCurrentValueTrigger
        ref={triggerRef}
        ariaLabel={t`AI write mode: ${value === "draft" ? "Draft" : "Auto-apply"}`}
        disabled={update.isPending}
        readOnly={locked}
        active={active}
        onActivate={activate}
      >
        {value === "draft" ? <Trans>Draft</Trans> : <Trans>Auto-apply</Trans>}
      </ComposerCurrentValueTrigger>
    ),
    overflow: {
      kind: "panel",
      item: {
        ariaLabel: t`AI write mode: ${value === "draft" ? "Draft" : "Auto-apply"}`,
        label: <Trans>Write mode</Trans>,
        value: value === "draft" ? <Trans>Draft</Trans> : <Trans>Auto-apply</Trans>,
      },
      panel: {
        ariaLabel: t`AI write mode`,
        size: "compact",
        initialFocusRef,
        render: panelBody,
      },
    },
  };
}

function WriteModeChoices({
  initialFocusRef,
  value,
  disabled,
  pending,
  onDraft,
  onAuto,
}: {
  initialFocusRef: RefObject<HTMLElement | null>;
  value: AiWriteMode;
  disabled: boolean;
  pending: number | null;
  onDraft(): void;
  onAuto(): void;
}) {
  return (
    <div role="radiogroup" aria-label={t`AI write mode`} className="space-y-1">
      <Button
        ref={value === "draft" ? (initialFocusRef as RefObject<HTMLButtonElement>) : undefined}
        role="radio"
        aria-checked={value === "draft"}
        variant="ghost"
        className={cn(dropdownRowVariants({ selected: value === "draft" }), "justify-between")}
        disabled={disabled}
        onClick={onDraft}
      >
        <Trans>Draft</Trans>
        {pending ? <span>({pending})</span> : null}
      </Button>
      <Button
        ref={value === "direct" ? (initialFocusRef as RefObject<HTMLButtonElement>) : undefined}
        role="radio"
        aria-checked={value === "direct"}
        variant="ghost"
        className={dropdownRowVariants({ selected: value === "direct" })}
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
  onCancel,
  onReview,
  onConfirm,
}: {
  failed: boolean;
  count: number | null;
  applying: boolean;
  reviewAvailable: boolean | null;
  onCancel(): void;
  onReview(): void;
  onConfirm(): void;
}) {
  return (
    <div>
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
        <Button size="sm" disabled={applying || count == null} onClick={onConfirm}>
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
        <Button variant="ghost" size="sm" disabled={applying} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}
