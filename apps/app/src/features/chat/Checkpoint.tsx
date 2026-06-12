// @ts-nocheck
/**
 * Checkpoint — the generic checkpoint card (execution-model §8.1).
 *
 * Purpose: renders any `CheckpointRequest` payload that flows through the
 * `componentContentForCheckpoint` builder. ZERO domain vocabulary: the prompt,
 * artifacts, and form fields come entirely from the package-supplied
 * `request.prompt` / `artifacts` / `answerSchema`. The same card renders any
 * future package's checkpoint unchanged.
 *
 * Key decisions:
 *  - Artifact thumbnails: `image` arms render as inline images (click to
 *    enlarge in a dialog); `object` arms as labeled refs (a download chip);
 *    `liveView` arms as a isolated `<iframe>` slot. Nothing produces
 *    `liveView` today — the slot is reserved per execution-model §8.4 so
 *    when the Daytona preview-WS probe goes green the overlay drops in
 *    without a contract or card change.
 *  - Form generated from `answerSchema` via `checkpointFieldsFromSchema`,
 *    which owns the supported JSON-Schema subset. Required-field validation
 *    blocks empty submits.
 *  - On submit the card emits the full answer object (one property per
 *    field, keyed by schema property name); `CustomBlockRenderer` adds the
 *    checkpoint correlation tuple.
 *  - Resolved/auto-resumed checkpoints render a compact summary so the chat
 *    history reads as a conversation, not a stack of expired forms.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import { CheckCircle2, Pause } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  type CheckpointField,
  type CheckpointFormErrors,
  type CheckpointFormValues,
  checkpointFieldsFromSchema,
  initialFormValues,
  validateFormValues,
} from "./checkpoint-form-schema";
import type { ComponentBlockProps } from "./component-registry";

type CheckpointProps = {
  prompt: string;
  artifacts: ArtifactRef[];
  fields: CheckpointField[];
  recommended: import("@meridian/contracts/threads").JsonValue | null;
};

function readCheckpointProps(content: ComponentBlockProps["content"]): CheckpointProps | null {
  if (content.kind !== "checkpoint") return null;
  const props = content.props;

  const prompt = typeof props.prompt === "string" ? props.prompt : "";
  if (prompt.length === 0) return null;

  const answerSchemaRaw = props.answerSchema;
  if (!answerSchemaRaw || typeof answerSchemaRaw !== "object" || Array.isArray(answerSchemaRaw)) {
    return null;
  }
  const fields = checkpointFieldsFromSchema(answerSchemaRaw);

  const artifactsRaw = props.artifacts;
  const artifacts: ArtifactRef[] = Array.isArray(artifactsRaw)
    ? artifactsRaw.filter(isArtifactRef)
    : [];

  const recommended = props.recommended ?? null;
  return { prompt, artifacts, fields, recommended };
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.url === "string") return true;
  if (record.type === "object" && typeof record.uri === "string") return true;
  if (record.type === "liveView" && typeof record.url === "string") return true;
  return false;
}

export function Checkpoint({ content, respond, isAwaitingResponse }: ComponentBlockProps) {
  const parsed = readCheckpointProps(content);
  const hasResolvedValue = Object.hasOwn(content.props, "resolvedValue");
  const resolvedValue =
    typeof content.props.resolvedValue === "string" ? content.props.resolvedValue : null;
  const provenance =
    content.props.answerProvenance === "user" || content.props.answerProvenance === "auto"
      ? content.props.answerProvenance
      : null;

  if (!parsed) {
    return (
      <section className="mb-4 rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
        <Trans>Checkpoint payload is malformed.</Trans>
      </section>
    );
  }

  if (!isAwaitingResponse && hasResolvedValue) {
    return (
      <ResolvedCheckpointSummary
        prompt={parsed.prompt}
        answer={resolvedValue ?? t`No answer`}
        provenance={provenance}
      />
    );
  }

  return (
    <CheckpointForm
      prompt={parsed.prompt}
      artifacts={parsed.artifacts}
      fields={parsed.fields}
      recommended={parsed.recommended}
      isAwaitingResponse={isAwaitingResponse}
      respond={respond}
    />
  );
}

function CheckpointForm({
  prompt,
  artifacts,
  fields,
  recommended,
  isAwaitingResponse,
  respond,
}: CheckpointProps & {
  isAwaitingResponse: boolean;
  respond: ComponentBlockProps["respond"];
}) {
  // The form's initial values depend on schema + recommended; recomputing on
  // every keystroke would clobber user input. Memoize on the props that
  // actually feed the seed.
  const seedValues = useMemo(() => initialFormValues(fields, recommended), [fields, recommended]);
  const [values, setValues] = useState<CheckpointFormValues>(seedValues);
  const [errors, setErrors] = useState<CheckpointFormErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const formDisabled = !isAwaitingResponse || submitted;

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
    <section
      className="mb-4 overflow-hidden rounded-xl border border-border-subtle bg-card shadow-xs"
      aria-labelledby="checkpoint-heading"
    >
      <header className="flex items-start gap-2 border-border-subtle border-b bg-surface-subtle px-4 py-3">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-card text-primary">
          <Pause className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-foreground text-xs uppercase tracking-wide">
            <Trans>Checkpoint</Trans>
          </p>
          <h3 id="checkpoint-heading" className="mt-0.5 font-medium text-foreground text-sm">
            {prompt}
          </h3>
        </div>
      </header>

      {artifacts.length > 0 ? (
        <div className="border-border-subtle border-b px-4 py-3">
          <ArtifactGrid artifacts={artifacts} />
        </div>
      ) : null}

      <form className="flex flex-col gap-3 px-4 py-3" onSubmit={handleSubmit} noValidate>
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
            className="focus-ring inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm shadow-button transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trans>Confirm</Trans>
          </button>
          <button
            type="button"
            disabled={formDisabled}
            onClick={handleStop}
            className="focus-ring inline-flex cursor-pointer items-center rounded-md border border-border-subtle bg-surface-subtle px-3 py-1.5 font-medium text-foreground text-sm transition-all hover:bg-card disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trans>Stop run</Trans>
          </button>
        </div>
      </form>
    </section>
  );
}

function ArtifactGrid({ artifacts }: { artifacts: ArtifactRef[] }) {
  // Live-view arms get a dedicated row spanning the grid; image + object
  // thumbnails share the responsive grid.
  const liveViews = artifacts.filter(
    (artifact): artifact is Extract<ArtifactRef, { type: "liveView" }> =>
      artifact.type === "liveView",
  );
  const thumbs = artifacts.filter((artifact) => artifact.type !== "liveView");

  return (
    <div className="flex flex-col gap-3">
      {thumbs.length > 0 ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {thumbs.map((artifact, index) => (
            <li key={artifactKey(artifact, index)}>
              <ArtifactThumb artifact={artifact} />
            </li>
          ))}
        </ul>
      ) : null}
      {liveViews.map((artifact) => (
        <LiveViewSlot key={`live:${artifact.url}`} artifact={artifact} />
      ))}
    </div>
  );
}

function artifactKey(artifact: ArtifactRef, index: number): string {
  if (artifact.type === "image") return `${artifact.type}:${artifact.url}:${index}`;
  if (artifact.type === "object") return `${artifact.type}:${artifact.uri}:${index}`;
  return `${artifact.type}:${index}`;
}

function ArtifactThumb({
  artifact,
}: {
  artifact: Extract<ArtifactRef, { type: "image" | "object" }>;
}) {
  if (artifact.type === "image") {
    return <ImageArtifact image={artifact} />;
  }
  return <ObjectArtifact object={artifact} />;
}

function ImageArtifact({ image }: { image: Extract<ArtifactRef, { type: "image" }> }) {
  const label = image.label ?? t`Image artifact`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="focus-ring group block w-full overflow-hidden rounded-md border border-border-subtle bg-surface-subtle transition-all hover:border-border-focus"
        >
          <img
            src={image.url}
            alt={label}
            className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
          {image.label ? (
            <span className="block truncate px-2 py-1 text-foreground text-xs">{image.label}</span>
          ) : null}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogClose asChild>
          <button
            type="button"
            className="focus-ring block w-full overflow-hidden rounded-md"
            aria-label={t`Close artifact preview`}
          >
            <img src={image.url} alt={label} className="h-auto w-full" />
          </button>
        </DialogClose>
        {image.label ? <p className="mt-2 text-muted-foreground text-sm">{image.label}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

function ObjectArtifact({ object }: { object: Extract<ArtifactRef, { type: "object" }> }) {
  const label = object.label ?? object.uri;
  return (
    <a
      href={object.uri}
      target="_blank"
      rel="noreferrer"
      className="focus-ring flex h-full min-h-20 flex-col justify-between rounded-md border border-border-subtle bg-surface-subtle p-2 transition-all hover:border-border-focus"
    >
      <span className="font-medium text-foreground text-xs uppercase tracking-wide">
        <Trans>Object</Trans>
      </span>
      <span className="truncate text-foreground text-sm">{label}</span>
      {object.mimeType ? (
        <span className="text-muted-foreground text-xs">{object.mimeType}</span>
      ) : null}
    </a>
  );
}

function LiveViewSlot({ artifact }: { artifact: Extract<ArtifactRef, { type: "liveView" }> }) {
  // Isolated iframe per execution-model §8.4: the URL is a Daytona preview
  // link to a kernel-served viewer (e.g. trame-vtklocal). `allow-scripts`
  // is required for the viewer JS; `allow-same-origin` keeps the preview
  // proxy's auth cookie usable. Nothing produces liveView arms today —
  // this slot is the contract landing zone.
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-subtle">
      <div className="flex items-center justify-between border-border-subtle border-b px-3 py-1.5">
        <span className="font-medium text-foreground text-xs uppercase tracking-wide">
          <Trans>Live view</Trans>
        </span>
        {artifact.expiresAt ? (
          <span className="text-muted-foreground text-xs">
            <Trans>expires {artifact.expiresAt}</Trans>
          </span>
        ) : null}
      </div>
      <iframe
        title={t`Live artifact view`}
        src={artifact.url}
        project
        workspace="allow-scripts allow-same-origin"
        className="block aspect-video w-full"
      />
    </div>
  );
}

function FieldRow({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: CheckpointField;
  value: string | number | boolean | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const inputId = `checkpoint-field-${field.name}`;
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
  field: CheckpointField;
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
          "focus-ring rounded-md border border-border-subtle bg-surface-subtle px-2 py-1.5 text-foreground text-sm",
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
        className="bg-surface-subtle"
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
      className="bg-surface-subtle"
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

function ResolvedCheckpointSummary({
  prompt,
  answer,
  provenance,
}: {
  prompt: string;
  answer: string;
  provenance: "user" | "auto" | null;
}) {
  return (
    <section className="mb-4 rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-foreground text-xs">
        <CheckCircle2 className="size-3.5 text-primary" aria-hidden />
        <Trans>Checkpoint resolved</Trans>
      </div>
      <p className="text-muted-foreground text-xs">{prompt}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-foreground text-sm">
        <span className="font-medium">{answer}</span>
        <span className="status-pill">
          {provenance === "auto" ? <Trans>auto-selected</Trans> : <Trans>you answered</Trans>}
        </span>
      </div>
    </section>
  );
}
