/**
 * The composer takeover for an open ask: a question (options, own words, Skip, the deadline) or a
 * permission request (Deny, Allow always, Allow). Both draw in one frame, in the box's place, so
 * the writer learns it once; only the controls differ.
 */
import { plural, t } from "@lingui/core/macro";
import type { AskAnswer, ThreadAsk } from "@meridian/contracts/threads";
import type { OpenAsk } from "@meridian/thread-client";
import { ArrowUp } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { FailureCard } from "@/components/app/FailureCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type QuestionAsk = Extract<ThreadAsk, { kind: "question" }>;
type PermissionAsk = Extract<ThreadAsk, { kind: "permission" }>;

export type AskTakeoverProps = {
  open: OpenAsk;
  agentName: string;
  /** The own-answer field's text. The host holds it, so it outlives the takeover. */
  text: string;
  onTextChange: (text: string) => void;
  onAnswer: (answer: AskAnswer) => void;
  /** Read the chat again: the server closed the ask without saying how. */
  onSettle: () => void;
};

export function AskTakeover({
  open,
  agentName,
  text,
  onTextChange,
  onAnswer,
  onSettle,
}: AskTakeoverProps) {
  const { ask, attempt } = open;
  if (attempt?.state === "unsettled") {
    // The ask is closed; only how it ended is unknown. Nothing here may answer it again.
    return (
      <>
        <div className="mb-[var(--chat-space-inline)]">
          <FailureCard tone="error">
            <p className="min-w-0 flex-1">{t`Couldn't check how this question ended.`}</p>
            <Button type="button" size="xs" variant="outline" onClick={onSettle}>
              {t`Refresh`}
            </Button>
          </FailureCard>
        </div>
        <ClosedTakeover ask={ask} agentName={agentName} />
      </>
    );
  }
  const failed = attempt?.state === "failed" ? attempt : null;
  const failure = failed ? (
    <FailureCard tone="error">
      <p className="min-w-0 flex-1">{t`Couldn't send your answer.`}</p>
      <Button type="button" size="xs" variant="outline" onClick={() => onAnswer(failed.answer)}>
        {t`Retry`}
      </Button>
    </FailureCard>
  ) : null;
  return (
    <>
      {failure ? <div className="mb-[var(--chat-space-inline)]">{failure}</div> : null}
      {ask.kind === "question" ? (
        <QuestionTakeover
          ask={ask}
          picked={failed?.answer.kind === "option" ? failed.answer.label : null}
          text={text}
          onTextChange={onTextChange}
          onAnswer={onAnswer}
        />
      ) : (
        <PermissionTakeover ask={ask} agentName={agentName} onAnswer={onAnswer} />
      )}
    </>
  );
}

function TakeoverFrame({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  // The box this replaces may have held focus; hiding it would drop focus on the page.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("[data-composer]")) return;
    const target =
      frame.current?.querySelector<HTMLElement>("textarea") ??
      frame.current?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={frame}
      aria-labelledby={labelledBy}
      data-ask-takeover=""
      className="flex flex-col gap-[var(--chat-space-block)] rounded-composer-pinned border border-composer-border bg-composer-surface px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]"
    >
      {children}
    </section>
  );
}

/** The ask's title alone: it can no longer be answered here. */
function ClosedTakeover({ ask, agentName }: { ask: ThreadAsk; agentName: string }) {
  const titleId = useId();
  return (
    <TakeoverFrame labelledBy={titleId}>
      <TakeoverTitle id={titleId}>
        {ask.kind === "question"
          ? ask.payload.question
          : t`${agentName} wants to ${ask.payload.summary}?`}
      </TakeoverTitle>
    </TakeoverFrame>
  );
}

function TakeoverTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="px-[var(--chat-space-inline)] text-body font-medium text-pretty">
      {children}
    </h2>
  );
}

