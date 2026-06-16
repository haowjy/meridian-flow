import type { UseQueryResult } from "@tanstack/react-query";

/**
 * Normalized view of a list-returning query. `data` is `null` while loading
 * (not yet resolved) and `[]` once loaded empty — distinguishing "no data yet"
 * from "loaded, nothing there".
 *
 * `status` is the single source of truth for UI state. `"disabled"` is set
 * by callers when the query is gated off (no thread selected, pending
 * optimistic creation, caller-supplied `enabled: false`); the unwrap helper
 * itself never produces `"disabled"` since it can't tell why the underlying
 * query is idle.
 */
export type ListQueryStatus<T> = {
  data: T[] | null;
  status: "loading" | "empty" | "ready" | "error" | "disabled";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

type UnwrappableQuery<T> = Pick<
  UseQueryResult<T[]>,
  "data" | "isPending" | "isFetching" | "isError" | "refetch"
>;

/**
 * Collapse a React Query result for a list endpoint into {@link ListQueryStatus}:
 * resolve `data` to `null` while loading and `[]` once loaded empty/error, and
 * wrap `refetch` to discard its promise. Shared by the list hooks so loading
 * semantics stay identical across them.
 */
export function unwrapListQuery<T>(result: UnwrappableQuery<T>): ListQueryStatus<T> {
  const { data, isPending, isFetching, isError, refetch } = result;
  const normalizedData =
    data !== undefined ? data : isError ? [] : isPending || isFetching ? null : [];
  return {
    data: normalizedData,
    status: isError
      ? "error"
      : normalizedData === null
        ? "loading"
        : normalizedData.length === 0
          ? "empty"
          : "ready",
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
