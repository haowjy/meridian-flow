/**
 * One Apply over several items, sent as one command (`ApplyItemsClick`). Each document's click
 * still waits in its own queue behind that document's earlier clicks, so its text cut is cut
 * against what they left; the command goes once every member has reached its queue's head and
 * handed over its click. A member that ends without sending (its draft closed, its room never
 * read) is left out. Every member's queue gets the one answer.
 */
import type { ApplyClick, ApplyClickAnswer, ApplyItemsClick } from "@meridian/contracts/branches";

type Item = ApplyItemsClick["items"][number];

export class GroupApply {
  private readonly handed = new Map<number, Item>();
  private readonly dropped = new Set<number>();
  private members = 0;
  private ready!: () => void;
  private readonly allHanded = new Promise<void>((resolve) => {
    this.ready = resolve;
  });
  private request: Promise<ApplyClickAnswer> | null = null;
  private nodes: Promise<readonly Item[]> | null = null;
  private answered: ApplyClickAnswer | null = null;
  private settle!: (answer: ApplyClickAnswer | null) => void;
  /** The command's final answer; null when nothing was left to send. */
  readonly answer = new Promise<ApplyClickAnswer | null>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly commandId: string,
    private readonly input: {
      /** Nodes with no queue of their own: folders, each with its tree cut, read once. */
      nodes: () => Promise<readonly Item[]>;
      /** Whether any such node was asked for: a command of none and no member sends nothing. */
      hasNodes: boolean;
      restore: boolean;
      post(body: ApplyItemsClick): Promise<ApplyClickAnswer>;
    },
  ) {}

  /** One document's place in the command: the send its queued click uses, and its way out. */
  member(documentId: string): {
    send(body: ApplyClick): Promise<ApplyClickAnswer>;
    drop(): void;
  } {
    const index = this.members++;
    return {
      send: async (body) => {
        this.handed.set(index, itemOf(documentId, body));
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

  /** Called once every member is made: a command of folders alone goes now. */
  sealed(): void {
    this.check();
  }

  private check() {
    if (this.handed.size + this.dropped.size < this.members) return;
    this.ready();
    if (this.handed.size === 0) {
      if (this.input.hasNodes) void this.postAlone();
      else this.settle(null);
    }
  }

  /** With no queue to retry it, a command of folders alone retries here. */
  private async postAlone() {
    for (const delay of [0, 1000, 2000, 4000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      // An unknown delivery is sent again with the same id; the server answers it once.
      const delivered = await this.post().then(
        () => true,
        () => false,
      );
      if (delivered) return;
    }
    this.settle(null);
  }

  /** One request at a time; a member's queue retries a failed delivery, with the same id. */
  private post(): Promise<ApplyClickAnswer> {
    this.nodes ??= this.input.nodes();
    this.request ??= this.nodes
      .then((nodes) =>
        this.input.post({
          commandId: this.commandId,
          items: [...nodes, ...this.handed.values()],
          ...(this.input.restore ? { restore: true as const } : {}),
        }),
      )
      .then(
        (answer) => {
          if (answer.status !== "conflict") {
            this.answered = answer;
            this.settle(answer);
          }
          this.request = null;
          return answer;
        },
        (cause: unknown) => {
          this.request = null;
          this.nodes = null;
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
