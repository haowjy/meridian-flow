import { createClient as createSupabaseClient } from '@supabase/supabase-js'

let client: ReturnType<typeof createSupabaseClient> | null = null

export function createClient() {
  if (client) return client

  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

  if (!url || !key) {
    // Dev/build safety: allow missing envs in non-production
    if (import.meta.env.MODE === 'production') {
      throw new Error('Supabase keys are missing in production environment')
    }
    console.warn('Supabase keys are missing. Using dummy values for non-production build.')
    return createSupabaseClient('https://example.com', 'example-key')
  }

  client = createSupabaseClient(url, key)
  return client
}
