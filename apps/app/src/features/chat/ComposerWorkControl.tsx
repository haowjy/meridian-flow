/** ComposerWorkControl — searchable composer control for an open chat's Work binding. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/protocol";
import { ArrowLeft, Check, Ellipsis, LoaderCircle, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import {
  ThreadWorkReconciliationError,
  useRebindThreadWork,
} from "@/client/query/useRebindThreadWork";
import { useWorks } from "@/client/query/useWorks";
import { useAnnouncement } from "@/client/stores";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ComposerWorkControl({
  projectId,
  threadId,
  work,
}: {
  projectId: string;
  threadId: string;
  work: Work;
}) {
  const [entry, setEntry] = useState<"direct" | "overflow" | null>(null);
  const [overflowView, setOverflowView] = useState<"root" | "works">("root");
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoWorkId, setUndoWorkId] = useState<string | null>(null);
  const directTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const initiatingTriggerRef = useRef<HTMLButtonElement | null>(null);
  const choiceRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousWorkIdRef = useRef(work.id);
  const locallyCommittedWorkIdRef = useRef<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { works, refetch } = useWorks(projectId);
  const mutation = useRebindThreadWork(projectId, threadId);
  const { announce, announceError } = useAnnouncement();

  useEffect(() => {
    if (!entry || mutation.isPending || !error || !targetId) return;
    requestAnimationFrame(() => choiceRefs.current.get(targetId)?.focus());
  }, [entry, error, mutation.isPending, targetId]);

  const close = () => {
    setEntry(null);
    setOverflowView("root");
    setQuery("");
  };

  const returnFocus = () => requestAnimationFrame(() => initiatingTriggerRef.current?.focus());

  useEffect(() => {
    if (previousWorkIdRef.current !== work.id) {
      previousWorkIdRef.current = work.id;
      if (locallyCommittedWorkIdRef.current === work.id) {
        locallyCommittedWorkIdRef.current = null;
        return;
      }
      setTargetId(null);
      setError(null);
      announce(t`This chat's Work changed to ${work.name}`);
    }
  }, [announce, work.id, work.name]);

  const choose = async (target: Work, undo = false) => {
    if (target.id === work.id || mutation.isPending) {
      if (target.id === work.id) close();
      return;
    }
    setTargetId(target.id);
    setError(null);
    locallyCommittedWorkIdRef.current = target.id;
    announce(t`Changing work to ${target.name}`);
    try {
      const result = await mutation.mutateAsync(target.id);
      setTargetId(null);
      if (!result.changed) {
        locallyCommittedWorkIdRef.current = null;
        close();
        return;
      }
      locallyCommittedWorkIdRef.current = result.work.id;
      const inverse = result.receipt.inverse;
      setUndoWorkId(!undo && inverse?.command === "switch" ? inverse.workId : null);
      close();
      announce(
        result.preferenceChanged
          ? t`This chat now uses ${result.work.name}. New chats will use it too.`
          : t`This chat now uses ${result.work.name}.`,
      );
      returnFocus();
    } catch (cause) {
      if (cause instanceof ThreadWorkReconciliationError && cause.committed) {
        setTargetId(null);
        setError(null);
        close();
        announce(t`This chat now uses ${target.name}.`);
        returnFocus();
        return;
      }
      locallyCommittedWorkIdRef.current = null;
      let message: string;
      if (isMeridianApiError(cause) && cause.code === "thread_busy") {
        message = t`Wait for this response to finish, then try again.`;
      } else if (isMeridianApiError(cause) && cause.code === "work_unavailable") {
        message = t`That Work is no longer available. Choose another Work.`;
        refetch();
      } else if (isMeridianApiError(cause) && cause.code === "thread_work_missing") {
        message = t`This chat's current Work could not be found. Refresh the page and try again.`;
      } else if (cause instanceof ThreadWorkReconciliationError) {
        message = t`The Work did not change. Try again.`;
      } else {
        message = t`The change could not be confirmed. Try again.`;
      }
      setError(message);
      announceError(message);
    }
  };

  const choices = (
    <WorkChoices
      works={works ?? []}
      currentWorkId={work.id}
      targetId={targetId}
      pending={mutation.isPending}
      error={error}
      onChoose={choose}
      choiceRefs={choiceRefs.current}
      query={query}
      onQueryChange={setQuery}
    />
  );

  return (
    <span className="flex min-w-0 items-center">
      <WorkPopover
        open={entry === "direct"}
        onOpenChange={(open) => setEntry(open ? "direct" : null)}
        content={choices}
        titleId={titleId}
        descriptionId={descriptionId}
        workName={work.name}
      >
        <button
          ref={directTriggerRef}
          type="button"
          aria-label={t`Change work for this chat, currently ${work.name}`}
          aria-expanded={entry === "direct"}
          aria-busy={mutation.isPending}
          onClick={() => {
            initiatingTriggerRef.current = directTriggerRef.current;
            setQuery("");
          }}
          className="focus-ring max-w-[11rem] truncate rounded-sm text-meta text-muted-foreground transition-colors hover:text-foreground @max-[520px]:hidden"
        >
          <Trans>Work: {work.name}</Trans>
        </button>
      </WorkPopover>
      <Popover
        open={entry === "overflow"}
        onOpenChange={(open) => {
          setEntry(open ? "overflow" : null);
          if (!open) {
            setOverflowView("root");
            setQuery("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={overflowTriggerRef}
            type="button"
            aria-label={t`More composer settings`}
            aria-expanded={entry === "overflow"}
            onClick={() => {
              initiatingTriggerRef.current = overflowTriggerRef.current;
            }}
            className="focus-ring hidden size-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground @max-[520px]:flex"
          >
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-3" aria-label={t`Composer settings`}>
          {overflowView === "root" ? (
            <div className="space-y-1">
              <button
                type="button"
                className="focus-ring flex min-h-10 w-full items-center rounded-md px-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setOverflowView("works");
                  setQuery("");
                }}
              >
                <Trans>Work: {work.name}</Trans>
              </button>
              {undoWorkId ? (
                <button
                  type="button"
                  className="focus-ring flex min-h-10 w-full items-center rounded-md px-2 text-left text-sm text-jade-text hover:bg-accent"
                  onClick={() => {
                    const previous = works?.find((candidate) => candidate.id === undoWorkId);
                    if (previous) void choose(previous, true);
                  }}
                >
                  <Trans>Undo Work change</Trans>
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="focus-ring mb-2 flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setOverflowView("root")}
              >
                <ArrowLeft className="size-4" aria-hidden />
                <Trans>Back</Trans>
              </button>
              {choices}
            </>
          )}
        </PopoverContent>
      </Popover>
      {undoWorkId ? (
        <button
          type="button"
          className="focus-ring ml-2 rounded-sm text-meta text-jade-text hover:underline @max-[520px]:hidden"
          onClick={() => {
            const previous = works?.find((candidate) => candidate.id === undoWorkId);
            if (previous) void choose(previous, true);
          }}
        >
          <Trans>Undo</Trans>
        </button>
      ) : null}
    </span>
  );
}

function WorkPopover({
  open,
  onOpenChange,
  content,
  children,
  titleId,
  descriptionId,
  workName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: React.ReactNode;
  children: React.ReactNode;
  titleId: string;
  descriptionId: string;
  workName: string;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2 id={titleId} className="font-semibold">
          <Trans>Change work for this chat</Trans>
        </h2>
        <p id={descriptionId} className="mb-2 text-xs text-muted-foreground">
          <Trans>Currently {workName}</Trans>
        </p>
        {content}
      </PopoverContent>
    </Popover>
  );
}

function WorkChoices({
  works,
  currentWorkId,
  targetId,
  pending,
  error,
  onChoose,
  choiceRefs,
  query,
  onQueryChange,
}: {
  works: Work[];
  currentWorkId: string;
  targetId: string | null;
  pending: boolean;
  error: string | null;
  onChoose: (work: Work) => void;
  choiceRefs: Map<string, HTMLButtonElement>;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = works.filter((work) =>
    `${work.name} ${work.goal ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  const active = filtered.filter((work) => work.status === "active");
  const archived = filtered.filter((work) => work.status === "archived");
  const searchId = useId();
  const navigate = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("section button:not(:disabled)"),
    ];
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + rows.length) % rows.length
            : (current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };
  return (
    <fieldset className="min-w-0 space-y-3 border-0 p-0" onKeyDown={navigate}>
      <label htmlFor={searchId} className="sr-only">
        <Trans>Search works</Trans>
      </label>
      <div className="flex items-center gap-2 rounded-md border border-input px-2 focus-within:ring-2 focus-within:ring-ring">
        <Search className="size-4 text-muted-foreground" aria-hidden />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t`Search works`}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {active.length ? (
        <WorkSection
          works={active}
          label={t`Active works`}
          {...{ currentWorkId, targetId, pending, error, onChoose, choiceRefs }}
        />
      ) : null}
      {archived.length ? (
        <WorkSection
          works={archived}
          label={t`Archived works`}
          archived
          {...{ currentWorkId, targetId, pending, error, onChoose, choiceRefs }}
        />
      ) : null}
      {!filtered.length ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          <Trans>No works match your search.</Trans>
        </p>
      ) : null}
    </fieldset>
  );
}

function WorkSection({
  works,
  label,
  archived = false,
  currentWorkId,
  targetId,
  pending,
  error,
  onChoose,
  choiceRefs,
}: {
  works: Work[];
  label: string;
  archived?: boolean;
  currentWorkId: string;
  targetId: string | null;
  pending: boolean;
  error: string | null;
  onChoose: (work: Work) => void;
  choiceRefs: Map<string, HTMLButtonElement>;
}) {
  return (
    <section aria-label={label}>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="space-y-1">
        {works.map((work) => {
          const current = work.id === currentWorkId;
          const changing = work.id === targetId && pending;
          return (
            <button
              ref={(node) => {
                if (node) choiceRefs.set(work.id, node);
                else choiceRefs.delete(work.id);
              }}
              key={work.id}
              type="button"
              disabled={pending}
              onClick={() => onChoose(work)}
              aria-current={current ? "true" : undefined}
              aria-describedby={error && work.id === targetId ? `${work.id}-error` : undefined}
              className="focus-ring flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {archived ? t`${work.name}, Archived` : work.name}
                </span>
                {work.goal ? (
                  <span className="block truncate text-xs text-muted-foreground">{work.goal}</span>
                ) : null}
                {current ? (
                  <span className="block text-xs text-muted-foreground">
                    <Trans>Current for this chat</Trans>
                  </span>
                ) : null}
                {changing ? (
                  <span className="block text-xs text-muted-foreground">
                    <Trans>Changing work</Trans>
                  </span>
                ) : null}
              </span>
              {changing ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : current ? (
                <Check className="size-4" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
      {error && works.some((work) => work.id === targetId) ? (
        <p id={`${targetId}-error`} role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
