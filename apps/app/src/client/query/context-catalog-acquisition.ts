/** Per-QueryClient catalog drain coordinator: one request stream per normalized scope key. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getContextCatalogChanges, getContextCatalogSnapshot } from "@/client/api/projects-api";
import {
  applyCatalogChanges,
  type CatalogCacheView,
  catalogViewFromSnapshot,
} from "./context-catalog-cache";

type State = {
  hintedHighWater: bigint;
  inFlight: Promise<CatalogCacheView> | null;
};

const states = new WeakMap<QueryClient, Map<string, State>>();

function stateFor(queryClient: QueryClient, queryKey: QueryKey): State {
  let clientStates = states.get(queryClient);
  if (!clientStates) {
    clientStates = new Map();
    states.set(queryClient, clientStates);
  }
  const key = JSON.stringify(queryKey);
  let state = clientStates.get(key);
  if (!state) {
    state = { hintedHighWater: 0n, inFlight: null };
    clientStates.set(key, state);
  }
  return state;
}

async function snapshot(
  queryClient: QueryClient,
  queryKey: QueryKey,
  projectId: string,
  scope: CatalogScope,
): Promise<CatalogCacheView> {
  const view = catalogViewFromSnapshot(await getContextCatalogSnapshot(projectId, scope));
  queryClient.setQueryData(queryKey, view);
  return view;
}

async function drain(
  queryClient: QueryClient,
  queryKey: QueryKey,
  projectId: string,
  scope: CatalogScope,
  state: State,
): Promise<CatalogCacheView> {
  let view = queryClient.getQueryData<CatalogCacheView>(queryKey);
  if (!view?.generation) view = await snapshot(queryClient, queryKey, projectId, scope);

  // A response page is the installation unit. Continue from only its newly
  // installed cursor, never from the cursor that another trigger observed.
  for (let page = 0; page < 100; page += 1) {
    const before = view.appliedRevision;
    const changes = await getContextCatalogChanges(projectId, scope, view.cursor);
    if (changes.kind === "reset-required") {
      view = await snapshot(queryClient, queryKey, projectId, scope);
    } else {
      const applied = applyCatalogChanges(view, changes);
      if (!applied) {
        view = await snapshot(queryClient, queryKey, projectId, scope);
      } else {
        view = applied;
        queryClient.setQueryData(queryKey, view);
      }
      if (changes.hasMore) continue;
    }
    if (BigInt(view.appliedRevision) >= state.hintedHighWater) return view;
    // A high-water observed while this request was blocked gets one follow-up
    // from the advanced cursor. If the server still has not published it, a
    // later focus/poll/reconnect trigger retries without spinning.
    if (view.appliedRevision === before) return view;
  }
  return view;
}

export function acquireContextCatalog(
  queryClient: QueryClient,
  queryKey: QueryKey,
  projectId: string,
  scope: CatalogScope,
): Promise<CatalogCacheView> {
  const state = stateFor(queryClient, queryKey);
  if (state.inFlight) return state.inFlight;
  const inFlight = drain(queryClient, queryKey, projectId, scope, state).finally(() => {
    if (state.inFlight === inFlight) state.inFlight = null;
  });
  state.inFlight = inFlight;
  return inFlight;
}

export function hintContextCatalog(
  queryClient: QueryClient,
  queryKey: QueryKey,
  projectId: string,
  scope: CatalogScope,
  headRevision: string,
): Promise<CatalogCacheView> {
  const state = stateFor(queryClient, queryKey);
  let head: bigint;
  try {
    head = BigInt(headRevision);
  } catch {
    return acquireContextCatalog(queryClient, queryKey, projectId, scope);
  }
  if (head > state.hintedHighWater) state.hintedHighWater = head;
  const view = queryClient.getQueryData<CatalogCacheView>(queryKey);
  if (view && BigInt(view.appliedRevision) >= head) return Promise.resolve(view);
  return acquireContextCatalog(queryClient, queryKey, projectId, scope);
}
