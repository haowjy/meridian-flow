import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { agentsRootOf } from "@meridian/contracts/agents";
import { Check, Settings2 } from "lucide-react";
import { type CSSProperties, type Ref, type RefObject, useRef, useState } from "react";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { DisclosureMark } from "@/components/ui/marks";
import { Picker, PickerSection } from "@/components/ui/picker";
import { useProjectSurfacePrefsStore } from "@/features/project/layout/surface-prefs-store";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { cn } from "@/lib/utils";
import { useOpenAgentFile } from "./agent-file-document";
import type { CreationAgent } from "./creation-agent";
import { ThreadAgentDefinition } from "./ThreadAgentDefinition";

export type ModelOption = { id: string; name: string; available: boolean };
/** An Agent with the model this chat runs it on; null is the Agent's own model. */
export type AgentChoice = { agent: CreationAgent; model: string | null };

const ROW_PX = 32;
const VISIBLE_ROWS = 8;
const MIN_ROWS = 7;

type AgentPickerPanelProps = {
  status: AgentCatalogStatus;
  /**
   * The catalog. Agents that can't be used keep their place; ones only other Agents call are left
   * out.
   */
  agents: AgentCatalogItem[];
  /** The chosen Agent's slug and model override (for a started chat, the bound ones). */
  current: { slug: string | null; model: string | null };
  /** A started chat: its Agent is pinned under "This chat", and the rest hand off. */
  started?: { threadId: string };
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
 * The Agent picker: names on the left, the Agent pointed at on the right. Its size follows the
 * number of Agents alone, so nothing moves while the writer points or opens "Runs on"; each side
 * scrolls inside it.
 */
export function AgentPickerPanel({
  status,
  agents: catalog,
  current,
  started,
  models,
  onChoose,
  projectId,
  onClose,
  focusRefs,
}: AgentPickerPanelProps) {
  const [pointed, setPointed] = useState<string | null>(null);
  // A touch has no hover: its first tap on a row shows the row's detail, a second tap picks it.
  const touch = useRef(false);
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
  const listed = own ? agents.filter((agent) => agent !== own) : agents;
  const shown =
    agents.find((agent) => agent.slug === (pointed ?? current.slug)) ?? own ?? agents[0];
  const sameName = new Set(
    agents.map((agent) => agent.name).filter((name, index, names) => names.indexOf(name) !== index),
  );
  const firstPickable = listed.find(pickable)?.slug;
  // A short list still leaves the detail room for its model choices.
  const rows = Math.min(Math.max(listed.length + (own ? 2 : 0), MIN_ROWS), VISIBLE_ROWS);
  // Header and footer lines plus the rows: the one height, whatever is pointed at.
  const height = (rows + 1) * ROW_PX + 24;

  const choose = (agent: AgentCatalogItem, model: string | null) => {
    if (pickable(agent)) onChoose({ agent: creationAgentOf(agent), model });
  };
  const row = (agent: AgentCatalogItem) => {
    const isCurrent = agent.slug === current.slug;
    return (
      <li
        key={agent.slug}
        data-agent={agent.slug}
        onPointerDown={(event) => {
          touch.current = event.pointerType === "touch";
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setPointed(agent.slug);
        }}
        onFocus={() => setPointed(agent.slug)}
      >
        <ListRow
          density="menu"
          current={isCurrent}
          crossedOut={!pickable(agent)}
          ref={
            isCurrent
              ? focusRefs.selected
              : agent.slug === firstPickable
                ? focusRefs.first
                : undefined
          }
          // One Tab stop for the list: the row whose detail shows. Arrows move between rows.
          controlProps={{ tabIndex: agent.slug === shown.slug ? 0 : -1 }}
          onOpen={() => {
            if (touch.current && agent.slug !== shown.slug) return setPointed(agent.slug);
            // The current Agent keeps the model it runs on here.
            choose(agent, isCurrent ? current.model : null);
          }}
          title={agent.name}
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
              if (event.key === "ArrowRight" && event.target instanceof HTMLElement) {
                if (!event.target.closest("li[data-agent]")) return;
                event.preventDefault();
                // The first control on screen: the touch-only "Use" button is hidden under a mouse.
                [
                  ...(detailRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ??
                    []),
                ]
                  .find((button) => button.checkVisibility())
                  ?.focus();
                return;
              }
              handleListKeys(event);
            }}
            className="flex min-h-0 flex-1 flex-col @[28rem]/agents:w-52 @[28rem]/agents:flex-none @[28rem]/agents:border-r @[28rem]/agents:border-border-subtle @[28rem]/agents:pr-1"
          >
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
              <PickerSection>{listed.map(row)}</PickerSection>
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
              started && shown !== own
                ? t`Hand off to ${shown.name}`
                : shown.slug === current.slug
                  ? null
                  : t`Use ${shown.name}`
            }
            onUse={() => choose(shown, null)}
            agent={shown}
            thisChat={started && shown === own ? started.threadId : null}
            model={shown.slug === current.slug ? current.model : null}
            models={models}
            onChoose={(model) => choose(shown, model)}
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
  model,
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
  /** The override this Agent runs with here, if any. */
  model: string | null;
  models: ModelOption[] | null;
  onChoose: (model: string | null) => void;
  onOpenFile: () => void;
}) {
  const [open, setOpen] = useState(false);
  const runsOn = model ?? agent.model;
  const usable = pickable(agent);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: routes arrow keys between the detail's controls. slop-lint: allow suppression the reason is stated in this comment
    <div
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onBack();
          return;
        }
        handleListKeys(event);
      }}
      className="app-scroll flex min-h-0 flex-1 flex-col gap-2 border-t border-border-subtle px-2 pt-2 @[28rem]/agents:border-t-0 @[28rem]/agents:pt-1.5"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{agent.name}</p>
        {agent.description ? (
          <p className="text-sm text-muted-foreground">{agent.description}</p>
        ) : null}
        {agent.path && agent.level !== "builtin" ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{fileAddress(agent)}</p>
        ) : null}
      </div>
      {thisChat ? <ThreadAgentDefinition threadId={thisChat} /> : null}
      {useLabel && usable ? (
        // Touch picks here, having no hover to point with; a mouse or the keyboard picks the row.
        <button
          type="button"
          className="hidden self-start rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground [@media(hover:none)]:inline-flex coarse:inline-flex"
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
              className="self-start text-sm font-medium text-jade-text hover:underline underline-offset-2"
              onClick={onOpenFile}
            >
              {t`Open ${fileName(agent)}`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col">
          <button
            type="button"
            aria-expanded={open}
            className="flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm hover:bg-ink-fill"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="text-muted-foreground">
              {thisChat ? <Trans>This chat runs on</Trans> : <Trans>Runs on</Trans>}
            </span>
            <span className={cn("min-w-0 truncate", model && "text-jade-text")}>
              {runsOn ? modelName(models, runsOn) : t`the default model`}
            </span>
            <DisclosureMark open={open} className="ml-auto" />
          </button>
          {runsOn && models?.some((option) => option.id === runsOn && !option.available) ? (
            <p className="px-1 pb-1 text-xs text-muted-foreground">
              {t`${modelName(models, runsOn)} isn't available now, so replies use ${agent.model ? modelName(models, agent.model) : t`the default model`}.`}
            </p>
          ) : null}
          {open && thisChat ? (
            <p className="px-1 pb-1 text-xs text-muted-foreground">
              <Trans>Changing the model rebuilds this chat's cache on the next reply.</Trans>
            </p>
          ) : null}
          {open ? (
            <ModelChoices
              own={agent.model}
              runsOn={runsOn}
              models={models}
              onChoose={(id) => onChoose(id === agent.model ? null : id)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
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
              <Check
                aria-hidden
                className={cn("size-3.5 text-jade-text", option.id !== runsOn && "invisible")}
              />
            }
            current={option.id === runsOn}
            title={option.name}
            meta={option.id === own ? t`its own` : undefined}
            onOpen={() => onChoose(option.id)}
          />
        </li>
      ))}
    </ul>
  );
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
