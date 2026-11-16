import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem, ReasoningChoice } from "@meridian/contracts/agents";
import { agentsRootOf } from "@meridian/contracts/agents";
import type { ModelList } from "@meridian/contracts/protocol";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import { Check, Settings2 } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
  type RefObject,
  useRef,
  useState,
} from "react";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerSearch, PickerSection } from "@/components/ui/picker";
import { useProjectSurfacePrefsStore } from "@/features/project/layout/surface-prefs-store";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { cn } from "@/lib/utils";
import { useOpenAgentFile } from "./agent-file-document";
import type { CreationAgent } from "./creation-agent";
import { ModelMark } from "./ModelMark";
import { ThreadAgentDefinition } from "./ThreadAgentDefinition";

export type ModelOption = ModelList["models"][number];
/** An Agent with the model and reasoning this chat runs it at; a null part is the Agent's own. */
export type AgentChoice = { agent: CreationAgent; overrides: ThreadOverrides };
export const NO_OVERRIDES: ThreadOverrides = { model: null, effort: null };

/** An Agent row: its name over a line of its description. */
const ROW_PX = 40;
const VISIBLE_ROWS = 8;
const MIN_ROWS = 6;
const SEARCH_PX = 44;
const FOOTER_PX = 40;

type AgentPickerPanelProps = {
  status: AgentCatalogStatus;
  /**
   * The catalog. Agents that can't be used keep their place; ones only other Agents call are left
   * out.
   */
  agents: AgentCatalogItem[];
  /** The chosen Agent's slug and model override (for a started chat, the bound ones). */
  current: { slug: string | null; overrides: ThreadOverrides };
  /** A started chat: its Agent is pinned under "This chat", and the rest hand off. */
  started?: { threadId: string };
  /** Picking hands off from a turn (the picker under a turn), the current Agent included. */
  handsOff?: boolean;
  models: ModelOption[] | null;
  onChoose: (choice: AgentChoice) => void;
  /** The project whose Agent files "Open" and "Manage Agents" reach. */
  projectId: string;
  /** Closes the picker's popover, before it opens a file or the Agents tab. */
  onClose: () => void;
  focusRefs: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
};

/**
 * The Agent picker: a search and names on the left, the Agent pointed at and its models on the
 * right. Its size follows the number of Agents alone, so nothing moves while the writer points or
 * searches; each side scrolls inside it.
 */
