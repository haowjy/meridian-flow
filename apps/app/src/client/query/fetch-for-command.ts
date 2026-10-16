/**
 * A command's read of a query, independent of any component's observer. A query's fetch is cancelled when
 * its last observer unmounts, and a fetch is shared: a command that awaits `fetchQuery` while a row's
 * observer holds the fetch dies with `CancelledError` the moment that row unmounts (the Discard that
 * replaces a collapsed row unmounts it mid-command). Here the command's own fetch never reads the abort
 * signal, so observer churn cannot cancel it, and a fetch it joined that was cancelled is simply asked again.
 */
import {
  isCancelledError,
  onlineManager,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
} from "@tanstack/react-query";

type Options<T> = {
  queryKey: QueryKey;
  queryFn: (context: QueryFunctionContext) => Promise<T>;
  staleTime?: number;
};

const NEVER_ABORTED = new AbortController().signal;
const ATTEMPTS = 3;

export async function fetchForCommand<T>(
  queryClient: QueryClient,
  options: Options<T>,
): Promise<T> {
  const detached: Options<T> = {
    ...options,
    // Built without reading `context.signal`: touching it marks the fetch cancellable by observer removal.
    queryFn: (context) =>
      options.queryFn({
        client: queryClient,
        queryKey: context.queryKey,
        meta: context.meta,
        signal: NEVER_ABORTED,
      }),
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await queryClient.fetchQuery(detached);
    } catch (error) {
      if (!isCancelledError(error) || attempt === ATTEMPTS) throw error;
    }
  }
}

/**
 * A local command's read: the cached value when there is one, else `fetchForCommand`. A Discard is a local
 * edit, so it must not wait for the network (TanStack pauses a fetch while offline); whatever the cache
 * lacks is fetched, and a server command (Apply) keeps reading fresh with `fetchForCommand`.
 */
export function cachedForCommand<T>(queryClient: QueryClient, options: Options<T>): Promise<T> {
  const cached = queryClient.getQueryData<T>(options.queryKey);
  return cached === undefined ? fetchForCommand(queryClient, options) : Promise.resolve(cached);
}

/** Whether a command can reach the server now: the browser and TanStack's online manager both say so. */
export function isOnline(): boolean {
  return navigator.onLine && onlineManager.isOnline();
}
