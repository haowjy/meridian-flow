import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpConnectionView, McpToolView } from "@meridian/contracts/mcp";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { editMcpConnection, listMcpConnectionTools, pinMcpConnection } from "@/client/api/mcp-api";
import { mcpConnectionsRoot, useMcpConnectionCache } from "@/client/query/useMcpConnections";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { role } from "@/components/ui/roles";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import {
  actionLabel,
  addressRefusal,
  type ConnectionAction,
  type ConnectionStanding,
  problemWord,
  standingAction,
  timeAgo,
} from "./connection-status";
import { ToolChooser } from "./ToolChooser";

/** What the panel opens on: the token field after Add a token or Update the token, the tools after Choose tools. */
export type PanelFocus = "token" | "tools" | null;

/** An open connection: how it stands in full, its address, its token, its tools, and Remove. */
export function ConnectionPanel({
  connection,
  standing,
  shadowName,
  focus,
  seedTools,
  onAction,
  onRemove,
}: {
  connection: McpConnectionView;
  standing: ConnectionStanding;
  shadowName: string | null;
  focus: PanelFocus;
  seedTools: McpToolView[] | null;
  onAction: (action: ConnectionAction) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <StandingSentence
        connection={connection}
        standing={standing}
        shadowName={shadowName}
        onAction={onAction}
      />
      <AddressField connection={connection} />
      <TokenField connection={connection} focus={focus === "token"} />
      <ToolsPart connection={connection} seedTools={seedTools} focus={focus === "tools"} />
      <Button variant="outline" size="sm" onClick={onRemove}>
        <Trans>Remove connection</Trans>
      </Button>
    </>
  );
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
      sentence = t`Replaced by this project's own ${shadowName ?? connection.name}`;
      break;
    case "problem":
      sentence = problemWord(standing.status);
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
  const [refusal, setRefusal] = useState<string | null>(null);
  const error = refusal ?? (save.isError ? save.error.message : null);
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed) return;
        const refused = addressRefusal(url);
        setRefusal(refused);
        if (!refused) save.mutate({ url: url.trim() });
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
          onChange={(event) => {
            setUrl(event.target.value);
            setRefusal(null);
          }}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
        />
        {changed ? (
          <Button type="submit" size="sm" disabled={save.isPending}>
            <Trans>Save</Trans>
          </Button>
        ) : null}
      </div>
      {error ? <InlineErrorRow message={error} className="px-0" /> : null}
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
            <Trans>None yet</Trans>
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
          message={t`Couldn't list tools.`}
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
