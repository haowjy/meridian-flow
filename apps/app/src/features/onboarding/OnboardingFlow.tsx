import type { OnboardingState } from "@meridian/contracts";
import type { ComponentBlockContent } from "@meridian/contracts/components";
import type { Block, Turn } from "@meridian/contracts/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  completeOnboarding,
  getOnboardingStatus,
  saveOnboardingProgress,
} from "@/client/api/onboarding-api";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import { AssistantTurn } from "@/features/chat/AssistantTurn";
import type { CheckpointRespondRequest } from "@/features/chat/CustomBlockRenderer";
import { CorpusImportPanel } from "@/features/corpus-import/CorpusImportPanel";

type FlowStep = {
  id: string;
  title: string;
  message: string;
  content: ComponentBlockContent;
};

const STEPS: FlowStep[] = [
  {
    id: "basics",
    title: "Project basics",
    message: "Let's name the project and give Setup enough signal to create your workspace.",
    content: checkpointContent("onboarding-basics", "What are you writing?", {
      type: "object",
      properties: {
        projectName: { type: "string", title: "Project name" },
        writingType: {
          type: "string",
          title: "What kind of writing?",
          enum: ["progression fantasy", "LitRPG", "xianxia", "fantasy serial", "other"],
        },
        writingGoal: { type: "string", title: "What are you writing for?" },
      },
      required: ["projectName", "writingType"],
      additionalProperties: false,
    }),
  },
  {
    id: "profile",
    title: "Context for Setup",
    message: "A little context helps Setup tune the project without making import mandatory.",
    content: checkpointContent("onboarding-profile", "How did you hear about Meridian?", {
      type: "object",
      properties: {
        referralSource: { type: "string", title: "How did you hear about us?" },
        notes: { type: "string", title: "Anything else Setup should know?" },
      },
      required: [],
      additionalProperties: false,
    }),
  },
  {
    id: "path",
    title: "Choose your start",
    message: "You can import existing material now, or go straight to the Setup thread.",
    content: checkpointContent("onboarding-path", "How do you want to begin?", {
      type: "object",
      properties: {
        path: {
          type: "string",
          title: "Start path",
          enum: ["import_corpus", "start_chatting"],
        },
      },
      required: ["path"],
      additionalProperties: false,
    }),
  },
];

