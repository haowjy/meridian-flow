/** Creation's control producer joins the caller transaction and wakes only after commit. */
export interface HandoffControlQueue {
  enqueueSeedBrief(input: {
    threadId: string;
    seedTurnId: string;
    controlId: string;
  }): Promise<void>;
}