export function AgentPickerPanel({
  status,
  agents: catalog,
  current,
  started,
  handsOff = false,
  models,
  onChoose,
  projectId,
  onClose,
  focusRefs,
}: AgentPickerPanelProps) {
  const [pointed, setPointed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  // A touch has no hover: its first tap on a row shows the row's detail, a second tap picks it.
  // Decided at pointer-down: Android focuses the row on tap, which points it before the click.
  const tapPicks = useRef(true);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openAgentFile = useOpenAgentFile(projectId);
  const agents = catalog.filter((agent) => agent.primary);
  if (status.status !== "ready" || agents.length === 0)
    return (
      <Picker>
        {status.status === "loading" || status.status === "disabled" ? (
          <ListLine density="menu" status>
            <Trans>Loading agents…</Trans>
          </ListLine>
        ) : status.status === "error" ? (
          <InlineErrorRow
            message={t`Couldn't load agents.`}
            onRetry={status.refetch}
            retryRef={focusRefs.retry}
          />
        ) : (
          <ListLine density="menu">
            <Trans>No agents available.</Trans>
          </ListLine>
        )}
      </Picker>
    );

  const own = started ? agents.find((agent) => agent.slug === current.slug) : undefined;
  const needle = query.trim().toLowerCase();
  const listed = agents.filter(
    (agent) =>
      agent !== own &&
      (!needle ||
        agent.name.toLowerCase().includes(needle) ||
        agent.description.toLowerCase().includes(needle)),
  );
  const shown =
    [...(own ? [own] : []), ...listed].find((agent) => agent.slug === (pointed ?? current.slug)) ??
    own ??
    listed[0] ??
    agents[0];
  const sameName = new Set(
    agents.map((agent) => agent.name).filter((name, index, names) => names.indexOf(name) !== index),
  );
  const firstPickable = listed.find(pickable)?.slug;
  // A short list still leaves the detail room for its model choices.
  const rows = Math.min(Math.max(agents.length + (own ? 1 : 0), MIN_ROWS), VISIBLE_ROWS);
  // The search, the footer line and the rows: the one height, whatever is pointed at or searched.
  const height = SEARCH_PX + rows * ROW_PX + FOOTER_PX + 24;

  const choose = (agent: AgentCatalogItem, overrides: ThreadOverrides) => {
    if (pickable(agent)) onChoose({ agent: creationAgentOf(agent), overrides });
  };
  const row = (agent: AgentCatalogItem) => {
    const isCurrent = agent.slug === current.slug;
    return (
      <li
        key={agent.slug}
        data-agent={agent.slug}
        onPointerDown={(event) => {
          tapPicks.current = event.pointerType !== "touch" || agent.slug === shown.slug;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setPointed(agent.slug);
        }}
        onFocus={() => setPointed(agent.slug)}
      >
        <ListRow
          density="menu"
          current={isCurrent}
          pointed={agent.slug === shown.slug}
          crossedOut={!pickable(agent)}
          ref={
            isCurrent
              ? focusRefs.selected
              : agent.slug === firstPickable
                ? focusRefs.first
                : undefined
          }
          // One Tab stop for the list: the row whose detail shows. Arrows move between rows.
          controlProps={{
            tabIndex: agent.slug === shown.slug ? 0 : -1,
            title:
              agent.path && agent.level !== "builtin"
                ? `${agent.description}\n${fileAddress(agent)}`
                : agent.description || undefined,
          }}
          onOpen={() => {
            if (!tapPicks.current) {
              tapPicks.current = true;
              return setPointed(agent.slug);
            }
            // The current Agent keeps the model and reasoning it runs at here.
            choose(agent, isCurrent ? current.overrides : NO_OVERRIDES);
          }}
          title={agent.name}
          detail={agent.description || undefined}
          meta={sameName.has(agent.name) ? fileName(agent) : undefined}
          describedBy={pickable(agent) ? undefined : `agent-unusable-${agent.slug}`}
        />
      </li>
    );
  };

  return (
    <Picker>
      <div
        className="@container/agents flex min-h-0 shrink flex-col"
        style={{ "--agents-height": `${height}px` } as CSSProperties}
      >
        {/* Stacked on a phone, the list and the detail each need their own rows: twice the height. */}
        <div className="flex h-[calc(var(--agents-height)*2)] max-h-full min-h-0 flex-col gap-1 @[28rem]/agents:h-(--agents-height) @[28rem]/agents:flex-row">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: routes the list's arrow keys; the rows are the controls. slop-lint: allow suppression the reason is stated in this comment */}
          <div
            ref={listRef}
            onKeyDown={(event) => {
              // Typing on a row searches, as it would with the search focused.
              if (
                event.key.length === 1 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                event.target !== searchRef.current
              ) {
                event.preventDefault();
                setQuery((value) => value + event.key);
                searchRef.current?.focus();
                return;
              }
              if (event.key === "ArrowRight" && event.target instanceof HTMLElement) {
                if (!event.target.closest("li[data-agent]")) return;
                event.preventDefault();
                focusColumn(detailRef.current, "models");
                return;
              }
              handleListKeys(event);
            }}
            className="flex min-h-0 flex-1 flex-col @[28rem]/agents:w-56 @[28rem]/agents:flex-none @[28rem]/agents:border-r @[28rem]/agents:border-border-subtle @[28rem]/agents:pr-1"
          >
            <div className="shrink-0 pb-1">
              <PickerSearch
                ref={searchRef}
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setPointed(null);
                }}
                onSubmit={() => {
                  const first = listed.find(pickable);
                  if (first) choose(first, NO_OVERRIDES);
                }}
                label={t`Search Agents`}
              />
            </div>
            {own ? (
              <section aria-label={t`This chat`} className="shrink-0">
                <h3 className={dropdownGroupLabelClass}>
                  <Trans>This chat</Trans>
                </h3>
                <ul className="flex flex-col">{row(own)}</ul>
              </section>
            ) : null}
            <section
              aria-label={own ? t`Hand off to` : t`Agents`}
              className="app-scroll flex min-h-0 flex-1 flex-col"
            >
              {own ? (
                <h3 className={dropdownGroupLabelClass}>
                  <Trans>Hand off to</Trans>
                </h3>
              ) : null}
              <PickerSection
                state={
                  listed.length === 0 ? (
                    <ListLine density="menu" status>
                      <Trans>No Agents match.</Trans>
                    </ListLine>
                  ) : undefined
                }
              >
                {listed.map(row)}
              </PickerSection>
            </section>
            <ul className="mt-1 shrink-0 border-t border-border-subtle pt-1">
              <li>
                <ListRow
                  density="menu"
                  icon={Settings2}
                  title={<span className="text-muted-foreground">{t`Manage Agents`}</span>}
                  onOpen={() => {
                    onClose();
                    useSidebarTabs.getState().reveal("agents");
                    useProjectSurfacePrefsStore.getState().setSlotOpen("rail-l", true);
                  }}
                />
              </li>
            </ul>
          </div>
          <AgentDetail
            key={shown.slug}
            ref={detailRef}
            onBack={() =>
              listRef.current
                ?.querySelector<HTMLElement>(
                  `li[data-agent="${CSS.escape(shown.slug)}"] [data-list-item]`,
                )
                ?.focus()
            }
            useLabel={
              handsOff || (started && shown !== own)
                ? t`Hand off to ${shown.name}`
                : shown.slug === current.slug
                  ? null
                  : t`Use ${shown.name}`
            }
            onUse={() => choose(shown, NO_OVERRIDES)}
            agent={shown}
            thisChat={started && shown === own ? started.threadId : null}
            overrides={shown.slug === current.slug ? current.overrides : NO_OVERRIDES}
            models={models}
            onChoose={(overrides) => choose(shown, overrides)}
            onOpenFile={() => {
              if (!shown.path || shown.level === "builtin") return;
              onClose();
              openAgentFile(shown.level, shown.path);
            }}
          />
        </div>
      </div>
    </Picker>
  );
}

