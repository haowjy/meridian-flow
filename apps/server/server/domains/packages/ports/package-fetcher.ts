/**
 * Fetches a repository tree for import and update. An adapter answers a URL: the GitHub adapter
 * resolves the ref and streams the tarball, and a bundle adapter can answer a pinned commit of
 * a pack from shipped bytes beside it, behind a wrapper that picks by URL. Callers hold only
 * this port.
 */

export type FetchRequest = {
  /** `https://github.com/<o>/<r>`, `…/tree/<ref>` or `…/tree/<ref>/<path>`. */
  url: string;
  /**
   * The commit an earlier fetch of this URL returned. Import passes it so it reads the tree
   * inspect saw, even when the branch has moved since.
   */
  commit?: string;
};

export type DroppedEntry = {
  path: string;
  reason: "link" | "too-large";
};

export type FetchedTree = {
  /** Full commit SHA the tree was read at. */
  commit: string;
  repo: string;
  /** The branch or tag the URL named; null for a repository root or a bare commit. */
  ref: string | null;
  /** The import root inside the repository; `""` for its top. */
  path: string;
  /** Regular files under the import root, keyed by path relative to it, as bytes. */
  files: Record<string, Uint8Array>;
  /** Entries left out with a warning. Skipped directories and archives are not listed. */
  dropped: DroppedEntry[];
};

/**
 * The counters one import shares across every fetch it makes. Each call that would cross a
 * limit throws `FetchBudgetError` naming it.
 */
export interface FetchBudget {
  download(bytes: number): void;
  expanded(bytes: number): void;
  entry(): void;
  /** Throws the wall-time error once the deadline has passed. */
  checkTime(): void;
  /** Aborts when the deadline passes, for the requests themselves. */
  readonly signal: AbortSignal;
  used(): { downloadBytes: number; expandedBytes: number; entries: number; elapsedMs: number };
}

export interface PackageFetcher {
  fetchTree(request: FetchRequest, budget: FetchBudget): Promise<FetchedTree>;
}

export type FetchBudgetName = "download" | "expanded" | "entries" | "wall-time";

export class FetchBudgetError extends Error {
  constructor(
    readonly budget: FetchBudgetName,
    message: string,
  ) {
    super(message);
    this.name = "FetchBudgetError";
  }
}

export type PackageFetchErrorCode =
  | "bad-url"
  | "not-found"
  | "ref-not-found"
  | "path-not-found"
  | "path-refused"
  | "host-refused"
  | "rate-limited"
  | "upstream";

export class PackageFetchError extends Error {
  constructor(
    readonly code: PackageFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackageFetchError";
  }
}
