/**
 * Types for the persistent-surfaces prototype — lifted chat + document sessions
 * that survive destination switches without remounting.
 */

export type Destination = "home" | "chat" | "context";

/** Where the lifted chat surface is anchored in the shell grid. */
export type ChatPlacement = "dock" | "center";

export type SessionId = "chat" | "document";

export type SessionRecord = {
  ticker: number;
  scrollTop: number;
  /** Document session only — chat uses scroll for transcript proof-of-life. */
  text: string;
};
