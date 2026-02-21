import { describe, it, expect, vi } from "vitest";
import {
  ReconcileNewestPolicy,
  type ICacheRepo,
  type IRemoteRepo,
} from "@/core/lib/cache";
import { AppError, ErrorType } from "@/core/lib/errors";

type Item = { id: string; updatedAt: Date };

describe("Cache policies", () => {
  it("ReconcileNewestPolicy emits cache immediately and prefers newer server", async () => {
    const cached: Item = {
      id: "a",
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    };
    const server: Item = {
      id: "a",
      updatedAt: new Date("2025-02-01T00:00:00Z"),
    };

    const cacheRepo: ICacheRepo<Item> = {
      get: async () => cached,
      put: async () => void 0,
    };
    const remoteRepo: IRemoteRepo<Item> = {
      fetch: async () => server,
    };

    const onIntermediate = vi.fn();
    const result = await new ReconcileNewestPolicy<Item>().run({
      cacheRepo,
      remoteRepo,
      onIntermediate,
    });

    expect(onIntermediate).toHaveBeenCalledWith({
      data: cached,
      source: "cache",
      isFinal: false,
    });
    expect(result.data).toEqual(server);
    expect(result.source).toBe("server");
    expect(result.isFinal).toBe(true);
  });

  it("ReconcileNewestPolicy keeps cache on tie (local wins)", async () => {
    const when = new Date("2025-02-01T00:00:00Z");
    const cached: Item = { id: "a", updatedAt: when };
    const server: Item = { id: "a", updatedAt: when };

    const cacheRepo: ICacheRepo<Item> = {
      get: async () => cached,
      put: async () => void 0,
    };
    const remoteRepo: IRemoteRepo<Item> = {
      fetch: async () => server,
    };

    const result = await new ReconcileNewestPolicy<Item>().run({
      cacheRepo,
      remoteRepo,
    });
    expect(result.data).toEqual(cached);
    expect(result.source).toBe("cache");
    expect(result.isFinal).toBe(true);
  });

  it("ReconcileNewestPolicy falls back to cache on AbortError", async () => {
    const cached: Item = {
      id: "a",
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    };
    const cacheRepo: ICacheRepo<Item> = {
      get: async () => cached,
      put: async () => void 0,
    };
    const remoteRepo: IRemoteRepo<Item> = {
      fetch: async () => {
        const err = new Error("aborted") as Error & { name: string };
        err.name = "AbortError";
        throw err;
      },
    };

    const result = await new ReconcileNewestPolicy<Item>().run({
      cacheRepo,
      remoteRepo,
    });
    expect(result.data).toEqual(cached);
    expect(result.source).toBe("cache");
  });

  it("ReconcileNewestPolicy does not fall back to cache on 404", async () => {
    const cached: Item = {
      id: "a",
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    };
    const cacheRepo: ICacheRepo<Item> = {
      get: async () => cached,
      put: async () => void 0,
    };
    const remoteRepo: IRemoteRepo<Item> = {
      fetch: async () => {
        throw new AppError(ErrorType.NotFound, "missing");
      },
    };

    await expect(
      new ReconcileNewestPolicy<Item>().run({
        cacheRepo,
        remoteRepo,
      }),
    ).rejects.toMatchObject({ type: ErrorType.NotFound });
  });

  it("ReconcileNewestPolicy does not fall back to cache on 403", async () => {
    const cached: Item = {
      id: "a",
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    };
    const cacheRepo: ICacheRepo<Item> = {
      get: async () => cached,
      put: async () => void 0,
    };
    const remoteRepo: IRemoteRepo<Item> = {
      fetch: async () => {
        throw new AppError(ErrorType.Forbidden, "forbidden");
      },
    };

    await expect(
      new ReconcileNewestPolicy<Item>().run({
        cacheRepo,
        remoteRepo,
      }),
    ).rejects.toMatchObject({ type: ErrorType.Forbidden });
  });
});
