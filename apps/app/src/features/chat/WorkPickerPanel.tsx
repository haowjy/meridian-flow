/** Work-specific searchable catalog panel shared by both composer surfaces. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { Check, LoaderCircle, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useId } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  dropdownResultsVariants,
  dropdownRowVariants,
  dropdownSearchClass,
} from "@/components/ui/dropdown-presentation";
import { Input } from "@/components/ui/input";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";
import type { WorkBindingFailure } from "./composer-work-binding-reducer";

export type WorkCatalogView =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "empty" }
  | { status: "ready"; works: Work[]; refreshing: boolean };
export type WorkPickerOperation = {
  currentWorkId: string;
  targetId: string | null;
  pending: boolean;
  failure: WorkBindingFailure | null;
};

const failureCopy = (failure: WorkBindingFailure) => {
  switch (failure.kind) {
    case "thread_busy":
      return t`Wait for this response to finish, then try again.`;
    case "work_unavailable":
      return t`That Work is no longer available. Choose another Work.`;
    case "current_work_missing":
      return t`This chat's current Work could not be found. Refresh the page and try again.`;
    case "reconciled_not_current":
      return t`The Work did not change. Try again.`;
    case "unconfirmed":
      return t`The change could not be confirmed. Try again.`;
  }
};

export function WorkPickerPanel({
  catalog,
  operation,
  query,
  onQueryChange,
  onChoose,
  searchRef,
  focusRefs,
}: {
  catalog: WorkCatalogView;
  operation: WorkPickerOperation;
  query: string;
  onQueryChange: (query: string) => void;
  onChoose: (work: Work) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
}) {
  const searchId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const works = catalog.status === "ready" ? catalog.works : [];
  const filtered = works.filter((work) =>
    `${work.name} ${work.goal ?? ""}`.toLocaleLowerCase().includes(needle),
  );
  const active = filtered.filter(({ status }) => status === "active");
  const archived = filtered.filter(({ status }) => status === "archived");
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
      event.target instanceof HTMLInputElement
    )
      return;
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[data-work-choice]:not(:disabled)",
      ),
    ];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? Math.min(current + 1, rows.length - 1)
            : Math.max(current - 1, 0);
    rows[next]?.focus();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset intrinsic sizing breaks the bounded results scrollport.
    <div
      role="group"
      aria-label={t`Change work for this chat`}
      aria-busy={(catalog.status === "ready" && catalog.refreshing) || operation.pending}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      onKeyDown={navigate}
    >
      <label htmlFor={searchId} className="sr-only">
        <Trans>Search works</Trans>
      </label>
      <div className="relative shrink-0">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchRef}
          id={searchId}
          type="search"
          value={query}
          disabled={catalog.status !== "ready"}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t`Search works`}
          className={dropdownSearchClass}
        />
      </div>
      <div className={`${dropdownResultsVariants({ kind: "picker" })} space-y-2`}>
        {catalog.status === "loading" ? (
          <PickerState>
            <Trans>Loading Works…</Trans>
          </PickerState>
        ) : null}
        {catalog.status === "error" ? (
          <InlineErrorRow
            message={t`Couldn't load Works.`}
            onRetry={catalog.retry}
            retryRef={focusRefs?.retry}
          />
        ) : null}
        {catalog.status === "empty" ? (
          <PickerState>
            <Trans>No Works yet.</Trans>
          </PickerState>
        ) : null}
        {active.length ? (
          <WorkSection
            label={t`Active works`}
            works={active}
            operation={operation}
            onChoose={onChoose}
            focusRefs={focusRefs}
            firstWorkId={filtered[0]?.id}
          />
        ) : null}
        {archived.length ? (
          <WorkSection
            label={t`Archived works`}
            works={archived}
            operation={operation}
            onChoose={onChoose}
            focusRefs={focusRefs}
            firstWorkId={filtered[0]?.id}
            archived
          />
        ) : null}
        {catalog.status === "ready" && !filtered.length ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            <Trans>No works match your search.</Trans>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PickerState({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted-foreground">{children}</p>;
}

function WorkSection({
  label,
  works,
  operation,
  onChoose,
  archived = false,
  focusRefs,
  firstWorkId,
}: {
  label: string;
  works: Work[];
  operation: WorkPickerOperation;
  onChoose: (work: Work) => void;
  archived?: boolean;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
  };
  firstWorkId?: string;
}) {
  return (
    <section aria-label={label}>
      <h3 className={sectionLabelVariants({ variant: "group", className: "mb-1 px-2" })}>
        {label}
      </h3>
      <div className="space-y-0.5">
        {works.map((work) => {
          const current = work.id === operation.currentWorkId;
          const changing = work.id === operation.targetId && operation.pending;
          const error = work.id === operation.targetId ? operation.failure : null;
          const errorId = `${work.id}-work-error`;
          const descriptionId = `${work.id}-work-description`;
          const hasDescription = Boolean((changing && work.goal) || current);
          return (
            <div key={work.id}>
              <Button
                ref={
                  current
                    ? focusRefs?.selected
                    : work.id === firstWorkId
                      ? focusRefs?.first
                      : undefined
                }
                data-work-choice
                variant="ghost"
                type="button"
                disabled={operation.pending}
                aria-current={current ? "true" : undefined}
                aria-describedby={
                  [hasDescription ? descriptionId : null, error ? errorId : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onClick={() => onChoose(work)}
                className={cn(
                  dropdownRowVariants({ kind: "descriptive", selected: current }),
                  "justify-start whitespace-normal",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {archived ? t`${work.name}, Archived` : work.name}
                  </span>
                  {changing ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      <Trans>Changing work</Trans>
                    </span>
                  ) : work.goal ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {work.goal}
                    </span>
                  ) : null}
                </span>
                {changing ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                ) : current ? (
                  <Check className="size-4" aria-hidden />
                ) : null}
                {hasDescription ? (
                  <span id={descriptionId} className="sr-only">
                    {changing && work.goal ? t`Goal: ${work.goal}. ` : null}
                    {current ? <Trans>Current Work for this chat.</Trans> : null}
                  </span>
                ) : null}
              </Button>
              {error ? (
                <p id={errorId} role="alert" className="px-2 pt-1 text-xs text-destructive">
                  {failureCopy(error)}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
