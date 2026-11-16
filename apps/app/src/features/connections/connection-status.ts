import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { type McpConnectionView, mcpAddressProblem } from "@meridian/contracts/mcp";

/** What fixes a connection that isn't working, or makes one that is usable. */
export type ConnectionAction = "try_again" | "add_token" | "update_token" | "choose_tools";

/**
 * How a connection stands for the writer: a problem with its fix, or a fact for the row's end.
 * `checking` is the app's own word for "no result yet" and for a Try again under way.
 */
export type ConnectionStanding =
  | { kind: "checking" }
  | { kind: "working"; tools: number }
  | { kind: "no_tools" }
  | { kind: "problem"; status: "unreachable"; reason: string }
  | { kind: "problem"; status: "needs_sign_in"; reason: string; tokenSet: boolean }
  | { kind: "shadowed" };

export function connectionStanding(
  connection: McpConnectionView,
  checking = false,
): ConnectionStanding {
  if (connection.shadowedBy) return { kind: "shadowed" };
  if (checking || connection.status === null) return { kind: "checking" };
  if (connection.status === "unreachable")
    return {
      kind: "problem",
      status: "unreachable",
      reason: connection.statusReason ?? t`The server didn't answer.`,
    };
  if (connection.status === "needs_sign_in")
    return {
      kind: "problem",
      status: "needs_sign_in",
      reason: connection.statusReason ?? t`The server needs a valid token.`,
      tokenSet: connection.tokenSet,
    };
  return connection.pin
    ? { kind: "working", tools: connection.pin.tools.length }
    : { kind: "no_tools" };
}

export function standingAction(standing: ConnectionStanding): ConnectionAction | null {
  if (standing.kind === "no_tools") return "choose_tools";
  if (standing.kind !== "problem") return null;
  if (standing.status === "unreachable") return "try_again";
  return standing.tokenSet ? "update_token" : "add_token";
}

export function actionLabel(action: ConnectionAction): string {
  switch (action) {
    case "try_again":
      return t`Try again`;
    case "add_token":
      return t`Add a token`;
    case "update_token":
      return t`Update the token`;
    case "choose_tools":
      return t`Choose tools`;
  }
}

export function toolCount(count: number): string {
  return plural(count, { one: "# tool", other: "# tools" });
}

/** "just now", "3 minutes ago": when a check finished. */
export function timeAgo(iso: string, nowMs: number): string {
  const seconds = Math.round((Date.parse(iso) - nowMs) / 1000);
  const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" });
  if (seconds > -60) return t`just now`;
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** A name the writer can keep: the address's host without `www.`, `api.` or `mcp.`, in the name's letters. */
export function suggestedName(address: string): string {
  let host: string;
  try {
    host = new URL(address.trim()).hostname;
  } catch {
    return "";
  }
  const labels = host.split(".").filter((label) => label && !/^(www|api|mcp)$/i.test(label));
  return (labels[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 40);
}

/** Why Flow won't connect to this address, said before it is sent; null for anything the server must judge. */
export function addressRefusal(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  switch (mcpAddressProblem(url)) {
    case "not_https":
      return t`Flow connects only to https addresses, so the address must start with https://.`;
    case "not_port_443":
      return t`Flow connects only to port 443, so take the port out of the address.`;
    case null:
      return null;
  }
}
