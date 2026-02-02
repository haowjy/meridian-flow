/**
 * Case Conversion Utilities
 *
 * Provides automatic snake_case → camelCase conversion for API responses.
 * This is the single gateway for case normalization, applied in fetchAPI.
 *
 * Why: Backend (Go) uses snake_case, frontend (TypeScript) uses camelCase.
 * Converting at the API gateway ensures consistent data shape throughout the app.
 */

/**
 * Converts a snake_case string to camelCase.
 * Examples: "tool_use_id" → "toolUseId", "is_error" → "isError"
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Recursively converts all object keys from snake_case to camelCase.
 * Handles nested objects and arrays. Primitives pass through unchanged.
 *
 * Performance: ~1-2ms for typical API responses. Negligible compared to network latency.
 */
export function convertKeysToCamelCase<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj

  if (Array.isArray(obj)) {
    return obj.map(convertKeysToCamelCase) as T
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = snakeToCamel(key)
      result[camelKey] = convertKeysToCamelCase(value)
    }
    return result as T
  }

  return obj
}