function AgentDetail({
  ref,
  onBack,
  useLabel,
  onUse,
  agent,
  thisChat,
  overrides,
  models,
  onChoose,
  onOpenFile,
}: {
  ref: Ref<HTMLDivElement>;
  /** Left arrow: back to the Agent's row. */
  onBack: () => void;
  /** Picks this Agent on its own model; null when it is already the one picked. */
  useLabel: string | null;
  onUse: () => void;
  agent: AgentCatalogItem;
  /** The chat's id when this is the Agent the chat runs. */
  thisChat: string | null;
  /** The overrides this Agent runs with here. */
  overrides: ThreadOverrides;
  models: ModelOption[] | null;
  onChoose: (overrides: ThreadOverrides) => void;
  onOpenFile: () => void;
}) {
  const runsOn = overrides.model ?? agent.model;
  const usable = pickable(agent);
  const option = runsOn ? models?.find((model) => model.id === runsOn) : undefined;
  const levels: ReasoningChoice[] = option
    ? [...(option.canDisable ? (["disabled"] as const) : []), ...option.efforts]
    : [];
  const thinksAt = overrides.effort ?? agent.effort;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: routes arrow keys between the detail's columns. slop-lint: allow suppression the reason is stated in this comment
    <div
      ref={ref}
      onKeyDown={(event) => {
        const column = (event.target as HTMLElement).closest<HTMLElement>("[data-column]");
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          if (column?.dataset.column === "reasoning") focusColumn(event.currentTarget, "models");
          else onBack();
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          if (column?.dataset.column === "models") focusColumn(event.currentTarget, "reasoning");
          return;
        }
        handleListKeys(event);
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 border-t border-border-subtle pt-2 @[28rem]/agents:border-t-0 @[28rem]/agents:pt-0"
    >
      {thisChat || (useLabel && usable) ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-1.5">
          {thisChat ? <ThreadAgentDefinition threadId={thisChat} /> : null}
          {useLabel && usable ? (
            // Touch picks here, having no hover to point with; a mouse or the keyboard picks the row.
            <button
              type="button"
              className="hidden rounded-md bg-ink-fill-strong px-3 py-1.5 text-sm font-medium text-foreground [@media(hover:none)]:inline-flex coarse:inline-flex"
              onClick={onUse}
            >
              {useLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {!usable ? (
        <div
          id={`agent-unusable-${agent.slug}`}
          className="flex flex-col gap-1 px-2 pt-1.5 text-sm"
        >
          <p className="text-muted-foreground">
            <Trans>Can't be used right now.</Trans>
          </p>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {agent.unavailableReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {agent.path && agent.level !== "builtin" ? (
            <button
              type="button"
              className="self-start text-sm font-medium underline underline-offset-2"
              onClick={onOpenFile}
            >
              {t`Open ${fileName(agent)}`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section
            aria-label={t`Model`}
            data-column="models"
            onKeyDown={stayInColumn}
            className="app-scroll flex min-h-0 min-w-0 flex-1 flex-col px-1"
          >
            {runsOn && models && !runsAvailable(models, runsOn) ? (
              <p className="px-1 pb-1 text-xs text-muted-foreground">
                {t`${modelName(models, runsOn)} isn't available now, so replies use ${agent.model ? modelName(models, agent.model) : t`the default model`}.`}
              </p>
            ) : null}
            {thisChat ? (
              <p className="px-1 pb-1 text-xs text-muted-foreground">
                <Trans>Changing the model rebuilds the chat's cache.</Trans>
              </p>
            ) : null}
            <ModelChoices
              own={agent.model}
              runsOn={runsOn}
              models={models}
              onChoose={(id) => onChoose({ ...overrides, model: id === agent.model ? null : id })}
            />
          </section>
          <section
            aria-label={t`Reasoning`}
            data-column="reasoning"
            onKeyDown={stayInColumn}
            className="app-scroll flex min-h-0 w-34 flex-none flex-col border-l border-border-subtle px-1"
          >
            <ul className="flex flex-col">
              {levels.map((level) => (
                <li key={level}>
                  <ListRow
                    density="menu"
                    leading={
                      <Check
                        aria-hidden
                        className={cn("size-3.5", level !== thinksAt && "invisible")}
                      />
                    }
                    title={reasoningName(level)}
                    meta={level === agent.effort ? t`Default` : undefined}
                    onOpen={() =>
                      onChoose({ ...overrides, effort: level === agent.effort ? null : level })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

/** Up and Down move within one detail column, even one with no rows to move between. */
function stayInColumn(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  handleListKeys(event);
  event.preventDefault();
  event.stopPropagation();
}

/** Focuses a detail column's checked row, else its first. */
function focusColumn(detail: HTMLElement | null, column: "models" | "reasoning") {
  const rows = [
    ...(detail?.querySelectorAll<HTMLElement>(
      `[data-column="${column}"] [data-list-item]:not(:disabled)`,
    ) ?? []),
  ];
  (rows.find((row) => row.querySelector("svg:not(.invisible)")) ?? rows[0])?.focus();
}

function ModelChoices({
  own,
  runsOn,
  models,
  onChoose,
}: {
  own: string | null;
  runsOn: string | null;
  models: ModelOption[] | null;
  onChoose: (id: string) => void;
}) {
  if (!models)
    return (
      <ListLine density="menu" status>
        <Trans>Loading models…</Trans>
      </ListLine>
    );
  return (
    <ul className="flex flex-col">
      {[
        ...models.filter((option) => option.id === own),
        ...models.filter((option) => option.id !== own),
      ].map((option) => (
        <li key={option.id}>
          <ListRow
            density="menu"
            disabled={!option.available}
            leading={
              <>
                <Check
                  aria-hidden
                  className={cn("size-3.5", option.id !== runsOn && "invisible")}
                />
                <ModelMark maker={option.maker} />
              </>
            }
            title={option.name}
            meta={option.id === own ? t`Default` : undefined}
            onOpen={() => onChoose(option.id)}
          />
        </li>
      ))}
    </ul>
  );
}

/** Whether this deployment can run the model; an id it has never heard of can't run either. */
export function runsAvailable(models: readonly ModelOption[], id: string): boolean {
  return models.some((option) => option.id === id && option.available);
}

export function reasoningName(choice: ReasoningChoice): string {
  switch (choice) {
    case "low":
      return t`Low`;
    case "medium":
      return t`Medium`;
    case "high":
      return t`High`;
    case "max":
      return t`Max`;
    case "disabled":
      return t`Off`;
    case "adaptive":
      return t`Adaptive`;
  }
}

export function modelName(models: readonly ModelOption[] | null, id: string): string {
  return models?.find((option) => option.id === id)?.name ?? id;
}

function pickable(agent: AgentCatalogItem): boolean {
  return agent.selection !== null && agent.unavailableReasons.length === 0;
}

function creationAgentOf(agent: AgentCatalogItem): CreationAgent {
  if (!agent.selection) throw new Error(`Agent ${agent.slug} has nothing to pick`);
  return { selection: agent.selection, slug: agent.slug, name: agent.name };
}

function fileName(agent: AgentCatalogItem): string {
  return agent.path?.split("/").pop() ?? agent.slug;
}

function fileAddress(agent: AgentCatalogItem): string {
  if (agent.level === "builtin" || !agent.path) return fileName(agent);
  const root = agentsRootOf(agent.level).path;
  return root ? `~/${root}/${agent.path}` : `.agents/${agent.path}`;
}
