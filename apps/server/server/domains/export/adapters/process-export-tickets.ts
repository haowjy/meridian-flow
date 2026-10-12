/** Process-local, one-shot download tickets. Restart/expiry requires preparing a new export. */
import { randomUUID } from "node:crypto";
import type { ExportTicket, ExportTickets } from "../ports/export-tickets.js";

const TTL_MS = 10 * 60 * 1000;
export function createProcessExportTickets(): ExportTickets {
  const tickets = new Map<
    string,
    { ticket: ExportTicket; expires: number; timer: ReturnType<typeof setTimeout> }
  >();
  return {
    issue(ticket) {
      const id = randomUUID();
      const timer = setTimeout(() => tickets.delete(id), TTL_MS);
      timer.unref();
      tickets.set(id, { ticket, expires: Date.now() + TTL_MS, timer });
      return id;
    },
    take(id, projectId, accountId) {
      const entry = tickets.get(id);
      if (!entry || entry.ticket.projectId !== projectId || entry.ticket.accountId !== accountId)
        return null;
      tickets.delete(id);
      clearTimeout(entry.timer);
      return entry.expires > Date.now() ? entry.ticket : null;
    },
  };
}
