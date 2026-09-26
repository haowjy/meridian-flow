/**
 * FormBlock — schema-driven ask_user component block.
 *
 * Purpose: renders any `AskRequest` payload that flows through the
 * `componentContentForAsk` builder. ZERO domain vocabulary: the prompt,
 * artifacts, and form fields come entirely from the package-supplied
 * `request.prompt` / `artifacts` / `answerSchema`. The same card renders any
 * future package's interrupt unchanged.
 *
 * Key decisions:
 *  - Artifact thumbnails: `image` arms render as inline images (click to
 *    enlarge in a dialog); `object` arms as labeled refs (a download chip);
 *    `liveView` arms as a isolated `<iframe>` slot. Nothing produces
 *    `liveView` today — the slot is reserved per execution-model §8.4 so
 *    when the live-preview probe goes green the overlay drops in
 *    without a contract or card change.
 *  - Form generated from `answerSchema` via `interruptFieldsFromSchema`,
 *    which owns the supported JSON-Schema subset. Required-field validation
 *    blocks empty submits.
 *  - On submit the card emits the full answer object (one property per
 *    field, keyed by schema property name); `CustomBlockRenderer` adds the
 *    interrupt correlation tuple.
 *  - Resolved/auto-resumed interrupts render a compact summary so the chat
 *    history reads as a conversation, not a stack of expired forms.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import { Pause } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ArtifactCard, ComponentResolvedSummary } from "./ArtifactCard";
import { ArtifactGrid, isArtifactRef } from "./ArtifactGrid";
import type { ComponentBlockProps } from "./component-registry";
import { InterruptResponseFeedback } from "./InterruptResponseFeedback";
import {
  type InterruptField,
  type InterruptFormErrors,
  type InterruptFormValues,
  initialFormValues,
  interruptFieldsFromSchema,
  validateFormValues,
} from "./interrupt-form-schema";

type InterruptProps = {
  prompt: string;
  artifacts: ArtifactRef[];
  fields: InterruptField[];
  recommended: import("@meridian/contracts/threads").JsonValue | null;
};

function readInterruptProps(content: ComponentBlockProps["content"]): InterruptProps | null {
  if (content.kind !== "form") return null;
  const props = content.props;

  const prompt = typeof props.prompt === "string" ? props.prompt : "";
  if (prompt.length === 0) return null;

  const answerSchemaRaw = props.answerSchema;
  if (!answerSchemaRaw || typeof answerSchemaRaw !== "object" || Array.isArray(answerSchemaRaw)) {
    return null;
  }
  const fields = interruptFieldsFromSchema(answerSchemaRaw);

  const artifactsRaw = props.artifacts;
  const artifacts: ArtifactRef[] = Array.isArray(artifactsRaw)
    ? artifactsRaw.filter(isArtifactRef)
    : [];

  const recommended = props.recommended ?? null;
  return { prompt, artifacts, fields, recommended };
}

export function FormBlock({
  content,
  respond,
  isAwaitingResponse,
  responseState,
  retry,
}: ComponentBlockProps) {
  const parsed = readInterruptProps(content);
  const hasResolvedValue = Object.hasOwn(content.props, "resolvedValue");
  const resolvedValue =
    typeof content.props.resolvedValue === "string" ? content.props.resolvedValue : null;
  const provenance =
    content.props.answerProvenance === "user" || content.props.answerProvenance === "auto"
      ? content.props.answerProvenance
      : null;

  if (!parsed) {
    return (
      <ArtifactCard icon={Pause} tone="resolved" title={t`Form payload is malformed.`}>
        <p className="text-xs text-muted-foreground">
          <Trans>Form payload is malformed.</Trans>
        </p>
      </ArtifactCard>
    );
  }

  if (!isAwaitingResponse && hasResolvedValue) {
    return (
      <ComponentResolvedSummary
        icon={Pause}
        title={parsed.prompt}
        value={resolvedValue ?? t`No answer`}
        statusLabel={
          provenance === "auto" ? <Trans>auto-selected</Trans> : <Trans>you answered</Trans>
        }
      />
    );
  }

  return (
    <InterruptForm
      prompt={parsed.prompt}
      artifacts={parsed.artifacts}
      fields={parsed.fields}
      recommended={parsed.recommended}
      isAwaitingResponse={isAwaitingResponse}
      respond={respond}
      responseState={responseState}
      retry={retry}
    />
  );
}

function InterruptForm({
  prompt,
  artifacts,
  fields,
  recommended,
  isAwaitingResponse,
  respond,
  responseState,
  retry,
}: InterruptProps & {
  isAwaitingResponse: boolean;
  respond: ComponentBlockProps["respond"];
  responseState: ComponentBlockProps["responseState"];
  retry: ComponentBlockProps["retry"];
}) {
  const [values, setValues] = useState<InterruptFormValues>(() =>
    initialFormValues(fields, recommended),
  );
  const [errors, setErrors] = useState<InterruptFormErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const responseLocked = responseState !== null;
  const formDisabled = !isAwaitingResponse || responseLocked || submitted;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formDisabled) return;
    const { errors: nextErrors, answer } = validateFormValues(fields, values);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSubmitted(true);
    respond(answer);
  }

  function handleStop() {
    if (formDisabled) return;
    setSubmitted(true);
    // The "stop" path emits an explicit { stop: true } envelope so the
    // package can short-circuit instead of consuming a half-filled answer.
    // The package decides what stop means; the card only signals intent.
    respond({ stop: true });
  }

  return (
    <ArtifactCard icon={Pause} tone="pending" title={prompt}>
      {artifacts.length > 0 ? (
        <div className="mb-3 border-border-subtle border-b pb-3">
          <ArtifactGrid artifacts={artifacts} />
        </div>
      ) : null}

      <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
        {fields.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            <Trans>No fields required; confirm to continue.</Trans>
          </p>
        ) : (
          fields.map((field) => (
            <FieldRow
              key={field.name}
              field={field}
              value={values[field.name]}
              error={errors[field.name]}
              disabled={formDisabled}
              onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
            />
          ))
        )}

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={formDisabled}
            className="focus-ring inline-flex items-center rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm shadow-button transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trans>Confirm</Trans>
          </button>
          <button
            type="button"
            disabled={formDisabled}
            onClick={handleStop}
            className="focus-ring inline-flex items-center rounded-md border border-border-subtle bg-muted px-3 py-1.5 font-medium text-foreground text-sm transition-all hover:bg-card disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trans>Stop run</Trans>
          </button>
        </div>
      </form>
      <InterruptResponseFeedback state={responseState} onRetry={retry} />
    </ArtifactCard>
  );
}

function FieldRow({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: InterruptField;
  value: string | number | boolean | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const inputId = `interrupt-field-${field.name}`;
  const labelText = field.name;
  const requiredHint = field.required ? <span aria-hidden> *</span> : null;
  const descriptionId = field.description ? `${inputId}-desc` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-medium text-foreground text-sm">
        {labelText}
        {requiredHint}
      </label>
      {field.description ? (
        <p id={descriptionId} className="text-muted-foreground text-xs">
          {field.description}
        </p>
      ) : null}
      <FieldInput
        field={field}
        inputId={inputId}
        value={value}
        disabled={disabled}
        describedBy={describedBy}
        onChange={onChange}
      />
      {field.defaultValue !== undefined ? (
        <p className="text-muted-foreground text-xs">
          <Trans>Suggested: {String(field.defaultValue)}</Trans>
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-destructive text-xs" role="alert">
          <FieldErrorText error={error} />
        </p>
      ) : null}
    </div>
  );
}

function FieldInput({
  field,
  inputId,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  field: InterruptField;
  inputId: string;
  value: string | number | boolean | undefined;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (value: string | number | boolean) => void;
}): ReactNode {
  if (field.kind === "enum") {
    const placeholder = t`Select…`;
    return (
      <select
        id={inputId}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "focus-ring rounded-md border border-border-subtle bg-muted px-2 py-1.5 text-foreground text-sm",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <option value="">{placeholder}</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.kind === "boolean") {
    return (
      <label className="inline-flex items-center gap-2 text-foreground text-sm">
        <input
          id={inputId}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 rounded border-border-subtle"
        />
        <Trans>Enabled</Trans>
      </label>
    );
  }

  if (field.kind === "number" || field.kind === "integer") {
    return (
      <Input
        id={inputId}
        type="number"
        inputMode={field.kind === "integer" ? "numeric" : "decimal"}
        step={field.kind === "integer" ? 1 : "any"}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") {
            onChange("");
            return;
          }
          const num = Number(raw);
          onChange(Number.isNaN(num) ? raw : num);
        }}
        className="bg-muted"
      />
    );
  }

  // string
  return (
    <Input
      id={inputId}
      type="text"
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className="bg-muted"
    />
  );
}

/**
 * Translate the validator's machine-readable error sentinels into localized
 * UI copy. The validator returns plain strings so it stays pure and easy to
 * test; localization is the renderer's job.
 */
function FieldErrorText({ error }: { error: string }) {
  if (error === "Required") return <Trans>Required</Trans>;
  if (error === "Must be a number") return <Trans>Must be a number</Trans>;
  if (error === "Must be a whole number") return <Trans>Must be a whole number</Trans>;
  if (error === "Choose a listed option") return <Trans>Choose a listed option</Trans>;
  if (error.startsWith("Must be at least ")) {
    const value = error.slice("Must be at least ".length);
    return <Trans>Must be at least {value}</Trans>;
  }
  if (error.startsWith("Must be at most ")) {
    const value = error.slice("Must be at most ".length);
    return <Trans>Must be at most {value}</Trans>;
  }
  return <>{error}</>;
}
