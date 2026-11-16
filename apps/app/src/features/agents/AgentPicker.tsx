import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem, ReasoningChoice } from "@meridian/contracts/agents";
import { agentsRootOf } from "@meridian/contracts/agents";
import type { ModelList } from "@meridian/contracts/protocol";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import { ChevronRight, Settings2 } from "lucide-react";
import { type CSSProperties, type Ref, type RefObject, useRef, useState } from "react";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerSearch, PickerSection } from "@/components/ui/picker";
import { useProjectSurfacePrefsStore } from "@/features/project/layout/surface-prefs-store";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
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
const LINE_PX = 32;
const VISIBLE_ROWS = 7;
const MIN_ROWS = 5;
const SEARCH_PX = 44;

/** What the right side shows: the Agent pointed at, or the choices a footer row opened. */
type Pane = "agent" | "model" | "reasoning";

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
 * The Agent picker. On the left a search, the Agents, and the chosen Agent's model and reasoning;
 * on the right a card for the Agent pointed at, or the list a model or reasoning row opened. Its
 * size follows the number of Agents alone, so nothing moves while the writer points or searches.
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
  const [pane, setPane] = useState<Pane>("agent");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  // A touch has no hover: its first tap on a row shows the row's card, a second tap picks it.
  // Decided at pointer-down: Android focuses the row on tap, which points it before the click.
  const tapPicks = useRef(true);
  const paneRef = useRef<HTMLDivElement | null>(null);
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
  // The model and reasoning rows set the chosen Agent's; a turn's picker only hands off.
  const chosen = handsOff ? undefined : agents.find((agent) => agent.slug === current.slug);
  const settings = chosen && pickable(chosen) ? chosen : undefined;
  const runsOn = current.overrides.model ?? settings?.model ?? null;
  const thinksAt = current.overrides.effort ?? settings?.effort ?? null;
  const sameName = new Set(
    agents.map((agent) => agent.name).filter((name, index, names) => names.indexOf(name) !== index),
  );
  const firstPickable = listed.find(pickable)?.slug;
  const rows = Math.min(Math.max(agents.length, MIN_ROWS), VISIBLE_ROWS);
  const footerLines = (settings ? 2 : 0) + 1;
  // The search, the rows and the footer: the one height, whatever is pointed at or opened.
  const height = SEARCH_PX + rows * ROW_PX + (own ? 2 * LINE_PX : 0) + footerLines * LINE_PX + 24;

  const choose = (agent: AgentCatalogItem, overrides: ThreadOverrides) => {
    if (pickable(agent)) onChoose({ agent: creationAgentOf(agent), overrides });
  };
  const setOverrides = (overrides: ThreadOverrides) => {
    if (settings) choose(settings, overrides);
  };
  const openPane = (next: Pane, focus: boolean) => {
    setPane(next);
    // The list renders on this commit; focus its current row after it.
    if (focus) requestAnimationFrame(() => focusCurrent(paneRef.current));
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
          if (event.pointerType === "touch") return;
          setPointed(agent.slug);
          setPane("agent");
        }}
        onFocus={() => {
          setPointed(agent.slug);
          setPane("agent");
        }}
      >
        <ListRow
          density="menu"
          current={isCurrent}
          pointed={pane === "agent" && agent.slug === shown.slug}
          crossedOut={!pickable(agent)}
          ref={
            isCurrent
              ? focusRefs.selected
              : agent.slug === firstPickable
                ? focusRefs.first
                : undefined
          }
          // One Tab stop for the list: the row whose card shows. Arrows move between rows.
          controlProps={{ tabIndex: agent.slug === shown.slug ? 0 : -1 }}
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
  const opener = (kind: Exclude<Pane, "agent">, label: string, value: string) => (
    <li
      key={kind}
      data-opens={kind}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setPane(kind);
      }}
    >
      <ListRow
        density="menu"
        pointed={pane === kind}
        onOpen={() => openPane(kind, true)}
        title={
          <span className="flex min-w-0 gap-3">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate">{value}</span>
          </span>
        }
        trailing={<ChevronRight aria-hidden className="text-muted-foreground" />}
      />
    </li>
  );
  const back = () => {
    const from =
      pane === "agent"
        ? `li[data-agent="${CSS.escape(shown.slug)}"] [data-list-item]`
        : `li[data-opens="${pane}"] [data-list-item]`;
    listRef.current?.querySelector<HTMLElement>(from)?.focus();
  };

  return (
    <Picker>
      <div
        className="@container/agents flex min-h-0 shrink flex-col"
        style={{ "--agents-height": `${height}px` } as CSSProperties}
      >
        {/* Stacked on a phone, the list and the pane each need their own rows: twice the height. */}
        <div className="flex h-[calc(var(--agents-height)*2)] max-h-full min-h-0 flex-col gap-2 @[28rem]/agents:h-(--agents-height) @[28rem]/agents:flex-row">
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
                const opens = event.target.closest<HTMLElement>("li[data-opens]")?.dataset.opens;
                if (opens === "model" || opens === "reasoning") {
                  event.preventDefault();
                  return openPane(opens, true);
                }
                if (!event.target.closest("li[data-agent]")) return;
                event.preventDefault();
                focusCurrent(paneRef.current);
                return;
              }
              handleListKeys(event);
            }}
            className="flex min-h-0 flex-1 flex-col @[28rem]/agents:w-72 @[28rem]/agents:flex-none"
          >
            <div className="shrink-0 pb-1">
              <PickerSearch
                ref={searchRef}
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setPointed(null);
                  setPane("agent");
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
            <ul className="mt-1 flex shrink-0 flex-col border-t border-border-subtle pt-1">
              {settings ? (
                <>
                  {opener("model", t`Model`, runsOn ? modelName(models, runsOn) : t`Default`)}
                  {opener(
                    "reasoning",
                    t`Reasoning`,
                    thinksAt ? reasoningName(thinksAt) : t`Default`,
                  )}
                </>
              ) : null}
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
          {/* biome-ignore lint/a11y/noStaticElementInteractions: routes the pane's arrow keys; its rows and buttons are the controls. slop-lint: allow suppression the reason is stated in this comment */}
          <div
            ref={paneRef}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                back();
                return;
              }
              handleListKeys(event);
              // Up and Down stay in the pane even with no rows to move between.
              if (event.key === "ArrowUp" || event.key === "ArrowDown") event.preventDefault();
            }}
            className="app-scroll flex min-h-0 flex-1 flex-col"
          >
            {pane === "agent" || !settings ? (
              <AgentCard
                key={shown.slug}
                agent={shown}
                thisChat={started && shown === own ? started.threadId : null}
                useLabel={
                  handsOff || (started && shown !== own)
                    ? t`Hand off to ${shown.name}`
                    : shown.slug === current.slug
                      ? null
                      : t`Use ${shown.name}`
                }
                onUse={() => choose(shown, NO_OVERRIDES)}
                onOpenFile={() => {
                  if (!shown.path || shown.level === "builtin") return;
                  onClose();
                  openAgentFile(shown.level, shown.path);
                }}
              />
            ) : pane === "model" ? (
              <ModelChoices
                agent={settings}
                runsOn={runsOn}
                models={models}
                rebuildsCache={Boolean(started)}
                onChoose={(id) =>
                  setOverrides({
                    ...current.overrides,
                    model: id === settings.model ? null : id,
                  })
                }
              />
            ) : (
              <ReasoningChoices
                agent={settings}
                model={runsOn ? models?.find((option) => option.id === runsOn) : undefined}
                modelLabel={runsOn ? modelName(models, runsOn) : t`the default model`}
                thinksAt={thinksAt}
                rebuildsCache={Boolean(started)}
                onChoose={(level) =>
                  setOverrides({
                    ...current.overrides,
                    effort: level === settings.effort ? null : level,
                  })
                }
              />
            )}
          </div>
        </div>
      </div>
    </Picker>
  );
}

