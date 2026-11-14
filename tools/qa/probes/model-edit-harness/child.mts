/**
 * One composed server process for the model-edit crash probes: the production ports and services
 * over the scratch database, a mock model, and the test hook points. The parent drives it with
 * JSON lines on stdin and reads JSON lines from stdout (`harness.mts` has both ends).
 *
 *   {op:"script", script}            queue scripted model replies
 *   {op:"arm", point, action, nth?}  "kill": SIGKILL on the nth arrival; "hold": wait for release
 *   {op:"release", point}
 *   {op:"send", threadId, userId, text}   admit a message, as the chat route does
 *   {op:"sweep"}                     the recovery lanes once: wake scan, orphan repair
 *   {op:"reverse", threadId, userId, turnId, commandId, direction}   a chat card's Undo or Redo, as the route sends it
 *   {op:"resolve", responseId, toolCallId, accountId, projectId}   settle a model call's key, as recovery does
 *   {op:"discard", projectId, branchId, userId, commandId}   Discard all on a Work's branch
 *   {op:"timeout", tool, ms}        shorten a tool's registered timeout, for the timeout cases
 *   {op:"exit"}
 *
 * Output: {event:"ready"} once composed, {event:"at", point} on each armed point, {id, ok, ...}
 * answering each op that carries an `id`.
 */
import { createInterface } from "node:readline";
import { createDb } from "@meridian/database";
import { NoopEventSink } from "../../../../apps/server/server/domains/observability/index.ts";
import { processDetachedWork } from "../../../../apps/server/server/domains/runtime/detached-work.ts";
import {
  handleDiscardAllWorkBranchRequest,
  selectBranchRouteServices,
} from "../../../../apps/server/server/lib/branch-review-route.ts";
import {
  composeAppServices,
  createProductionAppPorts,
} from "../../../../apps/server/server/lib/compose.ts";
import { reverseTurnCard } from "../../../../apps/server/server/lib/work-receipt-reversal.ts";
import {
  createYjsGateway,
  selectYjsGatewayServices,
} from "../../../../apps/server/server/lib/yjs-ws-handler.ts";
import {
  setTestHook,
  type TestHookPoint,
} from "../../../../apps/server/server/shared/test-hooks.ts";

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

/** With `CHILD_EVENTS=1`, warnings and errors go to stderr: why a run failed. */
class StderrEventSink extends NoopEventSink {
  override emit(event: { level?: string; source?: string; name?: string; payload?: unknown }) {
    if (process.env.CHILD_EVENTS && (event.level === "warn" || event.level === "error"))
      process.stderr.write(
        `child ${event.level} ${event.source} ${event.name} ${JSON.stringify(event.payload)}\n`,
      );
  }
}

// A pool of 2: a second connection opened inside a model edit would hang here, not in production.
// The application name lets the parent find this process's connections in `pg_stat_activity`.
const db = createDb(process.env.DATABASE_URL as string, {
  max: Number(process.env.CHILD_POOL ?? 2),
  postgres: { connection: { application_name: process.env.CHILD_NAME } },
});
const ports = await createProductionAppPorts({
  db,
  backgroundTasks: processDetachedWork,
  eventSink: new StderrEventSink(),
  // No provider key composes the mock model; its script queue needs the debug gate.
  environment: { APP_DEBUG: "1", NODE_ENV: "test" },
});
const app = composeAppServices(ports);
// The gateway binds the Hocuspocus instance the collab domain's rooms live in.
const yjs = createYjsGateway(selectYjsGatewayServices(app as never));

const held = new Map<string, () => void>();
const seen = new Map<string, number>();
function arm(point: TestHookPoint, action: "kill" | "hold", nth: number) {
  setTestHook(point, async () => {
    const count = (seen.get(point) ?? 0) + 1;
    seen.set(point, count);
    if (count !== nth) return;
    emit({ event: "at", point, action });
    if (action === "kill") process.kill(process.pid, "SIGKILL");
    await new Promise<void>((release) => held.set(point, release));
  });
}

type Op = { id?: number } & (
  | { op: "script"; script: Parameters<NonNullable<typeof app.mockModelScript>["enqueue"]>[0] }
  | { op: "arm"; point: TestHookPoint; action: "kill" | "hold"; nth?: number }
  | { op: "release"; point: string }
  | { op: "send"; threadId: string; userId: string; text: string }
  | {
      op: "reverse";
      threadId: string;
      userId: string;
      turnId: string;
      commandId: string;
      direction: "undo" | "redo";
    }
  | {
      op: "resolve";
      responseId: string;
      toolCallId: string;
      accountId: string;
      projectId: string;
    }
  | { op: "discard"; projectId: string; branchId: string; userId: string; commandId: string }
  | { op: "timeout"; tool: string; ms: number }
  | { op: "sweep" | "exit" }
);

async function handle(message: Op): Promise<unknown> {
  switch (message.op) {
    case "script":
      return app.mockModelScript?.enqueue(message.script);
    case "arm":
      arm(message.point, message.action, message.nth ?? 1);
      return null;
    case "release":
      held.get(message.point)?.();
      held.delete(message.point);
      return null;
    case "send":
      if (!(await ports.agentRevisions.readThreadBinding(message.threadId)))
        await ports.agentRevisions.bindThread(
          message.threadId,
          null,
          {
            model: "mock-llm-v1",
            skills: { load: [], available: [] },
            namedTargets: [],
            permission: "edit",
          },
          null,
        );
      return app.userTurnAdmission.admit({
        actorUserId: message.userId,
        threadId: message.threadId,
        submissionId: crypto.randomUUID(),
        text: message.text,
        blocks: [{ type: "text", text: message.text }],
        references: [],
        activatedSkillSlugs: [],
      });
    case "reverse":
      return reverseTurnCard(app, message as never);
    case "resolve":
      return ports.documentSync.modelEdits().resolve({
        responseId: message.responseId,
        toolCallId: message.toolCallId,
        accountId: message.accountId as never,
        projectId: message.projectId as never,
      });
    case "discard":
      return handleDiscardAllWorkBranchRequest(selectBranchRouteServices(app), {
        projectId: message.projectId as never,
        branchId: message.branchId as never,
        userId: message.userId as never,
        request: { branchId: message.branchId, commandId: message.commandId },
      });
    case "timeout": {
      const registration = app.toolRegistry.getRegistration(message.tool);
      if (!registration) throw new Error(`no tool ${message.tool}`);
      (registration as { timeoutMs?: number }).timeoutMs = message.ms;
      return null;
    }
    case "sweep":
      await app.recovery.repairOrphans();
      return app.recovery.scanWakes();
    case "exit":
      await yjs.drain();
      await app.shutdown();
      process.exit(0);
  }
  throw new Error(`unknown op ${message.op}`);
}

emit({ event: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  // Not awaited: an op held at a point must not block the next op, `release` above all.
  handle(message).then(
    (result) => emit({ id: message.id, ok: true, result }),
    (error) => emit({ id: message.id, ok: false, error: String(error?.stack ?? error) }),
  );
}
