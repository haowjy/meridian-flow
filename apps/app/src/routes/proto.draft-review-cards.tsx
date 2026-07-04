/**
 * Proto route — draft-review sidebar hierarchy check at /proto/draft-review-cards.
 *
 * Public, no auth. THROWAWAY. Renders the sidebar's card states side by side
 * (banner, active card, resting card, dead cannot_place card) with hardcoded
 * data so the information hierarchy can be judged without driving the full
 * AI-draft flow. Delete after the design pass.
 */

import type { ReviewOperation } from "@meridian/contracts/drafts";
import { createFileRoute } from "@tanstack/react-router";

import { OperationCard, type OrderedOperation } from "@/features/editor/DraftReviewSidebar";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/proto/draft-review-cards")({
  component: DraftReviewCardsProto,
});

function op(input: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    rejectSourceUpdateIds: [],
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
    ...input,
  };
}

function entry(
  operation: ReviewOperation,
  input: Partial<OrderedOperation> = {},
): OrderedOperation {
  return {
    operation,
    hunks: [],
    firstPos: 1,
    shape: "insert",
    hasOwnDeletion: false,
    includesWriterEdits: false,
    ...input,
  };
}

const noop = () => undefined;

const cardBaseProps = {
  active: false,
  pending: false,
  dead: false,
  acceptAvailable: true,
  discardAvailable: true,
  confirmingAccept: false,
  confirmingDiscard: false,
  needsAcceptConfirm: false,
  needsOverlapConfirm: false,
  needsDiscardConfirm: false,
  acceptClosureEntries: [] as OrderedOperation[],
  rejectClosureEntries: [] as OrderedOperation[],
  onSelect: noop,
  onConfirmAccept: noop,
  onCancelAccept: noop,
  onAccept: noop,
  onConfirmDiscard: noop,
  onCancelDiscard: noop,
  onDiscard: noop,
};

const restingEntry = entry(
  op({
    operationId: "op-resting",
    classification: "rewrite",
    contribution: "rewrote",
    beforeExcerpt: "The courtyard was quiet.",
    afterExcerpt: "The courtyard held its breath, lanterns guttering.",
    actorTurnId: "turn-abc",
  }),
  { shape: "replace" },
);

const activeEntry = entry(
  op({
    operationId: "op-active",
    classification: "addition",
    afterExcerpt: "A crane cried once over the ridge, and the sect gates opened.",
    actorTurnId: "turn-abc",
  }),
);

const writerEntry = entry(
  op({
    operationId: "op-writer",
    kind: "writer",
    classification: "addition",
    afterExcerpt: "Li Wei tightened his grip on the jade token.",
  }),
);

const deadProposalText = "The jade phoenix landed on the ruined wall, folding wings of pale fire.";
const deadEntry = entry(
  op({
    operationId: "op-dead",
    classification: "addition",
    afterExcerpt: "The jade phoenix landed on the ruined wall…",
    actorTurnId: "turn-abc",
  }),
  {
    hunks: [
      {
        hunkId: "h-dead",
        operationIds: ["op-dead"],
        range: {
          from: 10,
          to: 84,
          hasDeletion: false,
          insertedTextByOperation: new Map([["op-dead", deadProposalText]]),
        },
        hasDeletion: false,
        insertedTextByOperation: new Map([["op-dead", deadProposalText]]),
      },
    ],
  },
);

const deadNoTextEntry = entry(
  op({
    operationId: "op-dead-notext",
    classification: "removal",
    contribution: "removed",
    beforeExcerpt: "He hesitated at the threshold.",
    actorTurnId: "turn-abc",
  }),
  { shape: "delete", hasOwnDeletion: true },
);

/** Mirror of the sidebar banner markup so tone reads in context. */
function Banner({ tone, text }: { tone: "error" | "info"; text: string }) {
  return (
    <p
      className={cn(
        "mb-3 rounded-md border px-3 py-2 text-xs",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-primary/25 bg-primary/10 text-jade-text",
      )}
    >
      {text}
    </p>
  );
}

function Rail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-meta uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <div className="flex h-full w-72 flex-col border border-border-subtle bg-surface-subtle">
        <header className="flex items-baseline gap-2 border-border-subtle border-b bg-background px-4 py-2">
          <p className="text-meta font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Proposals
          </p>
          <span className="ml-auto tabular-nums text-muted-foreground text-xs">4</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>
      </div>
    </div>
  );
}

function DraftReviewCardsProto() {
  return (
    <div className="min-h-svh w-full overflow-y-auto bg-background p-8 text-foreground">
      <h1 className="mb-6 text-lg font-semibold">Draft review sidebar — state comparison</h1>
      <div className="flex flex-wrap items-start gap-8">
        <Rail label="Mixed: banner + dead + active + resting">
          <Banner tone="info" text="A proposal no longer lines up with the manuscript." />
          <ol className="flex flex-col gap-3">
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={deadEntry} dead />
            </li>
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={activeEntry} active />
            </li>
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={restingEntry} />
            </li>
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={writerEntry} />
            </li>
          </ol>
        </Rail>

        <Rail label="Dead variants">
          <ol className="flex flex-col gap-3">
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={deadEntry} dead />
            </li>
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={deadNoTextEntry} dead />
            </li>
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={deadEntry} dead confirmingDiscard />
            </li>
          </ol>
        </Rail>

        <Rail label="Confirm + error banner">
          <Banner
            tone="error"
            text="Couldn't discard the proposal. Try again once the draft reconnects."
          />
          <ol className="flex flex-col gap-3">
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={activeEntry} active confirmingAccept />
            </li>
            <li className="flex flex-col gap-1">
              <OperationCard {...cardBaseProps} entry={restingEntry} confirmingDiscard />
            </li>
          </ol>
        </Rail>
      </div>
    </div>
  );
}
