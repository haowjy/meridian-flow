import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpConnectionView, McpToolView } from "@meridian/contracts/mcp";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plug, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  checkMcpConnection,
  editMcpConnection,
  listMcpConnectionTools,
  pinMcpConnection,
} from "@/client/api/mcp-api";
import { mcpConnectionsRoot, useMcpConnectionCache } from "@/client/query/useMcpConnections";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { RowWord } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import {
  actionLabel,
  type ConnectionAction,
  type ConnectionStanding,
  connectionStanding,
  standingAction,
  timeAgo,
  toolCount,
} from "./connection-status";
import { ToolChooser } from "./ToolChooser";

/** Try again: the server checks now; the row says "Checking…" until the answer replaces it. */
export function useTryAgain(connection: McpConnectionView) {
  const cache = useMcpConnectionCache();
  return useMutation({
    mutationFn: () => checkMcpConnection(connection.id),
    onSuccess: (view) => cache.put(view),
    onSettled: () => void cache.refresh(),
  });
}

/** What the row's panel opens on: the token field after Update the token, the tools after Choose tools. */
export type PanelFocus = "token" | "tools" | null;

export function ConnectionRow({
  connection,
  shadowName,
  open,
  focus,
  seedTools,
  onToggle,
  onAction,
  removeFailed,
  onRemove,
}: {
  connection: McpConnectionView;
  /** For an account connection a project one stands in front of: the project's name for it. */
  shadowName: string | null;
  open: boolean;
  focus: PanelFocus;
  /** The tools the add just listed, so choosing them needs no second listing. */
  seedTools: McpToolView[] | null;
  onToggle: () => void;
  onAction: (action: ConnectionAction) => void;
  removeFailed: boolean;
  onRemove: () => void;
}) {
  const tryAgain = useTryAgain(connection);
  const standing = connectionStanding(connection, tryAgain.isPending);
  const action = standingAction(standing);
  const panel = useId();
  const run = (next: ConnectionAction) => {
    if (next === "try_again") tryAgain.mutate();
    else onAction(next);
  };
  return (
    <li>
      <ListRow
        icon={standing.kind === "problem" ? TriangleAlert : Plug}
        title={connection.name}
        crossedOut={standing.kind === "shadowed"}
        current={open}
        onOpen={onToggle}
        controlProps={{ "aria-expanded": open, "aria-controls": panel }}
        meta={<StandingMeta standing={standing} />}
        detail={open ? null : rowDetail(standing, shadowName)}
        actions={
          action && !open ? (
            <button
              type="button"
              className="text-button mr-1 shrink-0 text-xs coarse:min-h-11"
              onClick={() => run(action)}
            >
              {actionLabel(action)}
            </button>
          ) : null
        }
        below={
          removeFailed ? (
            <InlineErrorRow message={t`Couldn't remove it.`} onRetry={onRemove} />
          ) : tryAgain.isError ? (
            <InlineErrorRow
              message={t`Couldn't reach Flow to check it.`}
              onRetry={() => tryAgain.mutate()}
              onDismiss={() => tryAgain.reset()}
            />
          ) : null
        }
      />
      {open ? (
        <div id={panel} className="mt-1 mb-3 ml-8 space-y-4 border-l border-border-subtle pl-4">
          <StandingSentence
            connection={connection}
            standing={standing}
            shadowName={shadowName}
            onAction={run}
          />
          <AddressField connection={connection} />
          <TokenField connection={connection} focus={focus === "token"} />
          <ToolsPart connection={connection} seedTools={seedTools} focus={focus === "tools"} />
          <Button variant="outline" size="sm" onClick={onRemove}>
            <Trans>Remove connection</Trans>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** A removed connection keeps its place, struck through, until the writer moves on; Undo brings it back. */
export function RemovedConnectionRow({
  connection,
  undoing,
  failure,
  onUndo,
}: {
  connection: McpConnectionView;
  undoing: boolean;
  failure: string | null;
  onUndo: () => void;
}) {
  return (
    <li>
      <ListRow
        icon={Plug}
        title={connection.name}
        gone
        notice={
          <RowWord
            word={<Trans>Undo</Trans>}
            label={t`Undo remove of ${connection.name}`}
            sentence={t`Removed. Undo brings it back with its tools and token.`}
            tone={failure ? "warning" : "action"}
            pending={undoing}
            onAction={onUndo}
            focus={{ take: () => true }}
          />
        }
        below={failure ? <InlineErrorRow message={failure} onRetry={onUndo} /> : null}
      />
    </li>
  );
}

function StandingMeta({ standing }: { standing: ConnectionStanding }) {
  switch (standing.kind) {
    case "checking":
      return <Trans>Checking…</Trans>;
    case "working":
      return toolCount(standing.tools);
    default:
      return null;
  }
}

function rowDetail(standing: ConnectionStanding, shadowName: string | null): ReactNode {
  switch (standing.kind) {
    case "shadowed":
      return shadowName ? t`This project's own ${shadowName} is used here.` : null;
    case "no_tools":
      return t`No tools chosen, so it isn't in your chats.`;
    case "problem":
      return standing.status === "unreachable" ? t`Can't be reached` : standing.reason;
    default:
      return null;
  }
}

function StandingSentence({
  connection,
  standing,
  shadowName,
  onAction,
}: {
  connection: McpConnectionView;
  standing: ConnectionStanding;
  shadowName: string | null;
  onAction: (action: ConnectionAction) => void;
}) {
  const now = useNow(30_000);
  const checked = connection.checkedAt ? timeAgo(connection.checkedAt, now) : null;
  const action = standingAction(standing);
  let sentence: string;
  switch (standing.kind) {
    case "checking":
      sentence = t`Checking that it answers…`;
      break;
    case "shadowed":
      sentence = t`Not used in this project: this project's own ${shadowName ?? connection.name} stands in for it.`;
      break;
    case "problem":
      sentence =
        standing.status === "unreachable"
          ? checked
            ? t`Can't be reached. ${standing.reason} Tried ${checked}.`
            : t`Can't be reached. ${standing.reason}`
          : standing.reason;
      break;
    case "no_tools":
      sentence = checked ? t`Connected, checked ${checked}.` : t`Connected.`;
      break;
    case "working":
      sentence = checked ? t`Connected, checked ${checked}.` : t`Connected.`;
      break;
  }
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <p
        className={
          standing.kind === "problem" ? "text-sm text-warning-ink" : "text-sm text-muted-foreground"
        }
      >
        {sentence}
      </p>
      {action === "try_again" ? (
        <button type="button" className="text-button text-sm" onClick={() => onAction(action)}>
          {actionLabel(action)}
        </button>
      ) : null}
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
      {children}
    </label>
  );
}

/** A new address is a new connection to the server: the status starts over at "Checking…". */
function AddressField({ connection }: { connection: McpConnectionView }) {
  const id = useId();
  const [url, setUrl] = useState(connection.url);
  const save = useEditConnection(connection);
  const changed = url.trim() !== connection.url;
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) save.mutate({ url: url.trim() });
      }}
    >
      <FieldLabel htmlFor={id}>
        <Trans>Address</Trans>
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={save.isError || undefined}
        />
        {changed ? (
          <Button type="submit" size="sm" disabled={save.isPending}>
            <Trans>Save</Trans>
          </Button>
        ) : null}
      </div>
      {save.isError ? <InlineErrorRow message={save.error.message} className="px-0" /> : null}
    </form>
  );
}

