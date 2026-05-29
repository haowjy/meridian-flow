/**
 * snake_case → camelCase for API JSON responses.
 * Applied once in fetchAPI so the rest of the app uses camelCase.
 */

export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

export function convertKeysToCamelCase<T>(value: T): T {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    return value.map((item) => convertKeysToCamelCase(item)) as T
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[snakeToCamel(key)] = convertKeysToCamelCase(nested)
    }
    return result as T
  }

  return value
}
