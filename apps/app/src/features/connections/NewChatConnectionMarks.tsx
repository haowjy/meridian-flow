import { Trans } from "@lingui/react/macro";
import type { McpConnectionView } from "@meridian/contracts/mcp";
import { useState } from "react";
import { useMcpConnections } from "@/client/query/useMcpConnections";
import { FailureCard } from "@/components/app/FailureCard";
import { Button } from "@/components/ui/button";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";
import { useTryAgain } from "./ConnectionRow";
import { actionLabel, connectionStanding, problemWord, standingAction } from "./connection-status";

/** The connections a new chat would not get working tools from, each with its fix; null when every one works. */
export function useNewChatConnectionMarks(projectId: string) {
  const list = useMcpConnections(projectId, { watch: true });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const marked = (list.data ?? []).filter(
    (connection) =>
      !dismissed.has(connection.id) && standingAction(connectionStanding(connection)) !== null,
  );
  if (marked.length === 0) return null;
  return marked.map((connection) => (
    <ConnectionMark
      key={connection.id}
      connection={connection}
      onDismiss={() => setDismissed((current) => new Set(current).add(connection.id))}
    />
  ));
}

function ConnectionMark({
  connection,
  onDismiss,
}: {
  connection: McpConnectionView;
  onDismiss: () => void;
}) {
  const tryAgain = useTryAgain(connection);
  const settings = useSettingsNavigation();
  const standing = connectionStanding(connection, tryAgain.isPending);
  const action = standingAction(standing);
  const name = connection.name;
  return (
    <FailureCard tone="info" announce={false} onDismiss={onDismiss}>
      <p className="min-w-0 flex-1 break-words">
        {standing.kind === "checking" ? (
          <Trans>
            Checking <strong>{name}</strong>…
          </Trans>
        ) : standing.kind === "no_tools" ? (
          <Trans>
            <strong>{name}</strong> has no tools chosen.
          </Trans>
        ) : standing.kind === "problem" ? (
          <Trans>
            <strong>{name}</strong>: {problemWord(standing.status)}
          </Trans>
        ) : null}
      </p>
      {action ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            action === "try_again" ? tryAgain.mutate() : settings.open("connections")
          }
        >
          {actionLabel(action)}
        </Button>
      ) : null}
    </FailureCard>
  );
}