/** The token is never shown back: the field says whether one is set, and replaces or clears it. */
function TokenField({ connection, focus }: { connection: McpConnectionView; focus: boolean }) {
  const id = useId();
  const [editing, setEditing] = useState(focus);
  const [token, setToken] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  // The field Save or Cancel stood in leaves; focus goes to the control that opens it again.
  const close = () => {
    setEditing(false);
    setToken("");
    requestAnimationFrame(() => change.current?.focus());
  };
  const save = useEditConnection(connection, close);
  useEffect(() => {
    if (focus) {
      setEditing(true);
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [focus]);
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id}>
        <Trans>Token</Trans>
      </FieldLabel>
      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) save.mutate({ token: token.trim() });
          }}
        >
          <Input
            id={id}
            ref={field}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            placeholder={connection.tokenSet ? t`New token` : t`Token`}
          />
          <Button type="submit" size="sm" disabled={!token.trim() || save.isPending}>
            <Trans>Save</Trans>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : (
        <div id={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            {connection.tokenSet ? <Trans>Set</Trans> : <Trans>None</Trans>}
          </span>
          <button
            ref={change}
            type="button"
            className="text-button text-sm"
            onClick={() => setEditing(true)}
          >
            {connection.tokenSet ? <Trans>Replace</Trans> : <Trans>Add a token</Trans>}
          </button>
          {connection.tokenSet ? (
            <button
              type="button"
              className="text-button text-sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ token: "" })}
            >
              <Trans>Clear</Trans>
            </button>
          ) : null}
        </div>
      )}
      {save.isError ? <InlineErrorRow message={save.error.message} className="px-0" /> : null}
    </div>
  );
}

