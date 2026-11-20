import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpConnectionView, McpToolView } from "@meridian/contracts/mcp";
import { useMutation } from "@tanstack/react-query";
import { Plug, TriangleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";
import { checkMcpConnection } from "@/client/api/mcp-api";
import { useMcpConnectionCache } from "@/client/query/useMcpConnections";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { RowWord } from "@/components/app/RowWord";
import { ListRow } from "@/components/ui/list-row";
import { ConnectionPanel, type PanelFocus } from "./ConnectionPanel";
import {
  actionLabel,
  type ConnectionAction,
  type ConnectionStanding,
  connectionStanding,
  problemWord,
  standingAction,
  toolCount,
} from "./connection-status";

export type { PanelFocus };

/** Try again: the server checks now; the row says "Checking…" until the answer replaces it. */
export function useTryAgain(connection: McpConnectionView) {
  const cache = useMcpConnectionCache();
  return useMutation({
    mutationFn: () => checkMcpConnection(connection.id),
    onSuccess: (view) => cache.put(view),
    onSettled: () => void cache.refresh(),
  });
}

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
          <ConnectionPanel
            connection={connection}
            standing={standing}
            shadowName={shadowName}
            focus={focus}
            seedTools={seedTools}
            onAction={run}
            onRemove={onRemove}
          />
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
            sentence={t`Removed`}
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
      return t`No tools chosen`;
    case "problem":
      return problemWord(standing.status);
    default:
      return null;
  }
}