function QuestionTakeover({
  ask,
  picked,
  text,
  onTextChange,
  onAnswer,
}: {
  ask: QuestionAsk;
  /** The option a failed answer picked, shown as picked while Retry is offered. */
  picked: string | null;
  text: string;
  onTextChange: (text: string) => void;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const titleId = useId();
  const { question, options, recommended } = ask.payload;
  const sendText = () => {
    const answer = text.trim();
    if (answer) onAnswer({ kind: "text", text: answer });
  };
  return (
    <TakeoverFrame labelledBy={titleId}>
      <TakeoverTitle id={titleId}>{question}</TakeoverTitle>
      <ul className="flex flex-col gap-[var(--chat-space-inline)]">
        {options.map((option) => (
          <li key={option.label}>
            <button
              type="button"
              aria-pressed={picked === option.label ? true : undefined}
              onClick={() => onAnswer({ kind: "option", label: option.label })}
              className={cn(
                "focus-ring flex w-full items-start gap-[var(--chat-space-block)] rounded-field border border-border-subtle bg-background px-[var(--chat-space-block)] py-[var(--chat-space-inline)] text-left transition-colors hover:border-border-focus hover:bg-accent",
                picked === option.label && "border-border-focus",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-compact font-medium text-foreground">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="block text-caption text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {option.label === recommended ? (
                <Badge variant="label" className="mt-0.5">
                  {t`Recommended`}
                </Badge>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-[var(--chat-space-inline)] rounded-field border border-border-subtle bg-background py-1 pr-1 pl-[var(--chat-space-block)] focus-within:border-border-focus">
        <textarea
          aria-label={t`Your own answer`}
          placeholder={t`Or type your own answer`}
          rows={1}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            sendText();
          }}
          className="field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-compact outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="button"
          size="icon-sm"
          className="rounded-field"
          aria-label={t`Send answer`}
          disabled={!text.trim()}
          onClick={sendText}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-[var(--chat-space-block)]">
        <Button type="button" variant="quiet" size="sm" onClick={() => onAnswer({ kind: "skip" })}>
          {t`Skip`}
        </Button>
        {ask.deadlineAt ? <Countdown deadlineAt={ask.deadlineAt} /> : null}
      </div>
    </TakeoverFrame>
  );
}

/** Time left before the question continues on its own; "Continuing…" at zero, until the server says how. */
function Countdown({ deadlineAt }: { deadlineAt: string }) {
  const deadline = Date.parse(deadlineAt);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, deadline - now);
  useEffect(() => {
    if (left === 0) return;
    // Wake on the next whole second of the countdown, so the label never runs a second behind.
    const timer = setTimeout(() => setNow(Date.now()), left % 1000 || 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const seconds = Math.ceil(left / 1000);
  const label =
    seconds === 0
      ? t`Continuing…`
      : seconds >= 60
        ? plural(Math.floor(seconds / 60), {
            one: "Continues in # min",
            other: "Continues in # min",
          })
        : plural(seconds, { one: "Continues in # second", other: "Continues in # seconds" });
  return (
    <p className="ml-auto text-caption text-muted-foreground tabular-nums" data-ask-countdown="">
      {label}
    </p>
  );
}

function PermissionTakeover({
  ask,
  agentName,
  onAnswer,
}: {
  ask: PermissionAsk;
  agentName: string;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const titleId = useId();
  const { summary } = ask.payload;
  return (
    <TakeoverFrame labelledBy={titleId}>
      <TakeoverTitle id={titleId}>{t`${agentName} wants to ${summary}?`}</TakeoverTitle>
      <div className="flex flex-wrap items-center gap-[var(--chat-space-inline)]">
        <Button type="button" variant="quiet" size="sm" onClick={() => onAnswer({ kind: "deny" })}>
          {t`Deny`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => onAnswer({ kind: "allow_always" })}
        >
          {t`Allow always`}
        </Button>
        <Button type="button" size="sm" onClick={() => onAnswer({ kind: "allow" })}>
          {t`Allow`}
        </Button>
      </div>
    </TakeoverFrame>
  );
}
