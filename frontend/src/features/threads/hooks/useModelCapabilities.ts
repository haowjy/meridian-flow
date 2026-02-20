import { useEffect, useState } from "react";
import { api, type ModelCapabilitiesProvider } from "@/core/lib/api";
import {
  getErrorMessageWithFallback,
  isAbortError,
} from "@/core/lib/errors";

interface UseModelCapabilitiesResult {
  providers: ModelCapabilitiesProvider[];
  isLoading: boolean;
  error: string | null;
}

export function useModelCapabilities(): UseModelCapabilitiesResult {
  const [providers, setProviders] = useState<ModelCapabilitiesProvider[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.models.getCapabilities({
          signal: controller.signal,
        });
        setProviders(data ?? []);
        setIsLoading(false);
      } catch (err) {
        // Silent abort — component unmounted or effect re-fired
        if (isAbortError(err)) return;
        setIsLoading(false);
        const message = getErrorMessageWithFallback(
          err,
          "Failed to load model capabilities",
        );
        setError(message);
      }
    };

    load();

    return () => {
      controller.abort();
    };
  }, []);

  return { providers, isLoading, error };
}
