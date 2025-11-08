'use client'

import { useEffect } from 'react'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { makeLogger } from '@/core/lib/logger'

const log = makeLogger('app-error')

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log for diagnostics; Next.js overlay handles dev visibility
    log.error('Route error', error?.message, error?.stack, error?.digest)
  }, [error])

  return (
    <div className="container mx-auto max-w-3xl p-8">
      <ErrorPanel
        title="Something went wrong"
        message={error?.message || 'Unexpected error'}
        onRetry={reset}
      />
    </div>
  )
}

