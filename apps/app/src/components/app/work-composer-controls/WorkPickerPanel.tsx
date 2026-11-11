/**
 * Work-specific searchable catalog panel shared by both composer surfaces.
 * It lists only Works a chat can be bound to: an archived Work refuses new
 * bindings, so it is not offered (a chat already in one still shows it as
 * its current Work on the trigger).
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { LoaderCircle } from "lucide-react";
import type { RefObject } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import {
  Picker,
  PickerLine,
  PickerResults,
  PickerRow,
  PickerSearch,
  PickerSection,
} from "@/components/ui/picker";

export type WorkPickerFailure =
  | { kind: "thread_busy" }
  | { kind: "work_unavailable" }
  | { kind: "current_work_missing" }
  | { kind: "reconciled_not_current" }
  | { kind: "unconfirmed" };

export type WorkCatalogView =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "empty" }
  | { status: "ready"; works: Work[]; noWork: Work; refreshing: boolean };
export type WorkPickerOperation = {
  currentWorkId: string | null;
  targetId: string | null;
  pending: boolean;
  failure: WorkPickerFailure | null;
};

type WorkPickerRows = {
  query: string;
  /** Works the chat can be bound to that match the query. */
  works: Work[];
  enabled: boolean;
  enabledIds: string[];
};
export type WorkPickerViewModel = WorkPickerRows &
  (
    | { status: "loading" }
    | { status: "error"; retry: () => void }
    | { status: "empty" }
    | { status: "ready"; noWork: Work; refreshing: boolean }
  );

export function deriveWorkPickerViewModel(
  catalog: WorkCatalogView,
  query: string,
  pending: boolean,
): WorkPickerViewModel {
  const needle = query.trim().toLocaleLowerCase();
  const works =
    catalog.status === "ready"
      ? catalog.works.filter(
          (work) =>
            !isWorkArchived(work) &&
            `${work.name} ${work.goal ?? ""}`.toLocaleLowerCase().includes(needle),
        )
      : [];
  const rows = {
    query,
    works,
    enabled: catalog.status === "ready" && !pending,
    enabledIds: catalog.status === "ready" && !pending ? works.map(({ id }) => id) : [],
  };
  if (catalog.status === "ready")
    return { ...rows, status: "ready", noWork: catalog.noWork, refreshing: catalog.refreshing };
  if (catalog.status === "error") return { ...rows, status: "error", retry: catalog.retry };
  return { ...rows, status: catalog.status };
}

const failureCopy = (failure: WorkPickerFailure) => {
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
  purposeLabel = t`Change work for this chat`,
  view,
  operation,
  onQueryChange,
  onChoose,
  searchRef,
  focusRefs,
}: {
  purposeLabel?: string;
  view: WorkPickerViewModel;
  operation: WorkPickerOperation;
  onQueryChange: (query: string) => void;
  onChoose: (work: Work) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
}) {
  const noneCurrent = view.status === "ready" && operation.currentWorkId === view.noWork.id;
  return (
    <Picker
      label={purposeLabel}
      busy={(view.status === "ready" && view.refreshing) || operation.pending}
    >
      <PickerSearch
        ref={searchRef}
        value={view.query}
        disabled={view.status !== "ready"}
        onChange={onQueryChange}
        label={t`Search Work`}
      />
      <PickerResults>
        {view.status === "ready" ? (
          <PickerSection>
            <PickerRow
              ref={noneCurrent ? focusRefs?.selected : undefined}
              current={noneCurrent}
              disabled={!view.enabled}
              onSelect={() => onChoose(view.noWork)}
              title={<Trans>None</Trans>}
            />
          </PickerSection>
        ) : null}
        {view.status === "loading" ? (
          <PickerLine>
            <Trans>Loading Work…</Trans>
          </PickerLine>
        ) : null}
        {view.status === "error" ? (
          <InlineErrorRow
            message={t`Couldn't load Work.`}
            onRetry={view.retry}
            retryRef={focusRefs?.retry}
          />
        ) : null}
        {view.status === "empty" ? (
          <PickerLine>
            <Trans>No Work yet.</Trans>
          </PickerLine>
        ) : null}
        {view.works.length ? (
          <PickerSection label={t`Active Work`}>
            {view.works.map((work) => {
              const current = work.id === operation.currentWorkId;
              const changing = work.id === operation.targetId && operation.pending;
              const error = work.id === operation.targetId ? operation.failure : null;
              const errorId = `${work.id}-work-error`;
              const helpId = `${work.id}-work-help`;
              const hasHelp = Boolean((changing && work.goal) || current);
              return (
                <PickerRow
                  key={work.id}
                  kind="descriptive"
                  ref={
                    current
                      ? focusRefs?.selected
                      : work.id === view.works[0]?.id
                        ? focusRefs?.first
                        : undefined
                  }
                  current={current}
                  disabled={!view.enabled}
                  describedBy={
                    [hasHelp ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") ||
                    undefined
                  }
                  onSelect={() => onChoose(work)}
                  title={work.name}
                  detail={changing ? <Trans>Changing work</Trans> : work.goal}
                  trailing={
                    <>
                      {changing ? (
                        <LoaderCircle className="size-4 animate-spin" aria-hidden />
                      ) : null}
                      {hasHelp ? (
                        <span id={helpId} className="sr-only">
                          {changing && work.goal ? t`Goal: ${work.goal}. ` : null}
                          {current ? <Trans>Current Work for this chat.</Trans> : null}
                        </span>
                      ) : null}
                    </>
                  }
                  below={
                    error ? (
                      <InlineErrorRow
                        id={errorId}
                        message={failureCopy(error)}
                        className="px-[var(--chat-card-pad-x)] pt-[var(--chat-card-pad-y)] pb-0"
                      />
                    ) : null
                  }
                />
              );
            })}
          </PickerSection>
        ) : null}
        {view.status === "ready" && view.query.trim() !== "" && !view.works.length ? (
          <PickerLine>
            <Trans>No Work matches your search.</Trans>
          </PickerLine>
        ) : null}
      </PickerResults>
    </Picker>
  );
}
