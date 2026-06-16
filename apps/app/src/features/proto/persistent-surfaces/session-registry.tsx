/**
 * Lifted session registry — owns proof-of-life state for chat + document
 * surfaces. Destinations bind to entries; they never create or destroy sessions.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import type { SessionId, SessionRecord } from "./types";

const TICK_MS = 250;

type SessionRegistryValue = {
  sessions: Record<SessionId, SessionRecord>;
  setScrollTop: (id: SessionId, scrollTop: number) => void;
  setText: (text: string) => void;
};

const SessionRegistryContext = createContext<SessionRegistryValue | null>(null);

const INITIAL: Record<SessionId, SessionRecord> = {
  chat: { ticker: 0, scrollTop: 0, text: "" },
  document: { ticker: 0, scrollTop: 0, text: "" },
};

export function SessionRegistryProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState(INITIAL);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSessions((prev) => ({
        chat: { ...prev.chat, ticker: prev.chat.ticker + 1 },
        document: { ...prev.document, ticker: prev.document.ticker + 1 },
      }));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const value = useMemo<SessionRegistryValue>(
    () => ({
      sessions,
      setScrollTop: (id, scrollTop) => {
        setSessions((prev) => ({
          ...prev,
          [id]: { ...prev[id], scrollTop },
        }));
      },
      setText: (text) => {
        setSessions((prev) => ({
          ...prev,
          document: { ...prev.document, text },
        }));
      },
    }),
    [sessions],
  );

  return (
    <SessionRegistryContext.Provider value={value}>{children}</SessionRegistryContext.Provider>
  );
}

export function useSessionRegistry() {
  const ctx = useContext(SessionRegistryContext);
  if (!ctx) {
    throw new Error("useSessionRegistry must be used within SessionRegistryProvider");
  }
  return ctx;
}
