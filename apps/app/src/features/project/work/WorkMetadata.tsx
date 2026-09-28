/** Page-scoped Work name and description editing lifecycle. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type MetadataField = "name" | "goal";
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
  const heldRef = useRef<HeldIntent>(null);
  const takeHeld = useCallback(() => {
    const intent = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    return intent;
  }, []);
  useEffect(
    () => () => {
      heldRef.current?.cancel?.();
      heldRef.current = null;
    },
    [],
  );
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
    if (!saving && !field && held) takeHeld()?.run();
  }, [field, held, saving, takeHeld]);
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
    takeHeld()?.cancel?.();
    setAnnouncement(t`${fieldLabel(target)} edit canceled`);
    focusDisplay(target);
  }, [field, focusDisplay, saving, takeHeld]);
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
    const previous = work;
    setWork({ ...work, [target]: normalizedDraft, updatedAt: new Date().toISOString() });
    setSaving(true);
    setError(null);
    try {
      const returned = await saveWork({ [target]: normalizedDraft });
      setWork(returned);
      setField(null);
      setAnnouncement(t`${fieldLabel(target)} saved`);
      focusDisplay(target);
      return true;
    } catch (cause) {
      setWork(previous);
      setError(cause instanceof Error ? cause.message : t`Save failed`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, field, focusDisplay, normalizedDraft, saveWork, saving, work]);
  const request = useCallback(
    (intent: NonNullable<HeldIntent>) => {
      const previous = heldRef.current;
      heldRef.current = intent;
      setHeld(intent);
      previous?.cancel?.();
      if (!saving && !dirty && heldRef.current === intent) takeHeld()?.run();
    },
    [dirty, saving, takeHeld],
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
    const intent = heldRef.current;
    if (intent && (await save()) && heldRef.current === intent) takeHeld()?.run();
  }, [save, takeHeld]);
  const discardAndResume = useCallback(() => {
    if (!heldRef.current || saving) return;
    setField(null);
    setError(null);
    takeHeld()?.run();
  }, [saving, takeHeld]);
  const keepEditing = useCallback(() => {
    takeHeld()?.cancel?.();
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [takeHeld]);
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

function useFieldKeys(c: WorkMetadataController) {
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      c.cancel();
    }
    if (
      (c.field === "name" && event.key === "Enter") ||
      (c.field === "goal" && event.key === "Enter" && (event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault();
      void c.save();
    }
  };
  const displayRef = (field: MetadataField) => (node: HTMLElement | null) => {
    if (node) c.displayRefs.current.set(field, node);
    else c.displayRefs.current.delete(field);
  };
  return { keyDown, displayRef };
}

function useEditorFocus(c: WorkMetadataController, field: MetadataField) {
  useLayoutEffect(() => {
    if (c.field !== field) return;
    const editor = c.editorRef.current;
    editor?.focus();
    if (field === "name" && editor instanceof HTMLInputElement) editor.select();
    if (field === "goal" && editor instanceof HTMLTextAreaElement) {
      editor.style.height = "auto";
      editor.style.height = `${editor.scrollHeight}px`;
    }
  }, [c.field, c.editorRef, field]);
}

/** The Work name as the page heading; click to edit in place. */
export function WorkName({ controller: c }: { controller: WorkMetadataController }) {
  const { keyDown, displayRef } = useFieldKeys(c);
  useEditorFocus(c, "name");
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {c.announcement}
      </p>
      {c.field === "name" ? (
        <Editor field="name" controller={c} keyDown={keyDown} />
      ) : (
        <h1 className="min-w-0 max-w-full text-xl font-semibold [overflow-wrap:anywhere]">
          <button
            type="button"
            ref={displayRef("name")}
            onClick={() => c.activate("name")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                c.activate("name");
              }
            }}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm text-left"
          >
            {c.work.name}
          </button>
        </h1>
      )}
    </>
  );
}

/** The Work description: clamped body text with Show more, edited in a box. */
export function WorkDescription({ controller: c }: { controller: WorkMetadataController }) {
  const { keyDown, displayRef } = useFieldKeys(c);
  useEditorFocus(c, "goal");
  const description = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = description.current;
    if (c.field || !node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (!expanded) setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    if (expanded) setOverflows(true);
    else measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [c.field, c.work.goal, expanded]);
  if (c.field === "goal") return <Editor field="goal" controller={c} keyDown={keyDown} />;
  return (
    <div className="max-w-3xl">
      <div
        ref={description}
        className={`relative overflow-hidden text-body text-foreground ${expanded ? "max-h-none" : "max-h-[calc(var(--text-body--line-height)*3)]"} ${overflows && !expanded ? "[mask-image:linear-gradient(to_bottom,#000_55%,transparent)]" : ""}`}
      >
        <button
          type="button"
          ref={displayRef("goal")}
          onClick={() => c.activate("goal")}
          className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring min-h-6 w-full rounded-sm text-left [@media(pointer:coarse)]:min-h-11 ${c.work.goal ? "" : "text-muted-foreground"}`}
        >
          {c.work.goal
            ? c.work.goal.split(/\n\s*\n/).map((paragraph, index) => (
                <span
                  className="block [&+span]:mt-[0.45em]"
                  key={`${index}-${paragraph.slice(0, 16)}`}
                >
                  {paragraph}
                </span>
              ))
            : t`Add a description of what this Work is for`}
        </button>
      </div>
      {overflows ? (
        <button
          type="button"
          className="text-button mt-1 min-h-6 text-sm [@media(pointer:coarse)]:min-h-11"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
        </button>
      ) : null}
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
    <div className={field === "name" ? "min-w-48 max-w-md flex-1" : "min-w-0 w-full max-w-3xl"}>
      {field === "name" ? (
        <Input
          ref={c.editorRef as React.Ref<HTMLInputElement>}
          {...common}
          aria-label={t`Work name`}
          className="h-9 text-xl font-semibold"
          onBlur={() => void c.save()}
        />
      ) : (
        <Textarea
          ref={c.editorRef as React.Ref<HTMLTextAreaElement>}
          {...common}
          aria-label={t`Description`}
          className="min-h-28 resize-none p-0 text-body"
          onInput={(event) => {
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
          }}
        />
      )}
      {c.error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-destructive">
          {c.error}
        </p>
      ) : null}
      {field === "goal" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" disabled={c.saving} onClick={() => void c.save()}>
            {c.saving ? (
              <Trans>Saving…</Trans>
            ) : c.error ? (
              <Trans>Retry save</Trans>
            ) : (
              <Trans>Save</Trans>
            )}
          </Button>
          <Button size="sm" variant="ghost" disabled={c.saving} onClick={c.cancel}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
function fieldLabel(field: MetadataField) {
  return field === "name" ? t`Work name` : t`Description`;
}
function sameMetadata(a: Work, b: Work) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.goal === b.goal &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt
  );
}
