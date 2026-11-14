/** A URI read against the project's tree list: its source, and the node at its path. */
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import {
  API_ACCOUNT_CONTEXT_SOURCES_PATH,
  API_AUTH_ME_PATH,
  apiProjectContextSourcesPath,
  type ContextSource,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";
import { childrenOf, sourceRoot, type TreeNode, type TreeProjection } from "@meridian/project-tree";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { unknownJsonResponse } from "../../core/session";
import { TreeList } from "./tree-list";
import type { ResolvedUri } from "./uri";

function isSource(value: unknown): value is ContextSource {
  const source = value as Partial<ContextSource> | null;
  return (
    typeof source?.id === "string" &&
    typeof source.scheme === "string" &&
    typeof source.owner?.kind === "string"
  );
}

async function sourcesOf(session: Session, path: string): Promise<ContextSource[]> {
  const body = (await session.request("GET", path, undefined, {
    decode: unknownJsonResponse,
  })) as { sources?: unknown } | null;
  if (!Array.isArray(body?.sources) || !body.sources.every(isSource))
    throw new CliError("http_error", `GET ${path}: invalid response`, { malformedResponse: true });
  return body.sources;
}

async function accountId(session: Session): Promise<string> {
  const body = (await session.request("GET", API_AUTH_ME_PATH, undefined, {
    decode: unknownJsonResponse,
  })) as { user?: { userId?: unknown } } | null;
  const id = body?.user?.userId;
  if (typeof id !== "string")
    throw new CliError("http_error", `GET ${API_AUTH_ME_PATH}: invalid response`, {
      malformedResponse: true,
    });
  return id;
}

function ownedBy(source: ContextSource, target: ResolvedUri): boolean {
  const { owner } = source;
  if (target.chatId) return owner.kind === "chat" && owner.chatId === target.chatId;
  if (target.rootThreadId)
    return owner.kind === "lineage" && owner.rootThreadId === target.rootThreadId;
  if (target.workId) return owner.kind === "work" && owner.workId === target.workId;
  return owner.kind === "project";
}

export type OpenedTree = { list: TreeList; source: ContextSource; actor: string };

/**
 * The lists a command's URIs live in: the project's, and the account's for `user://`, each opened
 * once and synced. The command closes them when it is done.
 */
export class Trees {
  private readonly lists = new Map<"project" | "account", Promise<OpenedList>>();

  constructor(
    private readonly session: Session,
    private readonly projectId: string,
  ) {}

  private open(kind: "project" | "account"): Promise<OpenedList> {
    let opened = this.lists.get(kind);
    if (!opened) {
      opened = (async () => {
        const userId = await accountId(this.session);
        const actor = `user:${userId}`;
        const sources = await sourcesOf(
          this.session,
          kind === "account"
            ? API_ACCOUNT_CONTEXT_SOURCES_PATH
            : apiProjectContextSourcesPath(this.projectId),
        );
        const list = await TreeList.open(
          this.session,
          kind === "account"
            ? { kind: "account", userId }
            : { kind: "project", projectId: this.projectId },
          actor,
        );
        return { list, sources, actor };
      })();
      this.lists.set(kind, opened);
    }
    return opened;
  }

  /** The synced list `target` lives in, and the source it names. */
  async at(target: ResolvedUri): Promise<OpenedTree> {
    const { list, sources, actor } = await this.open(
      target.scheme === "user" ? "account" : "project",
    );
    const source = sources.find(
      (entry) => entry.scheme === target.scheme && ownedBy(entry, target),
    );
    if (!source)
      throw new CliError("not_found", `No source for ${target.uri}`, {
        hint: "Check the scheme and its Work or chat owner.",
      });
    return { list, source, actor };
  }

  async close() {
    for (const opened of this.lists.values())
      await opened.then(
        ({ list }) => list.close(),
        () => {},
      );
  }
}

type OpenedList = { list: TreeList; sources: ContextSource[]; actor: string };

/** A node's name as a path segment spells it: exactly, or by the stored name the codec makes of it. */
function spelled(node: TreeNode, segment: string, last: boolean): boolean {
  if (node.displayName === segment) return true;
  if (!last || node.kind !== "document") return false;
  const parsed = parseDocumentFilename(segment);
  return (
    parsed.ok && renderFilename(parsed.value.name, parsed.value.extension) === node.displayName
  );
}

export type PathLookup = {
  /** The node at the whole path, if there is one. */
  node: TreeNode | undefined;
  /** The deepest folder of the path that exists (the source's root when none does). */
  parent: string;
  /** The folder names of the path below `parent` that do not exist yet. */
  missing: string[];
};

export function lookupPath(
  projection: TreeProjection,
  source: ContextSource,
  path: string,
): PathLookup {
  const segments = path.split("/").filter(Boolean);
  let parent = sourceRoot(source.id);
  for (const [at, segment] of segments.entries()) {
    const last = at === segments.length - 1;
    const found = childrenOf(projection, parent).find((node) => spelled(node, segment, last));
    if (!found || (!last && found.kind !== "folder"))
      return { node: undefined, parent, missing: segments.slice(at, -1) };
    if (last) return { node: found, parent, missing: [] };
    parent = found.id;
  }
  return { node: undefined, parent, missing: [] };
}

/** The canonical URI of `path` in `source`, as the server spells it. */
export function uriIn(source: ContextSource, path: string): string {
  return canonicalContextUri(source.scheme, path, source.authority);
}
