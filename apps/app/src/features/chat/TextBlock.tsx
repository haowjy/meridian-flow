/**
 * TextBlock — inline ask_user component block for open text answers.
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
import { ComponentCard, ComponentResolvedSummary } from "./ComponentCard";
import type { ComponentBlockProps } from "./component-registry";

export function TextBlock({ content, respond, isAwaitingResponse }: ComponentBlockProps) {
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
      <ComponentResolvedSummary
        icon={MessageSquareText}
        title={question}
        value={resolvedValue ?? t`No answer`}
        statusLabel={
          provenance === "auto" ? <Trans>auto-selected</Trans> : <Trans>you answered</Trans>
        }
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
    <ComponentCard
      icon={MessageSquareText}
      tone="pending"
      title={question}
      hint={
        recommended ? (
          <Trans>Suggested text is prefilled; edit it before submitting if needed.</Trans>
        ) : undefined
      }
    >
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
    </ComponentCard>
  );
}
