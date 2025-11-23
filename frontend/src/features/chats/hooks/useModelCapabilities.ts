"use client"

import { useEffect, useState } from 'react'
import { api, type ModelCapabilitiesProvider } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'

interface UseModelCapabilitiesResult {
  providers: ModelCapabilitiesProvider[]
  isLoading: boolean
  error: string | null
}

export function useModelCapabilities(): UseModelCapabilitiesResult {
  const [providers, setProviders] = useState<ModelCapabilitiesProvider[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    const load = async () => {
      try {
        const data = await api.models.getCapabilities()
        if (!isMounted) return
        setProviders(data ?? [])
        setIsLoading(false)
      } catch (err) {
        if (!isMounted) return
        setIsLoading(false)
        const message =
          err instanceof Error ? err.message : 'Failed to load model capabilities'
        setError(message)
        handleApiError(err, 'Failed to load model capabilities')
      }
    }

    load()

    return () => {
      isMounted = false
    }
  }, [])

  return { providers, isLoading, error }
}
