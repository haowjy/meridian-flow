import { createContext, useContext, useEffect, useMemo } from "react"

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
  const pool = useMemo(
    () => new SessionPool(config),
    [
      config.idleMs,
      config.warmBudget,
      config.user.userId,
      config.user.userName,
      config.wsFactory,
      config.getAccessToken,
    ],
  )

  useEffect(() => {
    return () => {
      void pool.destroy()
    }
  }, [pool])

  return (
    <SessionPoolContext.Provider value={pool}>
      {children}
    </SessionPoolContext.Provider>
  )
}

export function useSessionPool(): SessionPool {
  const pool = useContext(SessionPoolContext)
  if (!pool) {
    throw new Error("useSessionPool must be used within a SessionPoolProvider")
  }
  return pool
}
