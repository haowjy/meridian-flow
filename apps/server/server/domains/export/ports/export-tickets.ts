/** Short-lived, owner-bound handoff of a frozen export inventory to its download. */
import type { Readable } from "node:stream";
export type ExportTicket = {
  projectId: string;
  accountId: string;
  fileName: string;
  stream(): Readable;
};
export interface ExportTickets {
  issue(ticket: ExportTicket): string;
  take(id: string, projectId: string, accountId: string): ExportTicket | null;
}
