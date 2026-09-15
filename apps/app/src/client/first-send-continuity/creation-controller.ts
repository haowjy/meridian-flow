/** Account-lifetime owner of one creation slot, independent of destination mounting. */
import type { Project } from "@meridian/contracts/projects";
import type { Thread } from "@meridian/contracts/protocol";
import type { ComposerDraftSnapshot, ComposerSubmitEnvelope } from "@/components/app/composer";
import { nativeLocks, tryAcquireExclusiveLock } from "@/core/cross-context-locks";
import type {
  CreationAttempt,
  CreationChoices,
  CreationRefusal,
  CreationSlot,
  CreationSlotResult,
  FirstSendContinuity,
} from "./first-send-continuity";

export type CreationPorts = {
  accountSignal: AbortSignal;
  findProject(id: string): Promise<Project | null>;
  createProject(id: string, title: string): Promise<Project>;
  findThread(projectId: string, id: string): Promise<Thread | null>;
  createThread(attempt: CreationAttempt): Promise<Thread>;
  prepareAdmission(
    project: Project,
    thread: Thread,
    attempt: CreationAttempt,
    assertAlive: () => void,
  ): Promise<{ optimisticUserTurnId?: string; cancel(): void }>;
  matchesThread(thread: Thread, attempt: CreationAttempt): boolean;
  refusal(error: unknown): CreationRefusal | null;
  refreshChoices(projectId: string, refusal: CreationRefusal): Promise<void>;
};
export type CreationState = {
  slot: CreationSlot | null;
  busy: boolean;
  issue: "storage" | "conflict" | "claimed" | "ambiguous" | "refused" | "mismatched" | null;
  editorEpoch: number;
};

export class CreationController {
  private state: CreationState = { slot: null, busy: false, issue: null, editorEpoch: 0 };
  private listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;
  private disposed = false;
  private get alive() {
    return !this.disposed && !this.ports.accountSignal.aborted;
  }
  private unsubscribe: () => void;

