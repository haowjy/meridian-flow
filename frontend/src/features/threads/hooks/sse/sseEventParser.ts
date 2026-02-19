/**
 * SSE Event Parser
 *
 * Gateway layer for SSE events, equivalent to fetchAPI for REST.
 * All SSE events flow through this parser to ensure consistent data shape.
 *
 * Responsibilities:
 * - Parse JSON string to object
 * - Convert snake_case -> camelCase (backend sends snake_case)
 * - Return typed object ready for handlers
 */

import { convertKeysToCamelCase } from "@/core/lib/caseConvert";

/**
 * Parse and convert SSE event data.
 *
 * @param data - Raw JSON string from SSE event
 * @returns Parsed and camelCase-converted object
 * @throws SyntaxError if JSON parsing fails
 */
export function parseSSEEvent<T>(data: string): T {
  const parsed = JSON.parse(data);
  return convertKeysToCamelCase(parsed) as T;
}
