import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem, ReasoningChoice, ReasoningLevel } from "@meridian/contracts/agents";
import { agentsRootOf, REASONING_LEVELS } from "@meridian/contracts/agents";
import type { ModelOption } from "@meridian/contracts/protocol";
import { NO_OVERRIDES, type ThreadOverrides } from "@meridian/contracts/threads";
import { Settings2 } from "lucide-react";
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { useThreadAgent } from "@/client/query/useAgentFiles";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  dropdownGroupLabelClass,
  dropdownMenuSeparatorClass,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerSearch, PickerSection } from "@/components/ui/picker";
import { useProjectSurfacePrefsStore } from "@/features/project/layout/surface-prefs-store";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";
import { useOpenAgentFile } from "./agent-file-document";
import { type CreationAgent, creationAgentOf, isPickable as pickable } from "./creation-agent";
import { ModelMark } from "./ModelMark";
import { ThreadAgentDefinition } from "./ThreadAgentDefinition";

/** An Agent with the model and reasoning this chat runs it at; a null part is the Agent's own. */
export type AgentChoice = { agent: CreationAgent; overrides: ThreadOverrides };

/** An Agent row: its name over a line of its description. */
const ROW_PX = 40;
const LINE_PX = 32;
const VISIBLE_ROWS = 7;
const MIN_ROWS = 5;
const SEARCH_PX = 44;
const POINT_DELAY_MS = 120;

/**
 * Where the picker opens, and what a pick does there. A new chat's pick stays in the picker; a
 * started chat's own Agent changes its model and reasoning there, and any other Agent hands off;
 * under a turn every Agent hands off. A handoff closes the picker.
 */
export type AgentPickerMode =
  | { kind: "new"; onChoose: (choice: AgentChoice) => void }
  | {
      kind: "chat";
      threadId: string;
      onChoose: (choice: AgentChoice) => void;
      onHandoff: (choice: AgentChoice) => void;
    }
  | { kind: "turn"; onHandoff: (choice: AgentChoice) => void };