  constructor(
    readonly projectId: string | null,
    private continuity: FirstSendContinuity,
    private ports: CreationPorts,
  ) {
    this.unsubscribe = continuity.subscribeCreation(projectId, (slot) => this.change({ slot }));
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(patch: Partial<CreationState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private assertAlive() {
    if (!this.alive) throw new Error("Creation account closed");
  }
  dispose() {
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  load(): Promise<void> {
    if (!this.loading) this.loading = this.reload();
    return this.loading;
  }
  async reload(): Promise<void> {
    try {
      await this.queue;
      const slot = await this.continuity.readCreation(this.projectId);
      this.change({ slot, issue: null, editorEpoch: this.state.editorEpoch + 1 });
    } catch {
      this.change({ issue: "storage" });
    }
  }
  updateDraft(draft: ComposerDraftSnapshot | null): void {
    this.save((slot) => this.continuity.saveCreationDraft(this.projectId, slot.revision, draft));
  }

  updateChoices(choices: CreationChoices): void {
    if (
      this.state.busy ||
      (this.state.slot?.attempt && this.state.slot.attempt.phase !== "refused")
    )
      return;
    this.save((slot) =>
      this.continuity.saveCreationChoices(this.projectId, slot.revision, choices),
    );
  }

  private save(write: (slot: CreationSlot) => Promise<CreationSlotResult>): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.alive || !this.state.slot || this.state.issue === "conflict") return;
        const result = await write(this.state.slot);
        this.change({
          slot: result.slot,
          ...(result.kind === "conflict"
            ? { issue: "conflict" as const, editorEpoch: this.state.editorEpoch + 1 }
            : {}),
        });
      })
      .catch(() => {
        this.change({ issue: "storage" });
      });
  }

  /** Reserve before the first request. A resumed attempt always reconciles first. */
  async submit(input: {
    submission: ComposerSubmitEnvelope | null;
    title: string;
    workId: string | null;
    agentSlug: string;
  }): Promise<boolean> {
    if (this.state.busy || this.state.slot?.attempt || this.state.issue === "conflict")
      return false;
    return this.run(input);
  }
  async retry(choices?: { workId: string | null; agentSlug: string }): Promise<boolean> {
    return this.state.busy
      ? false
      : this.state.slot?.attempt?.phase === "ready"
        ? true
        : this.run(undefined, choices);
  }

  private async run(
    input?: {
      submission: ComposerSubmitEnvelope | null;
      title: string;
      workId: string | null;
      agentSlug: string;
    },
    repairChoices?: { workId: string | null; agentSlug: string },
  ): Promise<boolean> {
    this.change({ busy: true, issue: null });
    const locks = nativeLocks();
    let lease: Awaited<ReturnType<typeof tryAcquireExclusiveLock>> = null;
    let prepared: Awaited<ReturnType<CreationPorts["prepareAdmission"]>> | null = null;
    try {
      await this.load();
      await this.queue;
      this.assertAlive();
      if (!locks) {
        this.change({ issue: "claimed" });
        return false;
      }
      lease = await tryAcquireExclusiveLock(
        locks,
        `meridian:creation/${encodeURIComponent(this.continuity.accountId)}/${encodeURIComponent(this.projectId ?? "")}`,
      );
      if (!lease) {
        this.change({ issue: "claimed" });
        return false;
      }
      this.assertAlive();
      const persisted = await this.continuity.readCreation(this.projectId);
      if (persisted.revision !== this.state.slot?.revision) {
        this.change({
          slot: persisted,
          issue: "conflict",
          editorEpoch: this.state.editorEpoch + 1,
        });
        return false;
      }
      let attempt = persisted.attempt;
      if (attempt?.phase === "refused" && repairChoices) {
        const revised = await this.continuity.reviseRefusedCreation(
          this.projectId,
          attempt.attemptId,
          { ...repairChoices, ...persisted.choices },
        );
        this.change({ slot: revised.slot });
        if (revised.kind === "conflict") {
          this.change({ issue: "conflict" });
          return false;
        }
        attempt = revised.slot.attempt;
      }
      if (!attempt) {
        if (!input) return false;
        const created = await this.continuity.beginCreation(this.projectId, persisted.revision, {
          ...input,
          ...(input.submission ? persisted.choices : {}),
          attemptId: crypto.randomUUID(),
          projectId: this.projectId ?? crypto.randomUUID(),
          threadId: crypto.randomUUID(),
          phase: "creating",
        });
        this.change({ slot: created.slot });
        if (created.kind === "conflict") {
          this.change({ issue: "conflict" });
          return false;
        }
        attempt = created.slot.attempt;
      }
      if (!attempt) return false;
      this.assertAlive();
      let project = await this.ports.findProject(attempt.projectId);
      if (!project) {
        if (this.projectId !== null) throw new Error("Creation project is unavailable");
        this.assertAlive();
        try {
          project = await this.ports.createProject(attempt.projectId, attempt.title);
        } catch {
          this.assertAlive();
          project = await this.ports.findProject(attempt.projectId);
          if (!project) throw new Error("Project creation is uncertain");
        }
      }
      this.assertAlive();
      if (
        project.id !== attempt.projectId ||
        project.userId !== this.continuity.accountId ||
        !project.slug ||
        project.deletedAt !== null ||
        (this.projectId === null &&
          (project.title !== attempt.title || project.description !== null))
      ) {
        await this.settle(attempt, "mismatched");
        return false;
      }
      let thread = await this.ports.findThread(attempt.projectId, attempt.threadId);
      if (!thread) {
        this.assertAlive();
        try {
          thread = await this.ports.createThread(attempt);
        } catch (error) {
          this.assertAlive();
          const refusal = this.ports.refusal(error);
          if (refusal) {
            await this.settle(attempt, "refused", refusal);
            // A failed catalog refresh cannot turn a confirmed refusal into an uncertain create.
            await this.ports.refreshChoices(attempt.projectId, refusal).catch(() => undefined);
            return false;
          }
          thread = await this.ports.findThread(attempt.projectId, attempt.threadId);
          if (!thread) throw new Error("Chat creation is uncertain");
        }
      }
      this.assertAlive();
      if (!thread.slug || !this.ports.matchesThread(thread, attempt)) {
        await this.settle(attempt, "mismatched");
        return false;
      }
      await this.queue;
      this.assertAlive();
      prepared = await this.ports.prepareAdmission(project, thread, attempt, () =>
        this.assertAlive(),
      );
      this.assertAlive();
      const ready = await this.continuity.publishCreation(this.projectId, attempt.attemptId, {
        projectSlug: project.slug,
        threadSlug: thread.slug,
        optimisticUserTurnId: prepared.optimisticUserTurnId,
      });
      if (ready.kind === "conflict") prepared.cancel();
      prepared = null;
      this.change({ slot: ready.slot, issue: ready.kind === "conflict" ? "conflict" : null });
      return ready.kind === "saved";
    } catch {
      prepared?.cancel();
      const attempt = this.state.slot?.attempt;
      if (attempt && this.alive) {
        try {
          await this.settle(attempt, "ambiguous");
        } catch {
          this.change({ issue: "storage" });
        }
      } else this.change({ issue: "storage" });
      return false;
    } finally {
      await lease?.release();
      this.change({ busy: false });
    }
  }
  private async settle(
    attempt: CreationAttempt,
    phase: "ambiguous" | "refused" | "mismatched",
    refusal?: CreationRefusal,
  ) {
    const result = await this.continuity.settleCreation(this.projectId, attempt.attemptId, {
      phase,
      refusal,
    });
    this.change({ slot: result.slot, issue: phase });
  }
  async startOver() {
    await this.queue;
    const attempt = this.state.slot?.attempt;
    if (!attempt) return;
    const result = await this.continuity.clearMismatchedCreation(this.projectId, attempt.attemptId);
    this.change({ slot: result.slot, issue: result.kind === "saved" ? null : "conflict" });
  }
  async acknowledgeNavigation(attemptId: string) {
    if (this.state.slot?.attempt?.submission) return;
    await this.queue;
    const result = await this.continuity.finishCreation(this.projectId, attemptId);
    this.change({ slot: result.slot });
  }
}
