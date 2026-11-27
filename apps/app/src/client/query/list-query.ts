import type { UseQueryResult } from "@tanstack/react-query";

export type ListQueryStatus<T> = {
  data: T[] | null;
  status: "loading" | "empty" | "ready" | "error" | "disabled";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

type UnwrappableQuery<T> = Pick<
  UseQueryResult<T[]>,
  "data" | "isPending" | "isFetching" | "isError"
> & { refetch: () => unknown };

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
