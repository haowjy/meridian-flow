// @ts-nocheck
/**
 * AgentDefinitionEditor — structured editor for agent meta, instructions, and skill links.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentSkillLinkDetail, LibraryAgentSummary } from "@meridian/contracts/agents";
import { useEffect, useMemo, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import {
  useAgentDefinition,
  useAgentDefinitionRevisionsStatus,
  usePatchAgentSkillLink,
  useRestoreAgentDefinitionOriginal,
  useRestoreAgentDefinitionRevision,
  useUpdateAgentDefinition,
} from "@/client/query/useAgentDefinition";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AgentChip } from "@/features/agents";
import { sourceBadgeLabel } from "@/features/agents/resolve-agent";

import { AgentSkillLinksEditor } from "./AgentSkillLinksEditor";
import { DefinitionField, DefinitionSection } from "./DefinitionFormLayout";
import { DefinitionHistoryPanel } from "./DefinitionHistoryPanel";
import { DefinitionSaveBar, type DefinitionSaveState } from "./DefinitionSaveBar";
import {
  AGENT_EFFORT_OPTIONS,
  type AgentEditorDraft,
  type AgentEffortOption,
  agentDraftFromDetail,
  applyAgentMetaFields,
  buildAgentSaveRequest,
  effortFromAgent,
  isAgentDefinitionEditable,
  isAgentDraftDirty,
  modelFromAgent,
  moveSkillInMeta,
  orderedSkillLinks,
  stringMetaValue,
} from "./definition-editor-state";
import { RestoreOriginalDialog } from "./RestoreOriginalDialog";

export type AgentDefinitionEditorProps = {
  projectId: string;
  summary: LibraryAgentSummary;
  onDirtyChange: (dirty: boolean) => void;
  registerSaveHandler?: (handler: (() => Promise<boolean>) | null) => void;
  /** TODO(test-loop): parallel lane wires fresh-thread test from the dock. */
  onTestAgent?: () => void;
};

