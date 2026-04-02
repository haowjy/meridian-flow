import { createContext, useContext, useEffect, useMemo } from "react"

import { useDocStreamOptional } from "@/features/docs/DocWsProvider"

import { SessionPool, type SessionPoolConfig } from "./session-pool"

const SessionPoolContext = createContext<SessionPool | null>(null)

export interface SessionPoolProviderProps {
  config: SessionPoolConfig
  children: React.ReactNode
}

export function SessionPoolProvider({
  config,
  children,
}: SessionPoolProviderProps) {
  const pool = useMemo(() => new SessionPool(config), [config])

  useEffect(() => {
    return () => {
      void pool.destroy()
    }
  }, [pool])

  return (
    <SessionPoolContext.Provider value={pool}>
      <DocStreamBridge pool={pool} />
      {children}
    </SessionPoolContext.Provider>
  )
}

/**
 * Bridge DocStreamClient from React context into the imperative SessionPool.
 *
 * Uses the non-throwing useDocStreamOptional() — returns null when no
 * DocWsProvider is present (test/storybook contexts). In production,
 * DocWsProvider is mounted above SessionPoolProvider so this always
 * finds the client.
 */
function DocStreamBridge({ pool }: { pool: SessionPool }) {
  const docStreamClient = useDocStreamOptional()

  useEffect(() => {
    if (docStreamClient) {
      pool.setDocStreamClient(docStreamClient)
    }
  }, [pool, docStreamClient])

  return null
}

export function useSessionPool(): SessionPool {
  const pool = useContext(SessionPoolContext)
  if (!pool) {
    throw new Error("useSessionPool must be used within a SessionPoolProvider")
  }
  return pool
}
