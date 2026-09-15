/** Shared persisted creation composer for project Home, Chats, and account New project. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { useProjectAgents } from "@/client/query/useProjectAgents";
import { useWorks } from "@/client/query/useWorks";
import { Composer } from "@/components/app/composer";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { NewThreadComposerToolbar } from "@/features/project/home/NewThreadComposerToolbar";
import { AgentOnlyComposerToolbar } from "./ChatComposerToolbar";
import { useCreationComposer } from "./useCreationComposer";

export function CreationComposer({
  projectId,
  autoFocus = false,
}: {
  projectId: string | null;
  autoFocus?: boolean;
}) {
  const creation = useCreationComposer(projectId);
  const works = useWorks(projectId ?? "", { enabled: projectId !== null });
  const agents = useProjectAgents(projectId);
  const choices = creation.state.slot?.choices;
  const attempt = creation.state.slot?.attempt;
  const agentSlug = creation.contextLocked
    ? (attempt?.agentSlug ?? DEFAULT_AGENT_SLUG)
    : (choices?.agentSlug ?? attempt?.agentSlug ?? DEFAULT_AGENT_SLUG);
  const [modePending, setModePending] = useState(false);
  const initialWork = works.works?.find((work) => work.status === "active") ?? null;
  const workId =
    creation.contextLocked && attempt
      ? attempt.workId
      : choices?.workId === undefined
        ? attempt
          ? attempt.workId
          : (initialWork?.id ?? null)
        : choices.workId;
  const work = works.works?.find((work) => work.id === workId && work.status === "active") ?? null;
  const references = useReferenceBrowserCatalog(
    projectId ?? undefined,
    work?.id,
    t`Reference a file`,
  );
  const openDocument = useOpenProjectDocument(projectId ?? undefined);
  const context = { workId, agentSlug };
  const unavailableWork =
    (works.status === "ready" || works.status === "empty") && workId !== null && !work;
  const unavailableAgent =
    (agents.status === "ready" || agents.status === "empty") &&
    agentSlug !== DEFAULT_AGENT_SLUG &&
    !agents.agents?.some((agent) => agent.slug === agentSlug);
  const unavailableChoice = !creation.contextLocked && (unavailableWork || unavailableAgent);
  const unavailableMessage = !unavailableChoice
    ? null
    : unavailableWork
      ? t`Your selected Work is unavailable. Choose another Work or No Work.`
      : unavailableAgent
        ? t`Your selected Agent is unavailable. Choose another Agent.`
        : null;
  const worksReady = projectId === null || works.status === "ready" || works.status === "empty";
  const agentsReady = projectId === null || agents.status === "ready" || agents.status === "empty";
  const choicesReady = worksReady && agentsReady && !unavailableChoice;
  const issue =
    creation.state.issue ??
    (attempt?.phase === "refused" || attempt?.phase === "mismatched" ? attempt.phase : null);
  const message =
    issue === "storage"
      ? t`Your draft couldn’t be saved on this device.`
      : issue === "conflict"
        ? t`This draft changed in another tab. The saved version has been loaded.`
        : issue === "claimed"
          ? t`This creation attempt is open in another tab.`
          : issue === "refused"
            ? t`Your Work or Agent choice is no longer available.`
            : issue === "mismatched"
              ? t`The created destination didn’t match your choices.`
              : issue === "ambiguous"
                ? t`Chat creation is still being reconciled.`
                : creation.state.slot?.attempt
                  ? t`Continue the saved creation attempt.`
                  : null;
  return (
    <>
      {creation.loaded ? (
        <Composer
          key={creation.state.editorEpoch}
          initialDraft={creation.initialDraft}
          variant="hero"
          autoFocus={autoFocus}
          onSubmit={async (envelope) => ({
            kind:
              choicesReady && (await creation.submit(envelope, context)) ? "accepted" : "rejected",
            submissionId: envelope.submissionId,
            acceptedRevision: envelope.acceptedRevision,
          })}
          onDraftChange={creation.updateDraft}
          referenceCatalog={references}
          onOpenReference={
            projectId
              ? (reference) => {
                  void openDocument({ documentId: reference.documentId, disposition: "current" });
                }
              : undefined
          }
          uploadPort={projectId ? uploadIntakePort : undefined}
          uploadScope={
            projectId
              ? work
                ? { kind: "work", projectId, workId: work.id, workSlug: work.slug }
                : { kind: "none", projectId }
              : undefined
          }
          busy={creation.busy}
          submitDisabled={!choicesReady || modePending || creation.submitLocked}
          submitDisabledReason={
            unavailableMessage ??
            (creation.busy
              ? t`Creating chat`
              : modePending
                ? t`Finishing write mode change`
                : !worksReady
                  ? t`Loading Work`
                  : !agentsReady
                    ? agents.isError
                      ? t`Couldn't load agents.`
                      : t`Loading agents…`
                    : creation.submitLocked
                      ? t`Finish the current chat attempt`
                      : undefined)
          }
          toolbarLeft={
            projectId ? (
              <NewThreadComposerToolbar
                projectId={projectId}
                work={work}
                selectedWorkId={workId}
                works={works.works ?? []}
                worksStatus={works.isError ? "error" : worksReady ? "ready" : "loading"}
                agentSlug={agentSlug}
                disabled={creation.contextLocked}
                onAgentChange={(agentSlug) => creation.updateChoices({ agentSlug })}
                onWorkChange={(selected) =>
                  creation.updateChoices({ workId: selected?.id ?? null })
                }
                onRetryWorks={works.refetch}
                onModePendingChange={setModePending}
              />
            ) : (
              <AgentOnlyComposerToolbar
                projectId={null}
                agentSlug={agentSlug}
                readonlyAgent={creation.contextLocked}
                onAgentChange={(agentSlug) => creation.updateChoices({ agentSlug })}
              />
            )
          }
        />
      ) : (
        <p role="status">
          <Trans>Loading draft…</Trans>
        </p>
      )}
      {works.isError ? (
        <InlineErrorRow message={t`Work couldn’t load`} onRetry={works.refetch} />
      ) : null}
      {unavailableMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailableMessage}
        </p>
      ) : null}
      {message ? (
        <InlineErrorRow
          message={message}
          actionLabel={issue === "mismatched" ? t`Start over` : undefined}
          onRetry={
            issue === "refused" && !choicesReady
              ? undefined
              : () => {
                  if (issue === "mismatched") void creation.startOver();
                  else if (issue === "storage" || issue === "conflict") void creation.reload();
                  else void creation.retry(context);
                }
          }
        />
      ) : null}
    </>
  );
}