/** Focuses the pane's current row, else its first control. */
function focusCurrent(pane: HTMLElement | null) {
  const controls = [
    ...(pane?.querySelectorAll<HTMLElement>(
      "[data-list-item]:not(:disabled), button:not(:disabled)",
    ) ?? []),
  ].filter((control) => control.checkVisibility());
  (controls.find((control) => control.getAttribute("aria-current")) ?? controls[0])?.focus();
}

function AgentCard({
  agent,
  thisChat,
  useLabel,
  onUse,
  onOpenFile,
}: {
  agent: AgentCatalogItem;
  /** The chat's id when this is the Agent the chat runs. */
  thisChat: string | null;
  /** Picks this Agent on its own model; null when it is already the one picked. */
  useLabel: string | null;
  onUse: () => void;
  onOpenFile: () => void;
}) {
  const usable = pickable(agent);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-ink-fill p-3">
      <p className="text-sm font-medium">{agent.name}</p>
      {agent.description ? <p className="text-sm text-foreground">{agent.description}</p> : null}
      {agent.path && agent.level !== "builtin" ? (
        <p className="truncate font-mono text-xs text-muted-foreground">{fileAddress(agent)}</p>
      ) : null}
      {thisChat ? <ThreadAgentDefinition threadId={thisChat} /> : null}
      {useLabel && usable ? (
        // Touch picks here, having no hover to point with; a mouse or the keyboard picks the row.
        <button
          type="button"
          className="hidden self-start rounded-md bg-ink-fill-strong px-3 py-1.5 text-sm font-medium text-foreground [@media(hover:none)]:inline-flex coarse:inline-flex"
          onClick={onUse}
        >
          {useLabel}
        </button>
      ) : null}
      {!usable ? (
        <div id={`agent-unusable-${agent.slug}`} className="flex flex-col gap-1 text-sm">
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
      ) : null}
    </div>
  );
}

