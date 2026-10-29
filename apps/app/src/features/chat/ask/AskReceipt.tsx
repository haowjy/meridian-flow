/**
 * What a resolved ask leaves on its asking turn, or this device's answer while it sends: one line
 * for one question or a permission request; for several questions a count of how they went, which
 * opens to each question with its answer.
 */
import { plural, t } from "@lingui/core/macro";
import type {
  PermissionAskPayload,
  QuestionAskPayload,
  ResolvedQuestionAnswer,
} from "@meridian/contracts/threads";
import type { AskReceipt as AskReceiptFacts } from "@meridian/thread-client";
import { ChevronRight, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useAskReceipt } from "@/client/stores";
import { cn } from "@/lib/utils";
import { permissionRequestText } from "./permission-request";

export function AskReceipt({ threadId, turnId }: { threadId: string; turnId: string }) {
  const receipt = useAskReceipt(threadId, turnId);
  if (!receipt) return null;
  const { ask } = receipt;
  if (ask.kind === "question" && ask.payload.questions.length > 1)
    return <QuestionsReceipt receipt={receipt} questions={ask.payload.questions} />;
  const asked =
    ask.kind === "question" ? ask.payload.questions[0].question : permissionAsked(ask.payload);
  return (
    <ReceiptLine receipt={receipt}>
      {/* Inline, so a narrow column wraps the answer under the question instead of cutting both. */}
      <span className="line-clamp-2 min-w-0">
        <span className="text-muted-foreground">{asked}</span>{" "}
        <Answer pending={receipt.pending}>{answerText(receipt)}</Answer>
        <Sending pending={receipt.pending} />
      </span>
    </ReceiptLine>
  );
}

function ReceiptLine({ receipt, children }: { receipt: AskReceiptFacts; children: ReactNode }) {
  const Icon = receipt.ask.kind === "question" ? MessageCircleQuestion : ShieldCheck;
  return (
    <div
      className="flex min-w-0 items-start gap-[var(--chat-space-inline)] text-compact"
      data-ask-receipt=""
      data-ask-pending={receipt.pending ? "" : undefined}
    >
      <Icon className="mt-1 size-3.5 shrink-0 text-ink-subtle" aria-hidden />
      {children}
    </div>
  );
}

function Answer({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <span className={cn("font-medium text-foreground", pending && "opacity-60")}>{children}</span>
  );
}

function Sending({ pending }: { pending: boolean }) {
  if (!pending) return null;
  return (
    <>
      <span className="sr-only">{t`Sending`}</span>
      <span
        aria-hidden
        className="ml-[var(--chat-space-inline)] inline-block size-1.5 -translate-y-px rounded-full bg-status-live-foreground align-middle motion-safe:animate-pulse"
      />
    </>
  );
}

/** Several questions: how they went, opening to each question and its answer. */
function QuestionsReceipt({
  receipt,
  questions,
}: {
  receipt: AskReceiptFacts;
  questions: QuestionAskPayload["questions"];
}) {
  const [open, setOpen] = useState(false);
  const count = questions.length;
  const panelId = useId();
  const { resolution, pending } = receipt;
  const answers =
    resolution.kind === "answers" || resolution.kind === "timeout" ? resolution.answers : null;
  return (
    <ReceiptLine receipt={receipt}>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="focus-ring -mx-1 flex max-w-full items-start gap-[var(--chat-space-inline)] rounded-md px-1 text-left transition-colors hover:bg-muted"
        >
          <span className="min-w-0">
            <span className="text-muted-foreground">
              {plural(count, { one: "# question:", other: "# questions:" })}
            </span>{" "}
            <Answer pending={pending}>
              {answers ? outcomeSummary(answers) : answerText(receipt)}
            </Answer>
            <Sending pending={pending} />
          </span>
          <ChevronRight
            className={cn(
              "mt-1 size-3 shrink-0 text-ink-subtle transition-transform duration-200",
              open && "rotate-90",
            )}
            aria-hidden
          />
        </button>
        <ol
          id={panelId}
          hidden={!open}
          className="mt-[var(--chat-space-inline)] flex flex-col gap-[var(--chat-space-inline)]"
        >
          {questions.map((item, index) => (
            // Questions are fixed for the ask's life; their order is their identity.
            <li key={index}>
              <span className="text-muted-foreground">{item.question}</span>
              {answers?.[index] ? (
                <>
                  {" "}
                  <Answer pending={pending}>{questionAnswerText(answers[index])}</Answer>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </ReceiptLine>
  );
}

/** How a set of answers went, in counts: answered, skipped, left to the timeout. */
function outcomeSummary(answers: readonly ResolvedQuestionAnswer[]): string {
  const count = (kinds: ResolvedQuestionAnswer["kind"][]) =>
    answers.filter((answer) => kinds.includes(answer.kind)).length;
  const answered = count(["option", "text"]);
  const skipped = count(["skipped"]);
  const unanswered = count(["timeout"]);
  return [
    answered ? plural(answered, { one: "# answered", other: "# answered" }) : null,
    skipped ? plural(skipped, { one: "# skipped", other: "# skipped" }) : null,
    unanswered ? plural(unanswered, { one: "# unanswered", other: "# unanswered" }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(t`, `);
}

function answerText({ resolution }: AskReceiptFacts): string {
  switch (resolution.kind) {
    case "answers":
    case "timeout":
      // One question's receipt; several draw through `outcomeSummary`.
      return questionAnswerText(resolution.answers[0]);
    case "cancelled":
      return t`Withdrawn`;
    case "allow":
      return t`Allowed`;
    case "allow_always":
      return t`Allowed always`;
    case "deny":
      return t`Denied`;
  }
}

function questionAnswerText(answer: ResolvedQuestionAnswer): string {
  switch (answer.kind) {
    case "option":
      return answer.label;
    case "text":
      return answer.text;
    case "skipped":
      return t`Skipped`;
    case "timeout":
      return answer.label ? t`No answer, went with ${answer.label}` : t`No answer`;
  }
}

function permissionAsked(payload: PermissionAskPayload): string {
  const { title, details } = permissionRequestText(payload);
  return [title, ...details].join(t`, `);
}
