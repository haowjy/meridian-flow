/**
 * The `@meridian/thread-client/view` subpath: the part of the view model the server shares. The server
 * imports only this, for the decisions that must match what the writer sees.
 */
export { replyDrawsNothing } from "./reply-draws-nothing";
export { deliveriesUnder, isRowTurn } from "./transcript-model";
