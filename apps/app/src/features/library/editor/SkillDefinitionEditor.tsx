// @ts-nocheck
/**
 * SkillDefinitionEditor — structured editor for skill meta and markdown body.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { LibrarySkillSummary, SkillDefinitionDetail } from "@meridian/contracts/agents";
import { useEffect, useMemo, useState } from "react";

import { isMeridianApiError } from "@/client/api/http-client";
import {
  useRestoreSkillDefinitionOriginal,
  useRestoreSkillDefinitionRevision,
  useSkillDefinition,
  useSkillDefinitionRevisionsStatus,
  useUpdateSkillDefinition,
} from "@/client/query/useSkillDefinition";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { sourceBadgeLabel } from "@/features/agents/resolve-agent";

import { DefinitionField, DefinitionSection } from "./DefinitionFormLayout";
import { DefinitionHistoryPanel } from "./DefinitionHistoryPanel";
import { DefinitionSaveBar, type DefinitionSaveState } from "./DefinitionSaveBar";
import {
  buildSkillSaveRequest,
  isSkillDefinitionEditable,
  isSkillDraftDirty,
  type SkillEditorDraft,
  skillDraftFromDetail,
  skillFileSizeLabel,
  stringMetaValue,
} from "./definition-editor-state";
import { RestoreOriginalDialog } from "./RestoreOriginalDialog";

export type SkillDefinitionEditorProps = {
  workbenchId: string;
  summary: LibrarySkillSummary;
  onDirtyChange: (dirty: boolean) => void;
  registerSaveHandler?: (handler: (() => Promise<boolean>) | null) => void;
};

export function SkillDefinitionEditor({
  workbenchId,
  summary,
  onDirtyChange,
  registerSaveHandler,
}: SkillDefinitionEditorProps) {
  const slug = summary.slug;
  const { data, isPending, isError, refetch } = useSkillDefinition(workbenchId, slug);
  const updateMutation = useUpdateSkillDefinition(workbenchId, slug);
  const restoreRevision = useRestoreSkillDefinitionRevision(workbenchId, slug);
  const restoreOriginal = useRestoreSkillDefinitionOriginal(workbenchId, slug);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { revisions, status: revisionsStatus } = useSkillDefinitionRevisionsStatus(
    workbenchId,
    slug,
    historyOpen,
  );
  const [baseline, setBaseline] = useState<SkillEditorDraft | null>(null);
  const [draft, setDraft] = useState<SkillEditorDraft | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(null);

  const skill = data?.skill;
  const editable = skill ? isSkillDefinitionEditable(skill) : false;

  useEffect(() => {
    if (!skill) return;
    const next = skillDraftFromDetail(skill);
    setBaseline(next);
    setDraft(next);
    setSaveFlash(false);
  }, [skill]);

  const dirty = useMemo(() => {
    if (!baseline || !draft) return false;
    return isSkillDraftDirty(baseline, draft);
  }, [baseline, draft]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  async function saveDraft(): Promise<boolean> {
    if (!draft || !editable) return true;
    try {
      const response = await updateMutation.mutateAsync(buildSkillSaveRequest(draft));
      const next = skillDraftFromDetail(response.skill);
      setBaseline(next);
      setDraft(next);
      setSaveFlash(true);
      window.setTimeout(() => setSaveFlash(false), 2000);
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    registerSaveHandler?.(editable ? saveDraft : null);
    return () => registerSaveHandler?.(null);
  });

  async function handleRestoreRevision(revisionId: string) {
    setRestoringRevisionId(revisionId);
    try {
      const response = await restoreRevision.mutateAsync(revisionId);
      const next = skillDraftFromDetail(response.skill);
      setBaseline(next);
      setDraft(next);
    } finally {
      setRestoringRevisionId(null);
    }
  }

  async function handleRestoreOriginal() {
    const response = await restoreOriginal.mutateAsync();
    const next = skillDraftFromDetail(response.skill);
    setBaseline(next);
    setDraft(next);
    setRestoreDialogOpen(false);
  }

  if (isPending) return <EditorLoadingState />;
  if (isError || !skill || !draft) return <EditorErrorState onRetry={refetch} />;

  const description = stringMetaValue(draft.meta, "description");
  const sourceLine = sourceLineFor(skill, summary.packageName);
  const canRestoreOriginal = editable && Boolean(skill.originalContentChecksum);

  const saveState: DefinitionSaveState = !editable
    ? "disabled"
    : updateMutation.isPending
      ? "saving"
      : saveFlash
        ? "saved"
        : updateMutation.isError
          ? "error"
          : dirty
            ? "dirty"
            : "pristine";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <code className="font-mono text-lg font-medium text-foreground">
                  {summary.slug}
                </code>
                {sourceLine ? (
                  <p className="text-meta text-muted-foreground">{sourceLine}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {skill.isEdited ? <EditedBadge /> : null}
                <DefinitionHistoryPanel
                  revisions={revisions}
                  status={revisionsStatus}
                  disabled={!editable}
                  restoringRevisionId={restoringRevisionId}
                  onOpenChange={setHistoryOpen}
                  onRestore={handleRestoreRevision}
                />
                {canRestoreOriginal ? (
                  <button
                    type="button"
                    disabled={restoreOriginal.isPending}
                    onClick={() => setRestoreDialogOpen(true)}
                    className="focus-ring rounded-md px-2 py-1 text-meta font-medium text-muted-foreground hover:bg-surface-subtle hover:text-foreground disabled:opacity-50"
                  >
                    <Trans>Restore original</Trans>
                  </button>
                ) : null}
              </div>
            </div>
            {!editable ? (
              <p className="text-meta text-muted-foreground">
                <Trans>
                  Built-in skills are read-only here. Duplicate to edit when that flow ships.
                </Trans>
              </p>
            ) : null}
          </header>

          <DefinitionField
            emphasized
            label={<Trans>Description</Trans>}
            hint={
              <Trans>
                This is what the agent reads when deciding to use this skill. Changes apply to new
                threads.
              </Trans>
            }
          >
            <Textarea
              value={description}
              disabled={!editable}
              rows={4}
              aria-label={t`Skill description`}
              className="text-sm"
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? { ...current, meta: { ...current.meta, description: event.target.value } }
                    : current,
                )
              }
            />
          </DefinitionField>

          <DefinitionSection
            title={<Trans>Instructions</Trans>}
            description={<Trans>Markdown body used when the skill runs.</Trans>}
          >
            <Textarea
              value={draft.body}
              disabled={!editable}
              rows={12}
              aria-label={t`Skill instructions`}
              className="min-h-48 font-mono text-sm"
              onChange={(event) =>
                setDraft((current) =>
                  current ? { ...current, body: event.target.value } : current,
                )
              }
            />
          </DefinitionSection>

          <SkillFilesList skill={skill} />
        </div>
      </div>

      <DefinitionSaveBar
        state={saveState}
        errorMessage={
          updateMutation.error && isMeridianApiError(updateMutation.error)
            ? updateMutation.error.message
            : updateMutation.error?.message
        }
        onSave={() => void saveDraft()}
      />

      <RestoreOriginalDialog
        open={restoreDialogOpen}
        pending={restoreOriginal.isPending}
        onConfirm={() => void handleRestoreOriginal()}
        onCancel={() => setRestoreDialogOpen(false)}
      />
    </div>
  );
}

function SkillFilesList({ skill }: { skill: SkillDefinitionDetail }) {
  const entries = Object.entries(skill.files);
  if (entries.length === 0) return null;

  return (
    <DefinitionSection
      title={<Trans>Bundled files</Trans>}
      description={<Trans>Read-only in this editor.</Trans>}
    >
      <ul className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-card px-3 py-2">
        {entries.map(([path, payload]) => (
          <li
            key={path}
            className="flex items-center justify-between gap-3 text-meta text-muted-foreground"
          >
            <code className="truncate font-mono text-foreground">{path}</code>
            <span className="shrink-0">{skillFileSizeLabel(payload)}</span>
          </li>
        ))}
      </ul>
    </DefinitionSection>
  );
}

function EditedBadge() {
  return (
    <span className="status-pill border border-border-subtle bg-surface-subtle text-ink-subtle">
      <Trans>Edited</Trans>
    </span>
  );
}

function EditorLoadingState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function EditorErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <Trans>Could not load this definition.</Trans>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring rounded-md border border-border-subtle bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
      >
        <Trans>Try again</Trans>
      </button>
    </div>
  );
}

function sourceLineFor(skill: SkillDefinitionDetail, packageName: string | null): string | null {
  const badge = sourceBadgeLabel(skill.source, packageName);
  if (!badge) return null;
  if (skill.source === "package" && packageName) return t`from ${packageName}`;
  return badge;
}
