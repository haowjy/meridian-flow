/**
 * Error handling utilities for consistent error processing.
 */

import { toast } from 'sonner'

/**
 * Application error types for categorizing errors.
 */
export enum ErrorType {
  Network = 'NETWORK_ERROR',
  Validation = 'VALIDATION_ERROR',
  NotFound = 'NOT_FOUND',
  Unauthorized = 'UNAUTHORIZED',
  Conflict = 'CONFLICT',
  ServerError = 'SERVER_ERROR',
  Unknown = 'UNKNOWN_ERROR',
}

/**
 * Field-level validation error (RFC 7807 invalid_params)
 */
export interface FieldError {
  name: string   // Field name
  reason: string // Why it's invalid
}

/**
 * Application error with type and user-friendly message.
 * For conflict errors (409), includes the existing resource.
 * For validation errors (400), includes field-level errors.
 */
export class AppError<TResource = unknown> extends Error {
  constructor(
    public type: ErrorType,
    public message: string,
    public originalError?: Error,
    public resource?: TResource,
    public fieldErrors?: FieldError[]
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * Extract user-friendly error message from various error types.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'An unexpected error occurred'
}

/**
 * Convert HTTP response to AppError based on status code.
 */
export function httpErrorToAppError<TResource = unknown>(
  status: number,
  message?: string,
  resource?: TResource,
  fieldErrors?: FieldError[]
): AppError<TResource> {
  switch (status) {
    case 400:
      return new AppError<TResource>(
        ErrorType.Validation,
        message || 'Invalid request. Please check your input.',
        undefined,
        undefined,
        fieldErrors
      )
    case 401:
      return new AppError<TResource>(
        ErrorType.Unauthorized,
        message || 'You are not authorized to perform this action.'
      )
    case 404:
      return new AppError<TResource>(
        ErrorType.NotFound,
        message || 'The requested resource was not found.'
      )
    case 409:
      return new AppError(
        ErrorType.Conflict,
        message || 'Resource already exists.',
        undefined,
        resource
      )
    case 500:
    case 502:
    case 503:
      return new AppError<TResource>(
        ErrorType.ServerError,
        message || 'Server error. Please try again later.'
      )
    default:
      return new AppError<TResource>(
        ErrorType.Unknown,
        message || 'An unexpected error occurred.'
      )
  }
}

/**
 * Check if error is a network error (no connection).
 */
export function isNetworkError(error: unknown): boolean {
  // Native fetch/network failure
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return true
  }

  if (error instanceof AppError) {
    // Treat ServerError as transient to allow retries on 5xx
    return error.type === ErrorType.Network || error.type === ErrorType.ServerError
  }

  return false
}

/**
 * Narrow an AbortError emitted by fetch/AbortController.
 */
export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Best-effort guard for AppError across dynamic import boundaries.
 */
export function isAppError(error: unknown): error is AppError<unknown> {
  if (!error || typeof error !== 'object') return false

  const candidate = error as { name?: unknown; message?: unknown }
  return candidate.name === 'AppError' && typeof candidate.message === 'string'
}

/**
 * Centralized error handler that shows toast and extracts user-friendly message.
 * Use this in store catch blocks to standardize error UX.
 *
 * @param error - The caught error (AppError, Error, or unknown)
 * @param fallbackMessage - Message to show if error can't be parsed
 *
 * @example
 * try {
 *   await api.chats.create(projectId, title)
 * } catch (error) {
 *   handleApiError(error, 'Failed to create chat')
 *   throw error
 * }
 */
export function handleApiError(error: unknown, fallbackMessage: string): void {
  const message = getErrorMessage(error) || fallbackMessage
  toast.error(message)
}
