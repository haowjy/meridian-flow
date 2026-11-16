/**
 * One Apply over several items, sent as one command (`ApplyItemsClick`). Every member, a
 * document or a folder, is a click in its own item's queue, which owns its pending, refused and
 * unknown-delivery states and retries it with the same id. A document's click waits behind that
 * document's earlier clicks, so its text cut is cut against what they left; the command goes
 * once every member has reached its queue's head and handed over its click. A member that ends
 * without sending (its draft closed, its room never read) is left out. Every member's queue gets
 * the one answer, and the command's answer is the first a sent member settles on: the post's, a
 * Retry's, or a lookup's after its draft closed.
 */
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyItemsClick,
  TreeSaw,
} from "@meridian/contracts/branches";
import type { ApplyClickOutcome } from "./apply-click-queue";

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
  private answered: ApplyClickAnswer | null = null;
  private settle!: (answer: ApplyClickAnswer | null) => void;
  /** The command's final answer; null when every member ended without sending. */
  readonly answer = new Promise<ApplyClickAnswer | null>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly commandId: string,
    private readonly input: {
      /** What the tree lists held at the press; every send carries it. */
      saw: TreeSaw | undefined;
      post(body: ApplyItemsClick): Promise<ApplyClickAnswer>;
    },
  ) {}

  /**
   * One member's place in the command: the send its queued click uses, and its way out.
   */
  member(
    node: string,
    folder = false,
  ): {
    send(body: ApplyClick): Promise<ApplyClickAnswer>;
    drop(): void;
    answered(answer: ApplyClickOutcome): void;
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
      answered: (answer) => {
        // Only a sent click's answer came from the server: an unsent one ends cancelled.
        if (!this.handed.has(index)) return;
        if (
          answer.status !== "landed" &&
          answer.status !== "cancelled" &&
          answer.status !== "unsent"
        )
          this.heard(answer);
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

  private heard(answer: ApplyClickAnswer) {
    this.answered ??= answer;
    this.settle(this.answered);
  }

  /** One request at a time; a member's queue retries a failed delivery, with the same id. */
  private post(): Promise<ApplyClickAnswer> {
    this.request ??= this.input
      .post({
        commandId: this.commandId,
        // Folders first: what a document lands in comes before it.
        items: [...this.handed.values()]
          .sort((a, b) => Number(b.folder) - Number(a.folder))
          .map(({ node, folder, body }) =>
            folder ? { node, tree: true as const } : itemOf(node, body),
          ),
        ...(this.input.saw ? { saw: this.input.saw } : {}),
      })
      .then(
        (answer) => {
          this.heard(answer);
          this.request = null;
          return answer;
        },
        (cause: unknown) => {
          this.request = null;
          throw cause;
        },
      );
    return this.request;
  }
}

function itemOf(documentId: string, body: ApplyClick): Item {
  return {
    node: documentId,
    ...(body.tree ? { tree: true as const } : {}),
    ...(body.draftId && body.whole
      ? { text: { draftId: body.draftId, whole: true as const } }
      : body.draftId && body.snapshot
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
