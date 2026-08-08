/** ThreadWorkControl — shared writer control for an open chat's Work binding. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/protocol";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { useRebindThreadWork } from "@/client/query/useRebindThreadWork";
import { useWorks } from "@/client/query/useWorks";
import { useAnnouncement } from "@/client/stores";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";

export function ThreadWorkControl({
  projectId,
  threadId,
  work,
  compact = false,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  compact?: boolean;
}) {
  const phone = usePhoneShell() === true;
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoWorkId, setUndoWorkId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousWorkIdRef = useRef(work.id);
  const locallyCommittedWorkIdRef = useRef<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { works, refetch } = useWorks(projectId);
  const mutation = useRebindThreadWork(projectId, threadId);
  const { announce, announceError } = useAnnouncement();

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
      if (target.id === work.id) setOpen(false);
      return;
    }
    setTargetId(target.id);
    setError(null);
    announce(t`Changing work to ${target.name}`);
    try {
      const result = await mutation.mutateAsync(target.id);
      setTargetId(null);
      if (!result.changed) {
        setOpen(false);
        return;
      }
      locallyCommittedWorkIdRef.current = result.work.id;
      const inverse = result.receipt.inverse;
      setUndoWorkId(!undo && inverse?.command === "switch" ? inverse.workId : null);
      setOpen(false);
      announce(
        result.preferenceChanged
          ? t`This chat now uses ${result.work.name}. New chats will use it too.`
          : t`This chat now uses ${result.work.name}.`,
      );
      requestAnimationFrame(() => triggerRef.current?.focus());
    } catch (cause) {
      let message: string;
      if (isMeridianApiError(cause) && cause.code === "thread_busy") {
        message = t`Wait for this response to finish, then try again.`;
      } else if (isMeridianApiError(cause) && cause.status === 409) {
        message = t`That Work is no longer available. Choose another Work.`;
        refetch();
      } else {
        message = t`The change could not be confirmed. Refreshing this chat's Work.`;
        refetch();
      }
      setError(message);
      announceError(message);
    }
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={t`Change work for this chat, currently ${work.name}`}
      aria-expanded={open}
      aria-busy={mutation.isPending}
      className={cn(
        "focus-ring max-w-full truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground",
        compact ? "text-meta" : "shrink-0 text-meta",
      )}
    >
      <Trans>Work: {work.name}</Trans>
    </button>
  );

  const content = (
    <WorkChoices
      works={works ?? []}
      currentWorkId={work.id}
      targetId={targetId}
      pending={mutation.isPending}
      error={error}
      onChoose={choose}
    />
  );

  return (
    <span className="min-w-0">
      {phone ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent
            side="bottom"
            className="max-h-[80svh] w-full rounded-t-xl pb-[max(1rem,env(safe-area-inset-bottom))]"
            aria-describedby={descriptionId}
          >
            <SheetHeader>
              <SheetTitle id={titleId}>
                <Trans>Change work for this chat</Trans>
              </SheetTitle>
              <SheetDescription id={descriptionId}>
                <Trans>Currently {work.name}</Trans>
              </SheetDescription>
            </SheetHeader>
            <div className="app-scroll px-4 pb-4">{content}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
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
              <Trans>Currently {work.name}</Trans>
            </p>
            {content}
          </PopoverContent>
        </Popover>
      )}
      {undoWorkId ? (
        <button
          type="button"
          className="focus-ring ml-2 rounded-sm text-meta text-jade-text hover:underline"
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

function WorkChoices({
  works,
  currentWorkId,
  targetId,
  pending,
  error,
  onChoose,
}: {
  works: Work[];
  currentWorkId: string;
  targetId: string | null;
  pending: boolean;
  error: string | null;
  onChoose: (work: Work) => void;
}) {
  const active = works.filter((work) => work.status === "active");
  const archived = works.filter((work) => work.status === "archived");
  return (
    <div className="space-y-3">
      <WorkSection
        works={active}
        label={t`Active works`}
        {...{ currentWorkId, targetId, pending, error, onChoose }}
      />
      {archived.length ? (
        <WorkSection
          works={archived}
          label={t`Archived works`}
          archived
          {...{ currentWorkId, targetId, pending, error, onChoose }}
        />
      ) : null}
    </div>
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
}: {
  works: Work[];
  label: string;
  archived?: boolean;
  currentWorkId: string;
  targetId: string | null;
  pending: boolean;
  error: string | null;
  onChoose: (work: Work) => void;
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
