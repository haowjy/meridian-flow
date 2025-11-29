type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const ENV_LEVEL = (import.meta.env.VITE_LOG_LEVEL || '').toLowerCase() as LogLevel
const NODE_ENV = import.meta.env.MODE || 'development'

function levelOrder(level: LogLevel): number {
  switch (level) {
    case 'debug':
      return 10
    case 'info':
      return 20
    case 'warn':
      return 30
    case 'error':
      return 40
    case 'silent':
      return 50
    default:
      return 20
  }
}

// Default: debug in development, info otherwise
const DEFAULT_LEVEL: LogLevel = NODE_ENV === 'development' ? 'debug' : 'info'
const ACTIVE_LEVEL: LogLevel = (ENV_LEVEL && ['debug','info','warn','error','silent'].includes(ENV_LEVEL))
  ? ENV_LEVEL
  : DEFAULT_LEVEL

function shouldLog(level: LogLevel): boolean {
  return levelOrder(level) >= levelOrder(ACTIVE_LEVEL) && ACTIVE_LEVEL !== 'silent'
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function makeLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`
  return {
    debug: (...args: unknown[]) => {
      if (shouldLog('debug')) console.debug(prefix, ...args)
    },
    info: (...args: unknown[]) => {
      if (shouldLog('info')) console.info(prefix, ...args)
    },
    warn: (...args: unknown[]) => {
      if (shouldLog('warn')) console.warn(prefix, ...args)
    },
    error: (...args: unknown[]) => {
      if (shouldLog('error')) console.error(prefix, ...args)
    },
  }
}

export const logger = makeLogger('core')
