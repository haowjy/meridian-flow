'use client'

import { ErrorPanel } from '@/shared/components/ErrorPanel'

// Global fallback for errors thrown during root layout/rendering
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body>
        <div className="container mx-auto max-w-3xl p-8">
          <ErrorPanel
            title="App failed to render"
            message={error?.message || 'Unexpected error'}
            onRetry={reset}
          />
        </div>
      </body>
    </html>
  )
}

