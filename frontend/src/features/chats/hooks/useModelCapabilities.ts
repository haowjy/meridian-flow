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
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    setIsLoading(true)
    setError(null)

    api.models
      .getCapabilities()
      .then((data) => {
        if (!isMounted) return
        setProviders(data ?? [])
        setIsLoading(false)
      })
      .catch((err) => {
        if (!isMounted) return
        setIsLoading(false)
        const message =
          err instanceof Error ? err.message : 'Failed to load model capabilities'
        setError(message)
        handleApiError(err, 'Failed to load model capabilities')
      })

    return () => {
      isMounted = false
    }
  }, [])

  return { providers, isLoading, error }
}

