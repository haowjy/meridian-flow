import { createInterface } from "node:readline";
import { createDb } from "@meridian/database";
import { NoopEventSink } from "../../../../apps/server/server/domains/observability/index.ts";
import {
  composeAppServices,
  createProductionAppPorts,
} from "../../../../apps/server/server/lib/compose.ts";
import { reverseTurnCard } from "../../../../apps/server/server/lib/work-receipt-reversal.ts";
import {
  setTestHook,
  type TestHookPoint,
} from "../../../../apps/server/server/shared/test-hooks.ts";

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

class StderrEventSink extends NoopEventSink {
  override emit(event: { level?: string; source?: string; name?: string; payload?: unknown }) {
    if (process.env.CHILD_EVENTS && (event.level === "warn" || event.level === "error"))
      process.stderr.write(
        `child ${event.level} ${event.source} ${event.name} ${JSON.stringify(event.payload)}\n`,
      );
  }
}

const db = createDb(process.env.DATABASE_URL as string, {
  max: Number(process.env.CHILD_POOL ?? 2),
  postgres: { connection: { application_name: process.env.CHILD_NAME } },
});
const ports = await createProductionAppPorts({
  db,
  eventSink: new StderrEventSink(),
  environment: { APP_DEBUG: "1", NODE_ENV: "test" },
});
const app = composeAppServices(ports);

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
  | { op: "send"; threadId: string; userId: string; text: string; disallowedTools?: string[] }
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
      threadId: string;
      responseId: string;
      toolCallId: string;
      accountId: string;
      projectId: string;
    }
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
            ...(message.disallowedTools ? { "disallowed-tools": message.disallowedTools } : {}),
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
        threadId: message.threadId as never,
        responseId: message.responseId,
        toolCallId: message.toolCallId,
        accountId: message.accountId as never,
        projectId: message.projectId as never,
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
      await app.shutdown();
      process.exit(0);
  }
  throw new Error(`unknown op ${message.op}`);
}

emit({ event: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  handle(message).then(
    (result) => emit({ id: message.id, ok: true, result }),
    (error) => emit({ id: message.id, ok: false, error: String(error?.stack ?? error) }),
  );
}