function ModelChoices({
  agent,
  runsOn,
  models,
  rebuildsCache,
  onChoose,
}: {
  agent: AgentCatalogItem;
  runsOn: string | null;
  models: ModelOption[] | null;
  rebuildsCache: boolean;
  onChoose: (id: string) => void;
}) {
  if (!models)
    return (
      <ListLine density="menu" status>
        <Trans>Loading models…</Trans>
      </ListLine>
    );
  return (
    <section aria-label={t`Model for ${agent.name}`} className="flex flex-col">
      <h3 className={dropdownGroupLabelClass}>{t`Model for ${agent.name}`}</h3>
      {runsOn && !runsAvailable(models, runsOn) ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          {t`${modelName(models, runsOn)} isn't available now, so replies use ${agent.model ? modelName(models, agent.model) : t`the default model`}.`}
        </p>
      ) : null}
      {rebuildsCache ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          <Trans>Changing it rebuilds the chat's cache.</Trans>
        </p>
      ) : null}
      <ul className="flex flex-col">
        {[
          ...models.filter((option) => option.id === agent.model),
          ...models.filter((option) => option.id !== agent.model),
        ].map((option) => (
          <li key={option.id}>
            <ListRow
              density="menu"
              disabled={!option.available}
              current={option.id === runsOn}
              leading={<ModelMark maker={option.maker} />}
              title={option.name}
              meta={option.id === agent.model ? t`Default` : undefined}
              onOpen={() => onChoose(option.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReasoningChoices({
  agent,
  model,
  modelLabel,
  thinksAt,
  rebuildsCache,
  onChoose,
}: {
  agent: AgentCatalogItem;
  model: ModelOption | undefined;
  modelLabel: string;
  thinksAt: ReasoningChoice | null;
  rebuildsCache: boolean;
  /** A level, or null for the model's own when the Agent's file sets none. */
  onChoose: (level: ReasoningChoice | null) => void;
}) {
  const levels: ReasoningChoice[] = model
    ? [...(model.canDisable ? (["disabled"] as const) : []), ...model.efforts]
    : [];
  // An Agent whose file sets no level runs at the model's own: that is its Default.
  const choices: (ReasoningChoice | null)[] = agent.effort ? levels : [null, ...levels];
  return (
    <section aria-label={t`Reasoning on ${modelLabel}`} className="flex flex-col">
      <h3 className={dropdownGroupLabelClass}>{t`Reasoning on ${modelLabel}`}</h3>
      {rebuildsCache ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          <Trans>Changing it rebuilds the chat's cache.</Trans>
        </p>
      ) : null}
      {choices.length === 0 ? (
        <ListLine density="menu" status>
          {t`${modelLabel} has no reasoning levels to choose.`}
        </ListLine>
      ) : (
        <ul className="flex flex-col">
          {choices.map((level) => (
            <li key={level ?? "default"}>
              <ListRow
                density="menu"
                current={level === thinksAt}
                title={level ? reasoningName(level) : t`Default`}
                meta={level && level === agent.effort ? t`Default` : undefined}
                onOpen={() => onChoose(level)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
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
