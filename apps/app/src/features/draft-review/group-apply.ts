/**
 * One Apply over several items, sent as one command (`ApplyItemsClick`). Every member, a
 * document or a folder, is a click in its own item's queue, which owns its pending, refused and
 * unknown-delivery states and retries it with the same id. A document's click waits behind that
 * document's earlier clicks, so its text cut is cut against what they left; the command goes
 * once every member has reached its queue's head and handed over its click. A member that ends
 * without sending (its draft closed, its room never read) is left out. Every member's queue gets
 * the one answer.
 */
import type { ApplyClick, ApplyClickAnswer, ApplyItemsClick } from "@meridian/contracts/branches";

type Item = ApplyItemsClick["items"][number];

export class GroupApply {
  private readonly handed = new Map<number, { node: string; folder: boolean; body: ApplyClick }>();
  private readonly dropped = new Set<number>();
  private members = 0;
  private sealedAll = false;
  private ready!: () => void;
  private readonly allHanded = new Promise<void>((resolve) => {
    this.ready = resolve;
  });
  private request: Promise<ApplyClickAnswer> | null = null;
  private revisions: Promise<ReadonlyMap<string, string>> | null = null;
  private answered: ApplyClickAnswer | null = null;
  private settle!: (answer: ApplyClickAnswer | null) => void;
  /** The command's final answer; null when every member ended without sending. */
  readonly answer = new Promise<ApplyClickAnswer | null>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly commandId: string,
    private readonly input: {
      /**
       * The folders' tree cuts: each one's revision of the Work's row. Read once, when the
       * command first goes, so a resend carries the same body.
       */
      revisions: () => Promise<ReadonlyMap<string, string>>;
      restore: boolean;
      post(body: ApplyItemsClick): Promise<ApplyClickAnswer>;
    },
  ) {}

  /**
   * One member's place in the command: the send its queued click uses, and its way out. A
   * folder's tree cut is its revision, read when the command goes.
   */
  member(
    node: string,
    folder = false,
  ): {
    send(body: ApplyClick): Promise<ApplyClickAnswer>;
    drop(): void;
  } {
    const index = this.members++;
    return {
      send: async (body) => {
        this.handed.set(index, { node, folder, body });
        this.check();
        await this.allHanded;
        return this.answered ?? this.post();
      },
      drop: () => {
        if (this.handed.has(index) || this.dropped.has(index)) return;
        this.dropped.add(index);
        this.check();
      },
    };
  }

  /** Called once every member is made: until then a member that drops decides nothing. */
  sealed(): void {
    this.sealedAll = true;
    this.check();
  }

  private check() {
    if (!this.sealedAll || this.handed.size + this.dropped.size < this.members) return;
    this.ready();
    if (this.handed.size === 0) this.settle(null);
  }

  /** One request at a time; a member's queue retries a failed delivery, with the same id. */
  private post(): Promise<ApplyClickAnswer> {
    this.revisions ??= this.input.revisions();
    this.request ??= this.revisions
      .then((revisions) =>
        this.input.post({
          commandId: this.commandId,
          items: [...this.handed.values()].map(({ node, folder, body }) =>
            folder ? { node, tree: { revision: revisions.get(node) ?? null } } : itemOf(node, body),
          ),
          ...(this.input.restore ? { restore: true as const } : {}),
        }),
      )
      .then(
        (answer) => {
          this.answered = answer;
          this.settle(answer);
          this.request = null;
          return answer;
        },
        (cause: unknown) => {
          this.request = null;
          // A read that failed is read again; one that answered stays the command's cut.
          void this.revisions?.catch(() => {
            this.revisions = null;
          });
          throw cause;
        },
      );
    return this.request;
  }
}

function itemOf(documentId: string, body: ApplyClick): Item {
  return {
    node: documentId,
    ...(body.tree ? { tree: body.tree } : {}),
    ...(body.draftId && body.snapshot
      ? {
          text: {
            draftId: body.draftId,
            snapshot: body.snapshot,
            baseViewDelta: body.baseViewDelta,
            groupIds: body.groupIds,
          },
        }
      : {}),
  };
}
