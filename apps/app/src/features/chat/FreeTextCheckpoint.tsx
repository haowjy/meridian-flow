// @ts-nocheck
/**
 * FreeTextCheckpoint — inline ask_user checkpoint for open text answers.
 *
 * Purpose: renders the `kind:"free-text"` custom block as a waiting text form,
 * then as a compact resolved summary once checkpoint lifecycle events patch the
 * block props. The form submits the component-protocol `{ value }` payload only;
 * renderer-level wiring adds thread, turn, and checkpoint ids.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { askUserFreeTextProps } from "@meridian/contracts/components";
import { MessageSquareText } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Input } from "@/components/ui/input";
import type { ComponentBlockProps } from "./component-registry";

export function FreeTextCheckpoint({ content, respond, isAwaitingResponse }: ComponentBlockProps) {
  const props = askUserFreeTextProps(content);
  const question = props?.question ?? t`Answer the question`;
  const recommended = props?.recommended ?? "";
  const hasResolvedValue = props?.resolvedValue !== undefined;
  const resolvedValue = hasResolvedValue ? (props?.resolvedValue ?? t`No answer`) : null;
  const provenance = props?.answerProvenance ?? null;
  const [value, setValue] = useState(recommended);
  const [submitted, setSubmitted] = useState(false);

  if (!isAwaitingResponse && hasResolvedValue) {
    return (
      <ResolvedTextSummary
        question={question}
        answer={resolvedValue ?? t`No answer`}
        provenance={provenance}
      />
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted) return;
    setSubmitted(true);
    respond({ value });
  }

  return (
    <section className="mb-4 rounded-lg border border-border-subtle bg-card p-3 shadow-xs">
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface-subtle text-primary">
          <MessageSquareText className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{question}</p>
          {recommended ? (
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans>Suggested text is prefilled; edit it before submitting if needed.</Trans>
            </p>
          ) : null}
        </div>
      </div>

      <form className="flex gap-2" onSubmit={handleSubmit}>
        <Input
          value={value}
          disabled={!isAwaitingResponse || submitted}
          aria-label={question}
          placeholder={t`Type your answer…`}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 border-border-subtle bg-surface-subtle"
        />
        <button
          type="submit"
          disabled={!isAwaitingResponse || submitted}
          className="focus-ring inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-button transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trans>Submit</Trans>
        </button>
      </form>
    </section>
  );
}

function ResolvedTextSummary({
  question,
  answer,
  provenance,
}: {
  question: string;
  answer: string;
  provenance: "user" | "auto" | null;
}) {
  return (
    <section className="mb-4 rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2">
      <p className="text-xs text-muted-foreground">{question}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-foreground">
        <span className="font-medium">{answer}</span>
        <span className="status-pill">
          {provenance === "auto" ? <Trans>auto-selected</Trans> : <Trans>you answered</Trans>}
        </span>
      </div>
    </section>
  );
}