export function OnboardingFlow() {
  const navigate = useNavigate();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOnboardingStatus()
      .then((status) => {
        if (cancelled) return;
        setState(status.state);
        if (status.state.status === "completed" && status.state.firstProjectId) {
          void navigateToProject(navigate, status.state.firstProjectId);
        }
      })
      .catch((loadError) => setError(messageFromError(loadError)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const activeStep = useMemo(() => nextStep(state ?? {}), [state]);
  const showImport =
    state?.status === "in_progress" &&
    state.answers?.path === "import_corpus" &&
    completedSteps(state).includes("path");

  async function handleCheckpoint(request: CheckpointRespondRequest) {
    if (!activeStep || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveOnboardingProgress({
        stepId: activeStep.id,
        answers: answerRecord(request.value),
      });
      setState(result.state);
      if (activeStep.id === "path") {
        const path = answerRecord(request.value).path;
        if (path === "start_chatting") {
          await finish("start_chatting");
        }
      }
    } catch (submitError) {
      setError(messageFromError(submitError));
    } finally {
      setBusy(false);
    }
  }

  async function finish(path: "import_corpus" | "start_chatting") {
    setBusy(true);
    setError(null);
    try {
      const result = await completeOnboarding({ path });
      setState(result.state);
      await navigateToProject(navigate, result.projectId);
    } catch (completeError) {
      setError(messageFromError(completeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1040px] flex-col gap-8 px-4 py-8 md:px-8 md:py-12">
        <header className="max-w-[760px]">
          <p className="text-meta uppercase tracking-hero-label text-muted-foreground">
            Setup agent
          </p>
          <h1 className="mt-3 text-[clamp(30px,5vw,56px)] font-semibold leading-none tracking-prose-heading">
            Build the project before the workspace opens.
          </h1>
          <p className="mt-4 max-w-[64ch] text-base leading-7 text-ink-muted">
            Setup asks a short static interview, creates your first project, and leaves you in a
            real Setup-agent thread. Import chapters if you want; skipping import is fine.
          </p>
        </header>

        <section
          className="rounded-3xl border border-border-subtle bg-card p-4 shadow-sm md:p-6"
          data-testid="onboarding-flow"
        >
          {loading ? (
            <p className="text-sm text-muted-foreground" data-testid="onboarding-loading">
              Loading onboarding…
            </p>
          ) : null}
          {!loading && state ? (
            <div className="space-y-6">
              <Progress state={state} />
              <div className="rounded-2xl border border-border-subtle bg-background p-4 md:p-5">
                {STEPS.map((step) => (
                  <AssistantTurn
                    key={step.id}
                    threadId={state.firstThreadId ?? "onboarding-preview-thread"}
                    turn={turnForStep(step, state, activeStep?.id === step.id)}
                    onRespondToCheckpoint={handleCheckpoint}
                  />
                ))}
              </div>
              {showImport && state.firstProjectId ? (
                <AppQueryProvider initialProjects={null}>
                  <div className="overflow-hidden rounded-2xl border border-border-subtle bg-background">
                    <CorpusImportPanel
                      projectId={state.firstProjectId}
                      compact
                      onImported={() => void finish("import_corpus")}
                    />
                    <div className="flex flex-wrap gap-2 border-border-subtle border-t px-6 py-4">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void finish("import_corpus")}
                        className="focus-ring inline-flex h-9 items-center rounded-md bg-primary px-3 text-primary-foreground text-sm font-medium disabled:opacity-50"
                      >
                        Continue to Setup thread
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void finish("start_chatting")}
                        className="focus-ring inline-flex h-9 items-center rounded-md border border-border-subtle bg-background px-3 text-foreground text-sm font-medium disabled:opacity-50"
                      >
                        Skip import
                      </button>
                    </div>
                  </div>
                </AppQueryProvider>
              ) : null}
            </div>
          ) : null}
          {error ? <p className="mt-4 text-destructive text-sm">{error}</p> : null}
          {busy ? <p className="mt-4 text-muted-foreground text-sm">Saving…</p> : null}
        </section>
      </div>
    </main>
  );
}

function checkpointContent(checkpointId: string, prompt: string, answerSchema: object) {
  return {
    kind: "checkpoint",
    props: {
      prompt,
      artifacts: [],
      answerSchema,
      recommended: null,
      requiresHuman: true,
    },
    checkpoint: { id: checkpointId, timeoutMs: 300_000 },
  } as ComponentBlockContent;
}

function turnForStep(step: FlowStep, state: OnboardingState, active: boolean): Turn {
  const resolved = completedSteps(state).includes(step.id);
  const content = resolved
    ? {
        ...step.content,
        props: {
          ...step.content.props,
          resolvedValue: resolvedLabel(state.answers ?? {}, step.id),
          answerProvenance: "user",
        },
      }
    : step.content;

  return {
    id: `onboarding-${step.id}`,
    threadId: state.firstThreadId ?? "onboarding-preview-thread",
    role: "assistant",
    status: active && !resolved ? "waiting_checkpoint" : "complete",
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    createdAt: "2026-06-12T00:00:00.000Z",
    completedAt: null,
    blocks: [textBlock(step, 1), customBlock(step, content, 2)],
    siblingIds: [],
    responses: [],
  };
}

function textBlock(step: FlowStep, sequence: number): Block {
  return {
    id: `onboarding-${step.id}-text`,
    turnId: `onboarding-${step.id}`,
    responseId: null,
    blockType: "text",
    sequence,
    textContent: step.message,
    content: null,
    status: "complete",
    createdAt: "2026-06-12T00:00:00.000Z",
  };
}

function customBlock(step: FlowStep, content: ComponentBlockContent, sequence: number): Block {
  return {
    id: `onboarding-${step.id}-checkpoint`,
    turnId: `onboarding-${step.id}`,
    responseId: null,
    blockType: "custom",
    sequence,
    content,
    status: "complete",
    createdAt: "2026-06-12T00:00:00.000Z",
  };
}

function completedSteps(state: OnboardingState): string[] {
  return state.completedSteps ?? [];
}

function nextStep(state: OnboardingState): FlowStep | null {
  const done = completedSteps(state);
  return STEPS.find((step) => !done.includes(step.id)) ?? null;
}

function answerRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : { value };
}

function resolvedLabel(answers: Record<string, unknown>, stepId: string): string {
  const keysByStep: Record<string, string[]> = {
    basics: ["projectName", "writingType", "writingGoal"],
    profile: ["referralSource", "notes"],
    path: ["path"],
  };
  return (
    (keysByStep[stepId] ?? [])
      .map((key) => answers[key])
      .filter((value) => typeof value === "string" && value.trim())
      .join(" · ") || "Saved"
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function navigateToProject(navigate: ReturnType<typeof useNavigate>, projectId: string) {
  return navigate({
    to: "/projects/$projectId/agent",
    params: { projectId },
    replace: true,
  });
}

function Progress({ state }: { state: OnboardingState }) {
  const done = completedSteps(state).length;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {STEPS.map((step, index) => {
        const complete = completedSteps(state).includes(step.id);
        return (
          <div
            key={step.id}
            className="rounded-xl border border-border-subtle bg-surface-subtle px-3 py-2"
          >
            <p className="text-muted-foreground text-xs">Step {index + 1}</p>
            <p className="mt-1 font-medium text-foreground text-sm">{step.title}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {complete ? "Saved" : index === done ? "Current" : "Upcoming"}
            </p>
          </div>
        );
      })}
    </div>
  );
}