export function AgentDefinitionEditor({
  projectId,
  summary,
  onDirtyChange,
  registerSaveHandler,
  onTestAgent,
}: AgentDefinitionEditorProps) {
  const slug = summary.slug;
  const { data, isPending, isError, refetch } = useAgentDefinition(projectId, slug);
  const updateMutation = useUpdateAgentDefinition(projectId, slug);
  const patchSkillLink = usePatchAgentSkillLink(projectId, slug);
  const restoreRevision = useRestoreAgentDefinitionRevision(projectId, slug);
  const restoreOriginal = useRestoreAgentDefinitionOriginal(projectId, slug);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { revisions, status: revisionsStatus } = useAgentDefinitionRevisionsStatus(
    projectId,
    slug,
    historyOpen,
  );
  const [baseline, setBaseline] = useState<AgentEditorDraft | null>(null);
  const [draft, setDraft] = useState<AgentEditorDraft | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(null);
  const [skillLinks, setSkillLinks] = useState<AgentSkillLinkDetail[]>([]);
  const [pendingSkillSlug, setPendingSkillSlug] = useState<string | null>(null);

  const agent = data?.agent;
  const editable = agent ? isAgentDefinitionEditable(agent) : false;

  useEffect(() => {
    if (!agent) return;
    const next = agentDraftFromDetail(agent);
    setBaseline(next);
    setDraft(next);
    setSkillLinks(orderedSkillLinks(agent));
    setSaveFlash(false);
  }, [agent]);

  const dirty = useMemo(() => {
    if (!baseline || !draft) return false;
    return isAgentDraftDirty(baseline, draft);
  }, [baseline, draft]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

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

  async function saveDraft(): Promise<boolean> {
    if (!draft || !editable) return true;
    try {
      const response = await updateMutation.mutateAsync(buildAgentSaveRequest(draft));
      const next = agentDraftFromDetail(response.agent);
      setBaseline(next);
      setDraft(next);
      setSkillLinks(orderedSkillLinks(response.agent));
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
      const next = agentDraftFromDetail(response.agent);
      setBaseline(next);
      setDraft(next);
      setSkillLinks(orderedSkillLinks(response.agent));
    } finally {
      setRestoringRevisionId(null);
    }
  }

  async function handleRestoreOriginal() {
    const response = await restoreOriginal.mutateAsync();
    const next = agentDraftFromDetail(response.agent);
    setBaseline(next);
    setDraft(next);
    setSkillLinks(orderedSkillLinks(response.agent));
    setRestoreDialogOpen(false);
  }

  if (isPending) {
    return <EditorLoadingState />;
  }

  if (isError || !agent || !draft) {
    return <EditorErrorState onRetry={refetch} />;
  }

  const name = stringMetaValue(draft.meta, "name") || summary.name;
  const description = stringMetaValue(draft.meta, "description");
  const model =
    stringMetaValue(draft.meta, "model") ||
    modelFromAgent({ ...agent, meta: draft.meta, config: draft.config });
  const effort =
    effortFromAgent({ ...agent, meta: draft.meta, config: draft.config }) ||
    (stringMetaValue(draft.meta, "effort") as AgentEffortOption | "");
  const sourceLine = sourceLineFor(summary.source, summary.packageName);
  const canRestoreOriginal = editable && Boolean(agent.originalContentChecksum);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <AgentChip
                variant="card"
                agent={{
                  slug: summary.slug,
                  name,
                  description,
                  source: summary.source,
                  packageName: summary.packageName,
                }}
                className="max-w-md"
              />
              <div className="flex flex-wrap items-center gap-2">
                {agent.isEdited ? <EditedBadge /> : null}
                {onTestAgent ? (
                  <button
                    type="button"
                    onClick={onTestAgent}
                    className="focus-ring rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-foreground hover:bg-surface-subtle"
                  >
                    <Trans>Test this agent</Trans>
                  </button>
                ) : null}
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
            {sourceLine ? <p className="text-meta text-muted-foreground">{sourceLine}</p> : null}
            {!editable ? (
              <p className="text-meta text-muted-foreground">
                <Trans>
                  Built-in agents are read-only here. Duplicate to edit when that flow ships.
                </Trans>
              </p>
            ) : null}
          </header>

          <DefinitionSection title={<Trans>Details</Trans>}>
            <div className="flex flex-col gap-3">
              <DefinitionField label={<Trans>Name</Trans>}>
                <Input
                  value={name}
                  disabled={!editable}
                  aria-label={t`Agent name`}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            meta: applyAgentMetaFields(current.meta, {
                              name: event.target.value,
                              description,
                              model,
                              effort,
                            }),
                          }
                        : current,
                    )
                  }
                />
              </DefinitionField>
              <DefinitionField label={<Trans>Description</Trans>}>
                <Input
                  value={description}
                  disabled={!editable}
                  aria-label={t`Agent description`}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            meta: applyAgentMetaFields(current.meta, {
                              name,
                              description: event.target.value,
                              model,
                              effort,
                            }),
                          }
                        : current,
                    )
                  }
                />
              </DefinitionField>
              <div className="grid gap-3 sm:grid-cols-2">
                <DefinitionField label={<Trans>Model</Trans>}>
                  <Input
                    value={model}
                    disabled={!editable}
                    aria-label={t`Model`}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              meta: applyAgentMetaFields(current.meta, {
                                name,
                                description,
                                model: event.target.value,
                                effort,
                              }),
                            }
                          : current,
                      )
                    }
                  />
                </DefinitionField>
                <DefinitionField label={<Trans>Effort</Trans>}>
                  <Select
                    value={effort || "none"}
                    disabled={!editable}
                    onValueChange={(value) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              meta: applyAgentMetaFields(current.meta, {
                                name,
                                description,
                                model,
                                effort: value === "none" ? "" : (value as AgentEffortOption),
                              }),
                            }
                          : current,
                      )
                    }
                  >
                    <SelectTrigger className="focus-ring w-full" aria-label={t`Effort`}>
                      <SelectValue placeholder={t`Default`} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        <Trans>Default</Trans>
                      </SelectItem>
                      {AGENT_EFFORT_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DefinitionField>
              </div>
            </div>
          </DefinitionSection>

          <DefinitionSection
            title={<Trans>Instructions</Trans>}
            description={<Trans>Applies to new threads.</Trans>}
          >
            <Textarea
              value={draft.body}
              disabled={!editable}
              rows={12}
              aria-label={t`Agent instructions`}
              className="min-h-48 font-mono text-sm"
              onChange={(event) =>
                setDraft((current) =>
                  current ? { ...current, body: event.target.value } : current,
                )
              }
            />
          </DefinitionSection>

          <AgentSkillLinksEditor
            links={skillLinks}
            disabled={!editable}
            pendingSkillSlug={pendingSkillSlug}
            onReorder={(index, direction) =>
              setDraft((current) =>
                current
                  ? { ...current, meta: moveSkillInMeta(current.meta, index, direction) }
                  : current,
              )
            }
            onToggleModelInvocable={(skillSlug, modelInvocable) => {
              const previous = skillLinks;
              setSkillLinks((current) =>
                current.map((link) =>
                  link.skillSlug === skillSlug ? { ...link, modelInvocable } : link,
                ),
              );
              setPendingSkillSlug(skillSlug);
              void patchSkillLink
                .mutateAsync({ skillSlug, modelInvocable })
                .then((updated) => {
                  setSkillLinks(orderedSkillLinks(updated));
                })
                .catch(() => {
                  setSkillLinks(previous);
                })
                .finally(() => {
                  setPendingSkillSlug((current) => (current === skillSlug ? null : current));
                });
            }}
          />
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
      <Skeleton className="h-16 w-full max-w-md" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
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

function sourceLineFor(
  source: LibraryAgentSummary["source"],
  packageName: string | null,
): string | null {
  const badge = sourceBadgeLabel(source, packageName);
  if (!badge) return null;
  if (source === "package" && packageName) return t`from ${packageName}`;
  return badge;
}
