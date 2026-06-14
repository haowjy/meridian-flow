import { describe, expect, it, vi } from "vitest";

import { unwrapListQuery } from "./list-query";

describe("unwrapListQuery", () => {
  it("keeps loading as the null sentinel", () => {
    const result = unwrapListQuery({
      data: undefined,
      isPending: true,
      isFetching: true,
      isError: false,
      refetch: vi.fn(),
    });

    expect(result.data).toBeNull();
    expect(result.status).toBe("loading");
  });

  it("does not encode errors as the loading sentinel", () => {
    const result = unwrapListQuery({
      data: undefined,
      isPending: false,
      isFetching: false,
      isError: true,
      refetch: vi.fn(),
    });

    expect(result.data).toEqual([]);
    expect(result.status).toBe("error");
    expect(result.isError).toBe(true);
  });
});
