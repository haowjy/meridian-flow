export type FetchRequest = {
  url: string;
  pin?: Pick<FetchedTree, "commit" | "ref" | "path">;
};

export type DroppedEntry = {
  path: string;
  reason: "link" | "too-large";
};

export type FetchedTree = {
  commit: string;
  repo: string;
  ref: string | null;
  path: string;
  files: Record<string, Uint8Array>;
  dropped: DroppedEntry[];
};

export interface FetchBudget {
  download(bytes: number): void;
  expanded(bytes: number): void;
  entry(): void;
  checkTime(): void;
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
