import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpConnectionLevel, McpConnectionView, McpToolView } from "@meridian/contracts/mcp";
import { Plug, Plus } from "lucide-react";
import { useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import {
  addMcpConnection,
  removeMcpConnection,
  undoRemoveMcpConnection,
} from "@/client/api/mcp-api";
import {
  useMcpConnectionCache,
  useMcpConnections,
  useRouteProjectId,
} from "@/client/query/useMcpConnections";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { type GoneRow, withGone } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import {
  AddConnectionForm,
  type AddError,
  type AddValues,
  addName,
  EMPTY_ADD,
  levelLabel,
} from "./AddConnectionForm";
import { ConnectionRow, type PanelFocus, RemovedConnectionRow } from "./ConnectionRow";

type Adding =
  | { kind: "closed" }
  | { kind: "form"; values: AddValues; error: AddError | null }
  | { kind: "connecting"; values: AddValues };

type Removed = GoneRow<McpConnectionView> & { undoing: boolean; failure: string | null };

/**
 * The Connections section of the settings dialog. Inside a project it lists the account's
 * connections ("All my projects") and the project's own ("This project"); outside one, the
 * account's alone.
 */
export function ConnectionsSection() {
  const projectId = useRouteProjectId();
  const list = useMcpConnections(projectId, { watch: true });
  const cache = useMcpConnectionCache();
  const [adding, setAdding] = useState<Adding>({ kind: "closed" });
  const [open, setOpen] = useState<{ id: string; focus: PanelFocus } | null>(null);
  const [seed, setSeed] = useState<{ id: string; tools: McpToolView[] } | null>(null);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);

  const connections = list.data ?? [];
  const nameOf = (id: string | null) =>
    connections.find((connection) => connection.id === id)?.name ?? null;

  const add = async (values: AddValues) => {
    setAdding({ kind: "connecting", values });
    const level: McpConnectionLevel = projectId ? values.level : "account";
    try {
      const added = await addMcpConnection({
        name: addName(values),
        url: values.url.trim(),
        ...(values.token.trim() ? { token: values.token.trim() } : {}),
        ...(level === "project" && projectId ? { projectId } : {}),
      });
      cache.insert(projectId, added.connection);
      setAdding({ kind: "closed" });
      setSeed(added.tools ? { id: added.connection.id, tools: added.tools } : null);
      setOpen({ id: added.connection.id, focus: added.tools ? "tools" : null });
      void cache.refresh();
    } catch (error) {
      setAdding({
        kind: "form",
        values,
        error: {
          // The form holds the name to the server's rule, so a refusal is about the address.
          on: httpErrorStatus(error) === 400 ? "address" : "form",
          message: error instanceof Error ? error.message : t`Couldn't add the connection.`,
        },
      });
    }
  };

  const remove = async (connection: McpConnectionView, group: McpConnectionView[]) => {
    const at = group.findIndex((item) => item.id === connection.id);
    const after = group
      .slice(0, Math.max(at, 0))
      .reverse()
      .map((item) => item.id);
    setOpen(null);
    setRemoveFailed(null);
    setRemoved((current) => [
      ...current.filter((item) => item.key !== connection.id),
      { key: connection.id, row: connection, after, undoing: false, failure: null },
    ]);
    cache.update(connection.id, () => null);
    try {
      await removeMcpConnection(connection.id);
    } catch {
      setRemoved((current) => current.filter((item) => item.key !== connection.id));
      setRemoveFailed(connection.id);
    }
    void cache.refresh();
  };

  const undo = async (id: string) => {
    setRemoved((current) =>
      current.map((item) => (item.key === id ? { ...item, undoing: true, failure: null } : item)),
    );
    try {
      const view = await undoRemoveMcpConnection(id);
      cache.insert(projectId, view);
      setRemoved((current) => current.filter((item) => item.key !== id));
      void cache.refresh();
    } catch (error) {
      setRemoved((current) =>
        current.map((item) =>
          item.key === id
            ? {
                ...item,
                undoing: false,
                failure: error instanceof Error ? error.message : t`Couldn't bring it back.`,
              }
            : item,
        ),
      );
    }
  };

  const groups: { level: McpConnectionLevel; rows: McpConnectionView[] }[] = [
    { level: "account", rows: connections.filter((item) => item.level === "account") },
    ...(projectId
      ? [
          {
            level: "project" as const,
            rows: connections.filter((item) => item.level === "project"),
          },
        ]
      : []),
  ];

  const addButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setAdding({ kind: "form", values: EMPTY_ADD, error: null })}
    >
      <Plus aria-hidden />
      <Trans>Add connection</Trans>
    </Button>
  );

  return (
    <div>
      <header className="mb-4">
        <h2 className={role.sectionHeading}>
          <Trans>Connections</Trans>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <Trans>Services the AI can look things up in while you write.</Trans>
        </p>
      </header>

      {adding.kind === "closed" && list.isSuccess ? <div className="mb-5">{addButton}</div> : null}

      {adding.kind === "form" ? (
        <div className="mb-5">
          <AddConnectionForm
            values={adding.values}
            inProject={projectId !== null}
            error={adding.error}
            onChange={(values) =>
              setAdding({
                ...adding,
                values,
                error: values.url === adding.values.url ? adding.error : null,
              })
            }
            onSubmit={() => void add(adding.values)}
            onCancel={() => setAdding({ kind: "closed" })}
          />
        </div>
      ) : null}

      {list.isError && !list.data ? (
        <InlineErrorRow
          message={t`Couldn't load your connections.`}
          onRetry={() => void list.refetch()}
          className="px-0"
        />
      ) : list.isPending ? (
        <p className={role.emptyLine}>
          <Trans>Loading connections…</Trans>
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => {
            const shown = withGone(
              group.rows,
              (row) => row.id,
              removed.filter((item) => item.row.level === group.level),
            );
            const connecting =
              adding.kind === "connecting" &&
              (projectId ? adding.values.level : "account") === group.level
                ? adding.values
                : null;
            return (
              <section key={group.level} aria-label={levelLabel(group.level)}>
                {projectId ? (
                  <h3 className={`${role.groupLabel} mb-1`}>{levelLabel(group.level)}</h3>
                ) : null}
                <ul className="-mx-1.5">
                  {shown.map((item) =>
                    item.gone ? (
                      <RemovedConnectionRow
                        key={item.key}
                        connection={item.row}
                        undoing={removed.find((each) => each.key === item.key)?.undoing ?? false}
                        failure={removed.find((each) => each.key === item.key)?.failure ?? null}
                        onUndo={() => void undo(item.key)}
                      />
                    ) : (
                      <ConnectionRow
                        key={item.key}
                        connection={item.row}
                        shadowName={item.row.shadowedBy ? nameOf(item.row.shadowedBy) : null}
                        open={open?.id === item.key}
                        focus={open?.id === item.key ? open.focus : null}
                        seedTools={seed?.id === item.key ? seed.tools : null}
                        onToggle={() =>
                          setOpen((current) =>
                            current?.id === item.key ? null : { id: item.key, focus: null },
                          )
                        }
                        onAction={(action) =>
                          setOpen({
                            id: item.key,
                            focus: action === "update_token" ? "token" : "tools",
                          })
                        }
                        removeFailed={removeFailed === item.key}
                        onRemove={() => void remove(item.row, group.rows)}
                      />
                    ),
                  )}
                  {connecting ? (
                    <li>
                      <ListRow
                        icon={Plug}
                        title={addName(connecting)}
                        meta={<Trans>Connecting…</Trans>}
                        disabled
                        onOpen={() => {}}
                      />
                    </li>
                  ) : null}
                </ul>
                {shown.length === 0 && !connecting ? (
                  <p className={role.emptyLine}>
                    {group.level === "account" ? (
                      projectId ? (
                        <Trans>None yet. A connection here is in every project's chats.</Trans>
                      ) : (
                        <Trans>
                          None yet. Add a research index, your notes or a story wiki, and the AI can
                          use its tools in your chats.
                        </Trans>
                      )
                    ) : (
                      <Trans>None yet. A connection here is only in this project's chats.</Trans>
                    )}
                  </p>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
