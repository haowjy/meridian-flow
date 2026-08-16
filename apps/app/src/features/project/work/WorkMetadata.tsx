/** Page-scoped metadata edit lifecycle and its display-first view. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type MetadataField = "name" | "goal" | "description";
type HeldIntent = { run: () => void; cancel?: () => void; label: string } | null;
const normalize = (field: MetadataField, value: string) =>
  field === "name" ? value.trim() : value.trim() || "";

export function useWorkMetadataController(
  initial: Work,
  saveWork: (data: UpdateWorkRequest) => Promise<Work>,
) {
  const [work, setWork] = useState(initial);
  const [field, setField] = useState<MetadataField | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldIntent>(null);
  const [announcement, setAnnouncement] = useState("");
  const displayRefs = useRef(new Map<MetadataField, HTMLElement>());
  const editorRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const initialRef = useRef(initial);
  const baseline = field ? normalize(field, work[field] ?? "") : "";
  const normalizedDraft = field ? normalize(field, draft) : "";
  const dirty = field !== null && normalizedDraft !== baseline;
  useEffect(() => {
    if (sameMetadata(initialRef.current, initial)) return;
    initialRef.current = initial;
    setWork(initial);
  }, [initial]);
  useEffect(() => {
    if (saving || field || !held) return;
    const intent = held;
    setHeld(null);
    intent.run();
  }, [field, held, saving]);

  const focusDisplay = useCallback(
    (target: MetadataField) =>
      requestAnimationFrame(() => displayRefs.current.get(target)?.focus()),
    [],
  );
  const cancel = useCallback(() => {
    if (!field || saving) return;
    const target = field;
    setField(null);
    setError(null);
    setHeld(null);
    setAnnouncement(t`${fieldLabel(target)} edit canceled`);
    focusDisplay(target);
  }, [field, focusDisplay, saving]);
  const save = useCallback(async (): Promise<boolean> => {
    if (!field) return true;
    if (saving) return false;
    if (field === "name" && !normalizedDraft) {
      setError(t`Work name is required`);
      return false;
    }
    if (!dirty) {
      const target = field;
      setField(null);
      setError(null);
      focusDisplay(target);
      return true;
    }
    const target = field;
    setSaving(true);
    setError(null);
    try {
      const returned = await saveWork({
        [target]: normalizedDraft,
      });
      setWork(returned);
      setField(null);
      setAnnouncement(t`${fieldLabel(target)} saved`);
      focusDisplay(target);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Save failed`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, field, focusDisplay, normalizedDraft, saveWork, saving]);
  const request = useCallback(
    (intent: NonNullable<HeldIntent>) => {
      if (saving || dirty) {
        setHeld(intent);
        return;
      }
      intent.run();
    },
    [dirty, saving],
  );
  const activate = useCallback(
    (next: MetadataField) =>
      request({
        label: t`Edit ${fieldLabel(next)}`,
        run: () => {
          setField(next);
          setDraft(work[next] ?? "");
          setError(null);
        },
      }),
    [request, work],
  );
  const saveAndResume = useCallback(async () => {
    const intent = held;
    if (!intent) return;
    if (await save()) {
      setHeld(null);
      intent.run();
    }
  }, [held, save]);
  const discardAndResume = useCallback(() => {
    const intent = held;
    if (!intent || saving) return;
    setField(null);
    setError(null);
    setHeld(null);
    intent.run();
  }, [held, saving]);
  const keepEditing = useCallback(() => {
    held?.cancel?.();
    setHeld(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [held]);
  return {
    work,
    field,
    draft,
    setDraft,
    dirty,
    saving,
    error,
    held,
    announcement,
    editorRef,
    displayRefs,
    activate,
    cancel,
    save,
    request,
    saveAndResume,
    discardAndResume,
    keepEditing,
  };
}
export type WorkMetadataController = ReturnType<typeof useWorkMetadataController>;

export function WorkMetadata({
  controller,
  identityChrome,
}: {
  controller: WorkMetadataController;
  identityChrome?: React.ReactNode;
}) {
  const c = controller;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, [c.work.id]);
  useLayoutEffect(() => {
    if (!c.field) return;
    c.editorRef.current?.focus();
    if (c.field === "name" && c.editorRef.current instanceof HTMLInputElement)
      c.editorRef.current.select();
  }, [c.editorRef, c.field]);
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      c.cancel();
    }
    if (
      (c.field === "name" && event.key === "Enter") ||
      (c.field !== "name" && event.key === "Enter" && (event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault();
      void c.save();
    }
  };
  const refFor = (field: MetadataField) => (node: HTMLElement | null) => {
    if (node) c.displayRefs.current.set(field, node);
    else c.displayRefs.current.delete(field);
  };
  return (
    <section className="space-y-7" aria-label={t`Work identity`}>
      <p className="sr-only" aria-live="polite">
        {c.announcement}
      </p>
      <div className="min-w-0">
        {c.field === "name" ? (
          <Editor field="name" controller={c} keyDown={keyDown} />
        ) : (
          <div className="flex min-w-0 items-start gap-2">
            <h1
              ref={(node) => {
                headingRef.current = node;
                refFor("name")(node);
              }}
              tabIndex={-1}
              className="focus-ring min-h-11 min-w-0 cursor-text rounded-sm break-words text-2xl font-semibold [@media(pointer:coarse)]:min-h-11"
              onClick={() => c.activate("name")}
              onKeyDown={(event) => {
                if (event.key === "Enter") c.activate("name");
              }}
            >
              {c.work.name}
            </h1>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t`Edit Work name`}
              onClick={() => c.activate("name")}
              className="shrink-0 [@media(pointer:coarse)]:size-11"
            >
              <Pencil className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {identityChrome}
      <Field
        field="goal"
        label={t`Goal`}
        controller={c}
        displayRef={refFor("goal")}
        keyDown={keyDown}
      />
      <Field
        field="description"
        label={t`Description`}
        controller={c}
        displayRef={refFor("description")}
        keyDown={keyDown}
      />
    </section>
  );
}
function Field({
  field,
  label,
  controller: c,
  displayRef,
  keyDown,
}: {
  field: "goal" | "description";
  label: string;
  controller: WorkMetadataController;
  displayRef: (node: HTMLElement | null) => void;
  keyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">{label}</h2>
      {c.field === field ? (
        <Editor field={field} controller={c} keyDown={keyDown} />
      ) : (
        <button
          type="button"
          ref={displayRef}
          className={`focus-ring min-h-11 max-w-3xl rounded-sm text-left whitespace-pre-line [@media(pointer:coarse)]:min-h-11 ${field === "goal" ? "text-base" : "text-sm text-muted-foreground"}`}
          onClick={() => c.activate(field)}
        >
          {c.work[field] || (field === "goal" ? t`Add a goal` : t`Add a description`)}
        </button>
      )}
    </div>
  );
}
function Editor({
  field,
  controller: c,
  keyDown,
}: {
  field: MetadataField;
  controller: WorkMetadataController;
  keyDown: (event: React.KeyboardEvent) => void;
}) {
  const errorId = `work-${field}-error`;
  const common = {
    value: c.draft,
    disabled: c.saving,
    "aria-invalid": Boolean(c.error),
    "aria-describedby": c.error ? errorId : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      c.setDraft(event.target.value),
    onKeyDown: keyDown,
  };
  return (
    <div className="max-w-3xl space-y-2">
      {field === "name" ? (
        <Input
          ref={c.editorRef as React.Ref<HTMLInputElement>}
          {...common}
          onBlur={(event) => {
            if (
              !(
                event.relatedTarget instanceof HTMLElement &&
                event.relatedTarget.closest("button,a")
              )
            )
              void c.save();
          }}
        />
      ) : (
        <Textarea
          ref={c.editorRef as React.Ref<HTMLTextAreaElement>}
          {...common}
          className="min-h-24 resize-none"
          onInput={(event) => {
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
          }}
        />
      )}
      {c.error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {c.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {c.saving ? (
          <span role="status" className="text-sm text-muted-foreground">
            <Trans>Saving…</Trans>
          </span>
        ) : (
          <Button
            size="sm"
            onClick={() => void c.save()}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            {c.error ? <Trans>Retry save</Trans> : t`Save ${fieldLabel(field).toLowerCase()}`}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={c.saving}
          onClick={c.cancel}
          className="[@media(pointer:coarse)]:min-h-11"
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}
function fieldLabel(field: MetadataField): string {
  if (field === "name") return t`Work name`;
  if (field === "goal") return t`Goal`;
  return t`Description`;
}
function sameMetadata(left: Work, right: Work): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.goal === right.goal &&
    left.description === right.description &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt
  );
}