/** Shows the edit at once (a new version has no result yet), then the server's answer. */
function useEditConnection(connection: McpConnectionView, onSaved?: () => void) {
  const cache = useMcpConnectionCache();
  return useMutation({
    mutationFn: (change: { url?: string; token?: string }) =>
      editMcpConnection(connection.id, change),
    onMutate: (change) =>
      cache.update(connection.id, (current) => ({
        ...current,
        url: change.url ?? current.url,
        tokenSet: change.token === undefined ? current.tokenSet : change.token !== "",
        status: null,
        statusReason: null,
        checkedAt: null,
      })),
    onSuccess: (view) => {
      cache.put(view);
      onSaved?.();
    },
    onError: () => void cache.refresh(),
  });
}

function ToolsPart({
  connection,
  seedTools,
  focus,
}: {
  connection: McpConnectionView;
  seedTools: McpToolView[] | null;
  focus: boolean;
}) {
  const [choosing, setChoosing] = useState(focus || (seedTools !== null && !connection.pin));
  useEffect(() => {
    if (focus) setChoosing(true);
  }, [focus]);
  const cache = useMcpConnectionCache();
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const listing = useQuery({
    queryKey: [...mcpConnectionsRoot(accountId), "tools", connection.id],
    queryFn: ({ signal }) =>
      listMcpConnectionTools(AbortSignal.any([accountSignal, signal]), connection.id),
    enabled: choosing && seedTools === null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const pin = useMutation({
    mutationFn: (names: string[]) => pinMcpConnection(connection.id, names),
    onSuccess: (view) => {
      cache.put(view);
      setChoosing(false);
    },
  });
  const tools = seedTools ?? listing.data?.tools ?? null;
  const pinned = connection.pin?.tools ?? [];

  if (!choosing)
    return (
      <div className="space-y-1.5">
        <h4 className="text-sm font-medium text-foreground">
          <Trans>Tools the AI can use</Trans>
        </h4>
        {pinned.length > 0 ? (
          <ul className="space-y-1">
            {pinned.map((tool) => (
              <li key={tool.name} className="min-w-0">
                <span className="font-mono text-xs text-foreground">{tool.name}</span>
                {tool.description ? (
                  <p
                    className="line-clamp-1 text-xs text-muted-foreground"
                    title={tool.description}
                  >
                    {tool.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {connection.status === "connected" ? (
              <Trans>None yet.</Trans>
            ) : (
              <Trans>None yet. Its tools can be chosen once it answers.</Trans>
            )}
          </p>
        )}
        {pinned.length > 0 || connection.status === "connected" ? (
          <button type="button" className="text-button text-sm" onClick={() => setChoosing(true)}>
            {pinned.length > 0 ? <Trans>Change tools</Trans> : <Trans>Choose tools</Trans>}
          </button>
        ) : null}
      </div>
    );

  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium text-foreground">
        <Trans>Choose the tools the AI can use</Trans>
      </h4>
      {tools ? (
        <ToolChooser
          tools={tools}
          initial={
            new Set(
              connection.pin
                ? pinned.map((tool) => tool.name)
                : tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
            )
          }
          pending={pin.isPending}
          error={pin.isError ? pin.error.message : null}
          onSave={(names) => pin.mutate(names)}
          onCancel={() => setChoosing(false)}
        />
      ) : listing.isError || (listing.isSuccess && listing.data.tools === null) ? (
        <InlineErrorRow
          message={listing.data?.connection.statusReason ?? t`The server didn't list its tools.`}
          onRetry={() => void listing.refetch()}
          className="px-0"
        />
      ) : (
        <p className={role.emptyLine}>
          <Trans>Asking the server for its tools…</Trans>
        </p>
      )}
    </div>
  );
}

/** The time, a step at a time, for "checked 3 minutes ago". */
function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}