type AgentPickerPanelProps = {
  /** The catalog. Agents that can't be used keep their place; ones only other Agents call are left out. */
  status: AgentCatalogStatus;
  /** The chosen Agent's slug and overrides (for a started chat, the bound ones). */
  current: { slug: string | null; overrides: ThreadOverrides };
  mode: AgentPickerMode;
  models: ModelOption[] | null;
  /** The project whose Agent files "Open" and "Manage Agents" reach. */
  projectId: string;
  /** Closes the picker's popover: after a handoff, and before it opens a file or the Agents tab. */
  onClose: () => void;
  focusRefs: {
    /** Where focus lands on open, as in every searchable picker. */
    search: RefObject<HTMLInputElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
};

/**
 * The Agent picker: a search and the Agents on the left; on the right the Agent pointed at, a card
 * about it over its models and reasoning levels. Its size follows the number of Agents alone, so nothing
 * moves while the writer points or searches.
 */
export function AgentPickerPanel({
  status,
  current,
  mode,
  models,
  projectId,
  onClose,
  focusRefs,
}: AgentPickerPanelProps) {
  const [pointed, setPointed] = useState<string | null>(null);
  // The model and reasoning set up for a handoff, which only the handoff itself carries out.
  const [handoffDraft, setHandoffDraft] = useState<{
    slug: string;
    overrides: ThreadOverrides;
  } | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = focusRefs.search;
  // A handoff leaves the chat, so a touch's first tap on a handoff row only shows it; its card's
  // "Hand off to" button confirms. Decided at pointer-down: Android focuses the row on tap,
  // which points it before the click.
  const tapPicks = useRef(true);
  // The pointer re-points only once it rests on a row, so a diagonal move toward the models
  // doesn't swap the Agent they belong to on the way.
  const pointTimer = useRef<number | undefined>(undefined);
  const isPhone = usePhoneShell();
  const choicesRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openAgentFile = useOpenAgentFile(projectId);
  // A started chat runs its Agent as bound until it compacts, so its Default is the bound model
  // and level, not the newest save's: the same binding the stale mark compares.
  const bound = useThreadAgent(mode.kind === "chat" ? mode.threadId : null);
  const agents = (status.agents ?? [])
    .filter((agent) => agent.primary)
    .map((agent) =>
      mode.kind === "chat" && agent.slug === current.slug && bound.data
        ? { ...agent, model: bound.data.model, effort: bound.data.effort }
        : agent,
    );
  if (status.status !== "ready" || agents.length === 0)
    return (
      <Picker>
        {status.status === "loading" || status.status === "disabled" ? (
          <ListLine density="menu" status>
            <Trans>Loading Agents…</Trans>
          </ListLine>
        ) : status.status === "error" ? (
          <InlineErrorRow
            message={t`Couldn't load Agents.`}
            onRetry={status.refetch}
            retryRef={focusRefs.retry}
          />
        ) : (
          <ListLine density="menu">
            <Trans>No Agents available.</Trans>
          </ListLine>
        )}
      </Picker>
    );

  const own =
    mode.kind === "chat" ? agents.find((agent) => agent.slug === current.slug) : undefined;
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
  const handsOff = (agent: AgentCatalogItem) =>
    mode.kind === "turn" || (mode.kind === "chat" && agent !== own);
  const rows = Math.min(Math.max(agents.length, MIN_ROWS), VISIBLE_ROWS);
  const headings = (own ? 1 : 0) + (mode.kind === "new" ? 0 : 1);
  // The search, the rows and the footer: the one height, whatever is pointed at.
  const height = SEARCH_PX + rows * ROW_PX + headings * LINE_PX + LINE_PX + 24;

  /**
   * A handoff runs at what was set up for it; the current Agent at the overrides chosen here; any
   * other starts on its own.
   */
  const overridesFor = (agent: AgentCatalogItem) =>
    handsOff(agent)
      ? handoffDraft?.slug === agent.slug
        ? handoffDraft.overrides
        : NO_OVERRIDES
      : agent.slug === current.slug
        ? current.overrides
        : NO_OVERRIDES;
  const pick = (agent: AgentCatalogItem, next = overridesFor(agent)) => {
    if (!pickable(agent)) return;
    const choice = { agent: creationAgentOf(agent), overrides: next };
    if (handsOff(agent)) {
      if (mode.kind !== "new") mode.onHandoff(choice);
      onClose();
      return;
    }
    if (agent.slug === current.slug && sameOverrides(next, current.overrides)) return;
    if (mode.kind !== "turn") mode.onChoose(choice);
  };
  /** A model or level: picked at once, except for a handoff, which it only sets up. */
  const adjust = (agent: AgentCatalogItem, next: ThreadOverrides) =>
    handsOff(agent) ? setHandoffDraft({ slug: agent.slug, overrides: next }) : pick(agent, next);
  const row = (agent: AgentCatalogItem) => {
    const isCurrent = agent.slug === current.slug;
    return (
      <li
        key={agent.slug}
        data-agent={agent.slug}
        onPointerDown={(event) => {
          tapPicks.current =
            event.pointerType !== "touch" || !handsOff(agent) || agent.slug === shown.slug;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          window.clearTimeout(pointTimer.current);
          pointTimer.current = window.setTimeout(() => setPointed(agent.slug), POINT_DELAY_MS);
        }}
        onPointerLeave={() => window.clearTimeout(pointTimer.current)}
        onFocus={() => {
          window.clearTimeout(pointTimer.current);
          setPointed(agent.slug);
        }}
      >
        <ListRow
          density="menu"
          current={isCurrent}
          pointed={agent.slug === shown.slug}
          crossedOut={!pickable(agent)}
          onOpen={() => {
            if (!tapPicks.current) {
              tapPicks.current = true;
              return setPointed(agent.slug);
            }
            pick(agent);
          }}
          title={agent.name}
          detail={agent.description || undefined}
          meta={sameName.has(agent.name) ? fileName(agent) : undefined}
          describedBy={pickable(agent) ? undefined : `agent-unusable-${agent.slug}`}
        />
      </li>
    );
  };
  const overrides = overridesFor(shown);
  const runsOn = overrides.model ?? shown.model;
  const option = (id: string | null) => (id ? models?.find((model) => model.id === id) : undefined);
  const runsOnOption = option(runsOn);
  const awaitsBinding = shown === own && bound.isPending;
  // Reasoning as the gateway settles it on the model: the Agent's own level, and the one it runs at.
  const ownLevel = settledReasoning(shown.effort, runsOnOption);
  const thinksAt = overrides.effort ? settledReasoning(overrides.effort, runsOnOption) : ownLevel;

  return (
    <Picker>
      <div
        className="@container/agents flex min-h-0 shrink flex-col"
        style={{ "--agents-height": `${height}px` } as CSSProperties}
      >
        {/* Stacked on a phone, the list and the choices each need their own rows: twice the height. */}
        <div className="flex h-[calc(var(--agents-height)*2)] max-h-full min-h-0 flex-col gap-2 @[28rem]/agents:h-(--agents-height) @[28rem]/agents:flex-row">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: routes the list's arrow keys; the rows are the controls. slop-lint: allow suppression the reason is stated in this comment */}
          <div
            ref={listRef}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" && event.target instanceof HTMLElement) {
                if (!event.target.closest("li[data-agent]")) return;
                event.preventDefault();
                focusCurrent(choicesRef.current);
                return;
              }
              handleListKeys(event);
            }}
            className="flex min-h-0 flex-1 flex-col @[28rem]/agents:w-60 @[28rem]/agents:flex-none"
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
                  // Only a search picks on Enter: an empty one would hand off to the first row.
                  const first = needle ? listed.find(pickable) : undefined;
                  if (first) pick(first);
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
              aria-label={mode.kind === "new" ? t`Agents` : t`Hand off to`}
              className="app-scroll flex min-h-0 flex-1 flex-col"
            >
              {mode.kind !== "new" ? (
                <h3 className={dropdownGroupLabelClass}>
                  <Trans>Hand off to</Trans>
                </h3>
              ) : null}
              <PickerSection
                state={
                  listed.length === 0 ? (
                    <ListLine density="menu" status>
                      {t`No Agents match “${query.trim()}”.`}
                    </ListLine>
                  ) : undefined
                }
              >
                {listed.map(row)}
              </PickerSection>
            </section>
            {/* The phone shell has no Agents list to open. */}
            {isPhone ? null : (
              <ul className="shrink-0">
                <li aria-hidden className={dropdownMenuSeparatorClass} />
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
            )}
          </div>
          {/* Reaching this side keeps the Agent it shows: card, models and reasoning move together. */}
          <div
            onPointerEnter={() => window.clearTimeout(pointTimer.current)}
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
          >
            <div className="flex shrink-0 flex-col">
              <AgentCard
                key={shown.slug}
                agent={shown}
                thisChat={mode.kind === "chat" && shown === own ? mode.threadId : null}
                action={
                  handsOff(shown)
                    ? { label: t`Hand off to ${shown.name}`, touchOnly: false }
                    : shown.slug === current.slug
                      ? null
                      : { label: t`Use ${shown.name}`, touchOnly: true }
                }
                onUse={() => pick(shown)}
              />
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: routes the choices' arrow keys; its rows are the controls. slop-lint: allow suppression the reason is stated in this comment */}
            <div
              ref={choicesRef}
              onPointerEnter={() => window.clearTimeout(pointTimer.current)}
              onKeyDown={(event) => {
                handleListKeys(event);
                // Left past the reasoning row's first level, or from a model, goes back to the Agent.
                if (event.key === "ArrowLeft" && !event.defaultPrevented) {
                  event.preventDefault();
                  listRef.current
                    ?.querySelector<HTMLElement>(
                      `li[data-agent="${CSS.escape(shown.slug)}"] [data-list-item]`,
                    )
                    ?.focus();
                  return;
                }
                // Up and Down stay in the choices even with no rows to move between.
                if (event.key === "ArrowUp" || event.key === "ArrowDown") event.preventDefault();
              }}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {pickable(shown) ? (
                <>
                  <ModelChoices
                    agent={shown}
                    runsOn={runsOn}
                    models={awaitsBinding ? null : models}
                    onChoose={(id) => {
                      // A reasoning override follows the model: settled on it, and dropped once
                      // it is the new model's own level.
                      const next = option(id);
                      const effort = overrides.effort && settledReasoning(overrides.effort, next);
                      adjust(shown, {
                        model: id === shown.model ? null : id,
                        effort: effort === settledReasoning(shown.effort, next) ? null : effort,
                      });
                    }}
                  />
                  <ReasoningChoices
                    model={awaitsBinding ? undefined : runsOnOption}
                    own={ownLevel}
                    thinksAt={thinksAt}
                    onChoose={(level) =>
                      adjust(shown, { ...overrides, effort: level === ownLevel ? null : level })
                    }
                  />
                </>
              ) : (
                <Unusable
                  agent={shown}
                  onOpenFile={() => {
                    if (!shown.path || shown.level === "builtin") return;
                    onClose();
                    openAgentFile(shown.level, shown.path);
                  }}
                />
              )}
            </div>
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
  action,
  onUse,
}: {
  agent: AgentCatalogItem;
  /** The chat's id when this is the Agent the chat runs. */
  thisChat: string | null;
  /**
   * Picks this Agent at what the columns show; null when it is already the one picked. A handoff's
   * shows everywhere, as the way to hand off at the model and level set up for it; "Use" only on
   * touch, where a tap has no hover to point with first.
   */
  action: { label: string; touchOnly: boolean } | null;
  onUse: () => void;
}) {
  return (
    // One height for every Agent, so the models under it hold still; the file shows on hover.
    <div
      className="flex h-32 flex-col gap-1 overflow-hidden rounded-lg border border-border-subtle p-3"
      title={agent.path && agent.level !== "builtin" ? fileAddress(agent) : undefined}
    >
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">{agent.name}</p>
        {action && pickable(agent) ? (
          <Button
            variant="secondary"
            size="sm"
            className={cn(
              "shrink-0",
              action.touchOnly && "hidden [@media(hover:none)]:inline-flex coarse:inline-flex",
            )}
            onClick={onUse}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      {agent.description ? (
        <p className="line-clamp-2 text-sm text-foreground" title={agent.description}>
          {agent.description}
        </p>
      ) : null}
      {thisChat ? <ThreadAgentDefinition threadId={thisChat} /> : null}
    </div>
  );
}

function Unusable({ agent, onOpenFile }: { agent: AgentCatalogItem; onOpenFile: () => void }) {
  return (
    <div id={`agent-unusable-${agent.slug}`} className="flex flex-col gap-1 px-2 pt-1.5 text-sm">
      <p className="text-muted-foreground">
        <Trans>Can't be used right now.</Trans>
      </p>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {agent.unavailableReasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {agent.path && agent.level !== "builtin" ? (
        <button type="button" className="text-button self-start" onClick={onOpenFile}>
          {t`Open ${fileName(agent)}`}
        </button>
      ) : null}
    </div>
  );
}

function ModelChoices({
  agent,
  runsOn,
  models,
  onChoose,
}: {
  agent: AgentCatalogItem;
  runsOn: string | null;
  models: ModelOption[] | null;
  onChoose: (id: string) => void;
}) {
  const listRef = useRef<HTMLElement | null>(null);
  // Each Agent's models open on the one it runs on, not where the last Agent's were scrolled.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = 0;
    list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  }, [agent.slug, models === null]);
  if (!models)
    return (
      <div className="app-scroll">
        <ListLine density="menu" status>
          <Trans>Loading models…</Trans>
        </ListLine>
      </div>
    );
  return (
    <section
      ref={listRef}
      aria-label={t`Model for ${agent.name}`}
      className="app-scroll flex flex-col"
    >
      {runsOn && !runsAvailable(models, runsOn) ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          {t`${modelName(models, runsOn)} isn't available now, so replies use ${agent.model ? modelName(models, agent.model) : t`the default model`}.`}
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
  model,
  own,
  thinksAt,
  onChoose,
}: {
  model: ModelOption | undefined;
  /** The Agent's own level on this model; null when it leaves reasoning to the model. */
  own: ReasoningChoice | null;
  thinksAt: ReasoningChoice | null;
  onChoose: (level: ReasoningChoice | null) => void;
}) {
  // A model with no levels to choose leaves the models the whole column.
  if (!model || (model.efforts.length === 0 && !model.canDisable)) return null;
  // The Agent's own level is marked Default; an Agent that names none gets a Default of its own.
  const levels: (ReasoningChoice | null)[] = [
    ...(own === null ? [null] : []),
    ...(model.canDisable ? (["disabled"] as const) : []),
    ...model.efforts,
  ];
  return (
    <section aria-label={t`Reasoning on ${model.name}`} className="shrink-0">
      <div aria-hidden className={dropdownMenuSeparatorClass} />
      {/* One line of levels, so the models above keep the column's height. Up and Down reach the
          row at the level in effect; Left and Right move along it. */}
      <ul data-list-row className="flex flex-wrap gap-1">
        {levels.map((level) => (
          <li key={level ?? "default"}>
            <button
              type="button"
              data-list-item={level === thinksAt || undefined}
              aria-current={level === thinksAt || undefined}
              className={cn(
                dropdownRowVariants({ selected: level === thinksAt }),
                "w-auto gap-1.5",
              )}
              onClick={() => onChoose(level)}
            >
              {level ? reasoningName(level) : t`Default`}
              {level && level === own ? (
                <span className="text-xs text-muted-foreground">{t`Default`}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The level a model runs a reasoning choice at, settled as the gateway's `resolveReasoning` does:
 * the nearest level it offers (a tie goes higher), Off as its lowest level where it can't turn
 * reasoning off, and null (the model's own default) for adaptive or no choice.
 */
function settledReasoning(
  choice: ReasoningChoice | null,
  model: ModelOption | undefined,
): ReasoningChoice | null {
  if (!choice || choice === "adaptive") return null;
  if (!model) return choice;
  if (choice === "disabled" && model.canDisable) return "disabled";
  const rank = (level: ReasoningLevel) => REASONING_LEVELS.indexOf(level);
  const wanted = rank(choice === "disabled" ? "low" : choice);
  const distance = (level: ReasoningLevel) => Math.abs(rank(level) - wanted);
  return model.efforts.reduce<ReasoningLevel | null>(
    (best, level) =>
      best === null ||
      distance(level) < distance(best) ||
      (distance(level) === distance(best) && rank(level) > rank(best))
        ? level
        : best,
    null,
  );
}

function sameOverrides(a: ThreadOverrides, b: ThreadOverrides): boolean {
  return a.model === b.model && a.effort === b.effort;
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

function fileName(agent: AgentCatalogItem): string {
  return agent.path?.split("/").pop() ?? agent.slug;
}

function fileAddress(agent: AgentCatalogItem): string {
  if (agent.level === "builtin" || !agent.path) return fileName(agent);
  const root = agentsRootOf(agent.level).path;
  return root ? `~/${root}/${agent.path}` : `.agents/${agent.path}`;
}
