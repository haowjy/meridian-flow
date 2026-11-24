import { createHash } from "node:crypto";

export type WriterRow = {
  id: string;
  seq: number;
  delivered: boolean;
  byExecution: boolean;
  handedBackBy: string | null;
};

export type StopFacts = {
  execution: { id: string; holder: "assistant" | "compaction" | null } | null;
  receipt: readonly string[];
  rows: readonly WriterRow[];
  continuesWriterAnswer: boolean;
};

export type HandBackScopeFacts =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "seen"; seenThrough: number; mine: readonly string[] };

export type StopPress = {
  seenThrough: number;
  seenExecutionId: string | null;
  mine: readonly string[];
};

export type HandBackDecision = {
  handBack: string[];
  answered: string[];
  gone: string[];
};

export type StopDecision = HandBackDecision & {
  cancelExecutionId: string | null;
};

function covered(rows: readonly WriterRow[], scope: HandBackScopeFacts): WriterRow[] {
  const picked =
    scope.kind === "ids"
      ? new Set(scope.ids)
      : new Set([
          ...rows.filter((row) => row.seq <= scope.seenThrough).map((row) => row.id),
          ...scope.mine,
        ]);
  return rows.filter((row) => picked.has(row.id)).sort((left, right) => left.seq - right.seq);
}

function takesOn(facts: StopFacts, row: WriterRow): boolean {
  return facts.receipt.includes(row.id) || row.byExecution;
}

export function decideHandBack(
  facts: StopFacts,
  scope: HandBackScopeFacts,
  cancels: boolean,
): HandBackDecision {
  const decision: HandBackDecision = { handBack: [], answered: [], gone: [] };
  for (const row of covered(facts.rows, scope)) {
    const inReceipt = facts.receipt.includes(row.id);
    if (row.handedBackBy !== null) decision.gone.push(row.id);
    else if (!row.delivered && !inReceipt) decision.handBack.push(row.id);
    else if (!row.delivered && inReceipt && cancels && facts.execution?.holder === "compaction")
      decision.handBack.push(row.id);
    else decision.answered.push(row.id);
  }
  return decision;
}

export function decideStop(facts: StopFacts, press: StopPress): StopDecision {
  const scope: HandBackScopeFacts = {
    kind: "seen",
    seenThrough: press.seenThrough,
    mine: press.mine,
  };
  const inP = new Set(covered(facts.rows, scope).map((row) => row.id));
  const execution = facts.execution;
  const pressRows = facts.rows.filter((row) => inP.has(row.id));
  const laterRows = facts.rows.filter((row) => !inP.has(row.id));
  const cancels =
    execution !== null &&
    (execution.id === press.seenExecutionId ||
      facts.continuesWriterAnswer ||
      pressRows.some((row) => takesOn(facts, row))) &&
    !laterRows.some((row) => takesOn(facts, row));
  return {
    ...decideHandBack(facts, scope, cancels),
    cancelExecutionId: cancels ? execution.id : null,
  };
}

export type SendNowPress = {
  seenThrough: number;
  seenExecutionId: string;
  waiting: readonly string[];
};

export function decideSendNow(
  facts: StopFacts,
  press: SendNowPress,
): { cancelExecutionId: string | null } {
  const waiting = new Set(press.waiting);
  const execution = facts.execution;
  const cancels =
    execution !== null &&
    execution.id === press.seenExecutionId &&
    !facts.rows.some(
      (row) => (waiting.has(row.id) || row.seq > press.seenThrough) && takesOn(facts, row),
    );
  return { cancelExecutionId: cancels ? execution.id : null };
}

export function handBackFingerprint(body: {
  kind: "hand_back" | "stop";
  scope: HandBackScopeFacts;
  seenExecutionId?: string | null;
}): string {
  const scope =
    body.scope.kind === "ids"
      ? { kind: "ids", ids: [...body.scope.ids].sort() }
      : {
          kind: "seen",
          seenThrough: body.scope.seenThrough,
          mine: [...body.scope.mine].sort(),
        };
  return createHash("sha256")
    .update(
      JSON.stringify({ kind: body.kind, scope, seenExecutionId: body.seenExecutionId ?? null }),
    )
    .digest("hex");
}
