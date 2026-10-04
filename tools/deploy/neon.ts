/** Create and verify a Neon branch snapshot before release migrations run. */

export type NeonSnapshot = { id: string; name: string };

type NeonOptions = {
  apiKey: string;
  projectId: string;
  branchId: string;
  tag: string;
  ttlDays?: number;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  baseUrl?: string;
};

const pendingStatuses = new Set(["scheduling", "running"]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function error(message: string): never {
  throw new Error(`Neon snapshot: ${message}`);
}

function operationIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const value = data as Record<string, unknown>;
  const found: string[] = [];
  const collect = (entry: unknown) => {
    if (typeof entry === "string" && entry) found.push(entry);
    else if (entry && typeof entry === "object") {
      const object = entry as Record<string, unknown>;
      const id = object.id ?? object.operation_id ?? object.operationId;
      if (typeof id === "string" && id) found.push(id);
    }
  };
  if (Array.isArray(value.operations)) value.operations.forEach(collect);
  collect(value.operation);
  return [...new Set(found)];
}

function snapshots(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data))
    return data.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object",
    );
  if (data && typeof data === "object") {
    const list = (data as Record<string, unknown>).snapshots;
    if (Array.isArray(list))
      return list.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === "object",
      );
  }
  return [];
}

export async function createConfirmedSnapshot(options: NeonOptions): Promise<NeonSnapshot> {
  const ttlDays = options.ttlDays ?? 14;
  if (!Number.isInteger(ttlDays) || ttlDays < 1)
    error("NEON_SNAPSHOT_TTL_DAYS must be a positive integer");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    error("operation timeout must be a positive number of milliseconds");
  if (!Number.isFinite(pollMs) || pollMs <= 0)
    error("poll interval must be a positive number of milliseconds");
  const fetcher = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const started = now();
  const stamp = started
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const name = `predeploy-${options.tag}-${stamp}`;
  const expiry = new Date(started.getTime() + ttlDays * 86_400_000).toISOString();
  const base = `${options.baseUrl ?? "https://console.neon.tech"}/api/v2/projects/${encodeURIComponent(options.projectId)}`;
  const headers = { Authorization: `Bearer ${options.apiKey}` };
  const request = async (url: URL, method = "GET") => {
    const response = await fetcher(url, { method, headers });
    if (!response.ok) error(`${method} ${url.pathname} returned HTTP ${response.status}`);
    try {
      return (await response.json()) as unknown;
    } catch {
      return error(`${method} ${url.pathname} returned invalid JSON`);
    }
  };

  const createUrl = new URL(`${base}/branches/${encodeURIComponent(options.branchId)}/snapshot`);
  createUrl.searchParams.set("name", name);
  createUrl.searchParams.set("expires_at", expiry);
  const response = await request(createUrl, "POST");
  const ids = operationIds(response);
  if (!ids.length)
    error("snapshot response contained no operation id; refusing to deploy without confirmation");
  const responseObject = response as Record<string, unknown>;
  const responseSnapshot = responseObject.snapshot as Record<string, unknown> | undefined;
  const createdSnapshotId = responseSnapshot?.id ?? responseObject.snapshot_id ?? responseObject.id;
  if (typeof createdSnapshotId !== "string" || !createdSnapshotId)
    error("snapshot response contained no snapshot id; refusing to deploy without confirmation");

  const deadline = Date.now() + timeoutMs;
  for (const id of ids) {
    while (true) {
      if (Date.now() >= deadline) error(`operation ${id} timed out before completion`);
      const operationUrl = new URL(`${base}/operations/${encodeURIComponent(id)}`);
      const response = (await request(operationUrl)) as Record<string, unknown>;
      const operation = response.operation;
      if (!operation || typeof operation !== "object" || Array.isArray(operation))
        error(`operation ${id} response contained no operation object`);
      const operationData = operation as Record<string, unknown>;
      const status = String(operationData.status ?? "").toLowerCase();
      const rawFailures = operationData.failures_count ?? operationData.failuresCount;
      const failures = Number(rawFailures);
      if (status === "finished") {
        if (rawFailures === undefined || !Number.isFinite(failures) || failures !== 0)
          error(`operation ${id} finished with failures_count=${String(rawFailures)}`);
        break;
      }
      if (!pendingStatuses.has(status))
        error(`operation ${id} ended in non-success status '${status || "missing"}'`);
      await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  const listUrl = new URL(`${base}/snapshots`);
  const list = snapshots(await request(listUrl));
  const snapshot = list.find((item) => {
    return item.name === name && item.source_branch_id === options.branchId;
  });
  const id = snapshot?.id;
  if (typeof id !== "string" || !id)
    error(`confirmed operation but snapshot '${name}' was not present in the snapshot list`);
  if (id !== createdSnapshotId)
    error(`snapshot list id '${id}' does not match create response id '${createdSnapshotId}'`);
  return { id, name };
}
