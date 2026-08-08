/** One write-mode controller rendered through inline and overflow toolbar hosts. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { UpdateWorkWriteModeResponse, Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type ReactNode, useId, useState } from "react";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useUpdateWorkWriteMode } from "@/client/query/useWorks";
import type { ComposerToolbarControl } from "@/components/app/composer-toolbar";
import { Button } from "@/components/ui/button";
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
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"choices" | "confirmation">("choices");
  const [applying, setApplying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [serverCount, setServerCount] = useState<number | null>(null);
  const loaded = drafts.groups !== null;
  const requestAuto = async (confirmed: boolean) => {
    if (applying) return;
    if (!confirmed && work.aiWriteMode === "draft" && groups.length > 0) {
      setOpen(true);
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
    if (result?.status === "updated") setOpen(false);
    else if (result?.status === "confirmation_required") {
      setServerCount(result.pendingChangeCount);
      setOpen(true);
      setView("confirmation");
      if (confirmed) setFailed(true);
    } else {
      setOpen(true);
      setView("confirmation");
      setFailed(true);
    }
  };
  const chooseDraft = () => {
    update.mutate("draft");
    setOpen(false);
  };
  const review = () => {
    if (!firstGroup || !firstDraft || applying) return;
    setOpen(false);
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
  const close = () => {
    if (applying) return;
    setOpen(false);
    setView("choices");
    setFailed(false);
  };
  const value = work.aiWriteMode;
  const panelBody =
    view === "confirmation" ? (
      <Confirmation
        failed={failed}
        count={serverCount}
        applying={applying}
        reviewAvailable={loaded ? firstDraft !== null : null}
        onCancel={close}
        onReview={review}
        onConfirm={() => void requestAuto(true)}
      />
    ) : (
      <WriteModeChoices
        value={value}
        disabled={!loaded || update.isPending}
        pending={loaded ? groups.length : null}
        onDraft={chooseDraft}
        onAuto={() => void requestAuto(false)}
      />
    );
  return {
    id: "write-mode",
    priority: 200,
    inline: () => (
      <InlineWriteMode
        value={value}
        disabled={!loaded || update.isPending}
        pending={loaded ? groups.length : null}
        onDraft={chooseDraft}
        onAuto={() => void requestAuto(false)}
      />
    ),
    overflow: {
      kind: "panel",
      item: {
        ariaLabel: t`AI write mode: ${value === "draft" ? "Draft" : "Auto-apply"}`,
        label: <Trans>Write mode</Trans>,
        value: value === "draft" ? <Trans>Draft</Trans> : <Trans>Auto-apply</Trans>,
      },
      panel: {
        open,
        busy: applying,
        canDismiss: !applying,
        ariaLabel: t`AI write mode`,
        size: "compact",
        onRequestOpen: () => {
          setView("choices");
          setOpen(true);
        },
        onRequestDismiss: close,
        render: () => panelBody,
      },
    },
  };
}

function InlineWriteMode({
  value,
  disabled,
  pending,
  onDraft,
  onAuto,
}: {
  value: AiWriteMode;
  disabled: boolean;
  pending: number | null;
  onDraft(): void;
  onAuto(): void;
}) {
  const name = useId();
  return (
    <fieldset className="shrink-0 border-0">
      <legend className="visually-hidden">
        <Trans>AI write mode</Trans>
      </legend>
      <div className="flex items-center rounded-lg bg-foreground/6 p-0.5">
        <ModeOption
          name={name}
          value="draft"
          selected={value === "draft"}
          disabled={disabled}
          onSelect={onDraft}
        >
          <Trans>Draft</Trans>
          {value === "draft" && pending ? (
            <span className="ml-1 rounded-full bg-primary/15 px-1 text-[10px] text-jade-text">
              ({pending})
            </span>
          ) : null}
        </ModeOption>
        <ModeOption
          name={name}
          value="direct"
          selected={value === "direct"}
          disabled={false}
          onSelect={onAuto}
        >
          <Trans>Auto-apply</Trans>
        </ModeOption>
      </div>
    </fieldset>
  );
}
function ModeOption({
  name,
  value,
  selected,
  disabled,
  onSelect,
  children,
}: {
  name: string;
  value: AiWriteMode;
  selected: boolean;
  disabled: boolean;
  onSelect(): void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "focus-within:focus-ring rounded-[calc(var(--radius-lg)-2px)]",
        disabled ? "cursor-default" : "cursor-pointer",
      )}
    >
      <input
        className="visually-hidden"
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span
        className={cn(
          "block h-7 rounded-[calc(var(--radius-lg)-2px)] px-2 text-xs leading-7",
          selected ? "bg-background font-medium" : "text-muted-foreground",
          disabled && "opacity-60",
        )}
      >
        {children}
      </span>
    </label>
  );
}
function WriteModeChoices({
  value,
  disabled,
  pending,
  onDraft,
  onAuto,
}: {
  value: AiWriteMode;
  disabled: boolean;
  pending: number | null;
  onDraft(): void;
  onAuto(): void;
}) {
  return (
    <div role="radiogroup" aria-label={t`AI write mode`} className="space-y-1">
      <Button
        role="radio"
        aria-checked={value === "draft"}
        variant="ghost"
        className="w-full justify-between"
        disabled={disabled}
        onClick={onDraft}
      >
        <Trans>Draft</Trans>
        {pending ? <span>({pending})</span> : null}
      </Button>
      <Button
        role="radio"
        aria-checked={value === "direct"}
        variant="ghost"
        className="w-full justify-start"
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

export function ComposerWriteModeControl(props: { projectId: string; work: Work }) {
  const control = useComposerWriteModeToolbarControl(props);
  return control.inline({ open: false, busy: false, requestOpen() {}, requestDismiss() {} });
}
