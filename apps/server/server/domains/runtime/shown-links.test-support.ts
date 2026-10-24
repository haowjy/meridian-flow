/** Shared behavioral contract for shown-link stores. */

import type { Thread, Turn } from "@meridian/contracts/threads";
import type { SpelledLinkFact } from "@meridian/markup/links";
import type { ShownLinkStore } from "./ports/shown-links.js";

export const shownLink = (n: number, address = `kb://target-${n}.md`): SpelledLinkFact => ({
  ref: `doc:0000000${n}-0000-4000-8000-000000000000`,
  address,
});

export type ShownLinksRig = {
  childId: string;
  store: ShownLinkStore;
  answer: Turn;
  source: Thread;
  documentId: string;
  show(threadId: string, turn: Turn, links: SpelledLinkFact[]): Promise<void>;
  seen(threadId: string): Promise<string[]>;
  derive(originType: "fork" | "handoff", origin: Turn, from?: Thread): Promise<Thread>;
  next(thread: Thread, prev: Turn): Promise<Turn>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
};

export type ShownLinksCheck = (
  actual: unknown,
  what: string,
) => ReturnType<typeof import("vitest").expect.soft>;

const ordered = async ({ store, documentId }: ShownLinksRig, threadId: string) =>
  (await store.forDocument(threadId, documentId)).map((row) => row.ref);

export const shownLinkStoreChecks: ReadonlyArray<{
  name: string;
  run(rig: ShownLinksRig, check: ShownLinksCheck): Promise<void>;
}> = [
  {
    name: "dedup keeps the latest showing per key",
    async run({ store, answer, source, show, next, documentId }, check) {
      await show(source.id, answer, [shownLink(1), shownLink(1)]);
      await show(source.id, answer, [shownLink(1, "kb://moved.md")]);
      const later = await next(source, answer);
      await show(source.id, later, [shownLink(1)]);
      const rows = await store.forDocument(source.id, documentId);
      check(
        rows.map((row) => [row.address, row.view]),
        "one row per key, latest last",
      ).toEqual([
        ["kb://moved.md", "live"],
        ["kb://target-1.md", "live"],
      ]);
    },
  },
  {
    name: "a fork sees source showings up to its cutoff; handoffs and children inherit none",
    async run({ childId, answer, source, show, seen, derive, next }, check) {
      await show(source.id, answer, [shownLink(1)]);
      const later = await next(source, answer);
      await show(source.id, later, [shownLink(2)]);
      const fork = await derive("fork", answer);
      const forkTurn = await next(fork, answer);
      await show(fork.id, forkTurn, [shownLink(3)]);
      const nested = await derive("fork", forkTurn, fork);
      const handoff = await derive("handoff", later);
      check(await seen(source.id), "source").toEqual([
        "00000001@kb://target-1.md",
        "00000002@kb://target-2.md",
      ]);
      check(await seen(fork.id), "fork").toEqual([
        "00000001@kb://target-1.md",
        "00000003@kb://target-3.md",
      ]);
      check(await seen(nested.id), "nested fork").toEqual([
        "00000001@kb://target-1.md",
        "00000003@kb://target-3.md",
      ]);
      check(await seen(handoff.id), "handoff").toEqual([]);
      check(await seen(childId), "spawned child").toEqual([]);
    },
  },
  {
    name: "a source's repeat after the cutoff keeps the fork's showing against a competing ref",
    async run(rig, check) {
      const { answer, source, show, derive, next } = rig;
      const competing = shownLink(4, "kb://same.md");
      const shownLast = shownLink(5, "kb://same.md");
      await show(source.id, answer, [competing, shownLast]);
      const fork = await derive("fork", answer);
      const nested = await derive("fork", await next(fork, answer), fork);
      await show(source.id, await next(source, answer), [shownLast]);
      for (const [threadId, what] of [
        [source.id, "source"],
        [fork.id, "fork"],
        [nested.id, "nested fork"],
      ] as const) {
        check(await ordered(rig, threadId), what).toEqual([competing.ref, shownLast.ref]);
      }
    },
  },
  {
    name: "a showing recorded in a failed persistence rolls back with it",
    async run({ answer, source, show, seen, transaction }, check) {
      await show(source.id, answer, [shownLink(7)]);
      const failed = await transaction(async () => {
        await show(source.id, answer, [shownLink(8)]);
        throw new Error("result persistence failed");
      }).catch((error: Error) => error.message);
      check(failed, "the persistence failed").toBe("result persistence failed");
      check(await seen(source.id), "only the committed showing").toEqual([
        "00000007@kb://target-7.md",
      ]);
    },
  },
  {
    name: "an address past the index tuple limit records exactly and dedups per turn",
    async run({ store, answer, source, show, documentId }, check) {
      let seed = 730;
      const segment = () =>
        Array.from({ length: 90 }, () => {
          seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
          return "abcdefghijklmnopqrstuvwxyz0123456789"[seed % 36];
        }).join("");
      const long = shownLink(9, `kb://${Array.from({ length: 36 }, segment).join("/")}.md`);
      await show(source.id, answer, [long]);
      await show(source.id, answer, [long]);
      check(
        (await store.forDocument(source.id, documentId)).map((row) => row.address),
        "one exact row",
      ).toEqual([long.address]);
    },
  },
];
