import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (!url || !key) {
    console.warn('Supabase keys are missing. Using dummy values for build.')
    return createBrowserClient('https://example.com', 'example-key')
  }

  return createBrowserClient(url, key)
}
