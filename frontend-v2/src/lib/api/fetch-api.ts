import { getAccessTokenSync } from "@/lib/auth-token"
import { convertKeysToCamelCase } from "@/lib/case-convert"

/**
 * API base URL. Set via VITE_API_URL env var, or defaults to
 * localhost:8130 (the dev server port for the meridian-collab worktree).
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:8130"

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  const headers = new Headers(options?.headers as HeadersInit | undefined)

  if (
    options?.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json")
  }

  const token = getAccessTokenSync()
  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    signal: options?.signal,
    headers,
  })

  if (!response.ok) {
    let message = response.statusText
    try {
      const errorBody = await response.json()
      message =
        errorBody.detail ??
        errorBody.title ??
        errorBody.message ??
        errorBody.error ??
        message
    } catch {
      // keep statusText
    }
    throw new ApiError(message, response.status)
  }

  const contentLength = response.headers.get("content-length")
  if (response.status === 204 || contentLength === "0") {
    return undefined as T
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (
    contentType.includes("application/json") ||
    contentType.includes("application/problem+json")
  ) {
    const raw = await response.text()
    const parsed = JSON.parse(raw) as unknown
    return convertKeysToCamelCase(parsed) as T
  }

  const bodyText = await response.text().catch(() => "")
  throw new ApiError(
    `Expected JSON from ${endpoint}, got "${contentType || "unknown"}"${bodyText ? `: ${bodyText.slice(0, 120)}` : ""}`,
    response.status,
  )
}
