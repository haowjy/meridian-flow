/**
 * Error handling utilities for consistent error processing.
 */

import type { DocumentDto } from "@/types/api";
import { fromDocumentDto } from "@/types/api";
import type { Document } from "@/features/documents/types/document";

/**
 * Application error types for categorizing errors.
 */
export enum ErrorType {
  Network = "NETWORK_ERROR",
  Validation = "VALIDATION_ERROR",
  NotFound = "NOT_FOUND",
  Unauthorized = "UNAUTHORIZED",
  Conflict = "CONFLICT",
  ServerError = "SERVER_ERROR",
  Unknown = "UNKNOWN_ERROR",
}

/**
 * Field-level validation error (RFC 7807 invalid_params)
 */
export interface FieldError {
  name: string; // Field name
  reason: string; // Why it's invalid
}

/**
 * Application error with type and user-friendly message.
 * For conflict errors (409), includes the existing resource.
 * For validation errors (400), includes field-level errors and optional single field hint.
 */
export class AppError<TResource = unknown> extends Error {
  constructor(
    public type: ErrorType,
    public message: string,
    public originalError?: Error,
    public resource?: TResource,
    public fieldErrors?: FieldError[],
    /** Single field that caused the error (from backend ValidationError.Field) */
    public field?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Extract user-friendly error message from various error types.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "An unexpected error occurred";
}

/**
 * Convert HTTP response to AppError based on status code.
 */
export function httpErrorToAppError<TResource = unknown>(
  status: number,
  message?: string,
  resource?: TResource,
  fieldErrors?: FieldError[],
  field?: string,
): AppError<TResource> {
  switch (status) {
    case 400:
      return new AppError<TResource>(
        ErrorType.Validation,
        message || "Invalid request. Please check your input.",
        undefined,
        undefined,
        fieldErrors,
        field,
      );
    case 401:
      return new AppError<TResource>(
        ErrorType.Unauthorized,
        message || "You are not authorized to perform this action.",
      );
    case 404:
      return new AppError<TResource>(
        ErrorType.NotFound,
        message || "The requested resource was not found.",
      );
    case 409:
      return new AppError(
        ErrorType.Conflict,
        message || "Resource already exists.",
        undefined,
        resource,
      );
    case 500:
    case 502:
    case 503:
      return new AppError<TResource>(
        ErrorType.ServerError,
        message || "Server error. Please try again later.",
      );
    default:
      return new AppError<TResource>(
        ErrorType.Unknown,
        message || "An unexpected error occurred.",
      );
  }
}

/**
 * Check if error is a network error (no connection).
 */
export function isNetworkError(error: unknown): boolean {
  // Native fetch/network failure
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return true;
  }

  if (error instanceof AppError) {
    // Treat ServerError as transient to allow retries on 5xx
    return (
      error.type === ErrorType.Network || error.type === ErrorType.ServerError
    );
  }

  return false;
}

/**
 * Narrow an AbortError emitted by fetch/AbortController.
 */
export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Best-effort guard for AppError across dynamic import boundaries.
 */
export function isAppError(error: unknown): error is AppError<unknown> {
  if (!error || typeof error !== "object") return false;

  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "AppError" && typeof candidate.message === "string";
}

/**
 * Check if error is a 409 Conflict (e.g., ai_version_rev mismatch).
 */
export function isConflictError(error: unknown): error is AppError<unknown> {
  return isAppError(error) && error.type === ErrorType.Conflict;
}

/**
 * Extract server document from 409 Conflict error.
 * The resource is a raw DTO from the backend, so we map it to Document.
 * Returns undefined if not a conflict or no resource attached.
 */
export function extractDocumentFromConflict(
  error: unknown,
): Document | undefined {
  if (!isConflictError(error)) return undefined;
  const dto = error.resource as DocumentDto | undefined;
  if (!dto) return undefined;
  return fromDocumentDto(dto);
}

/**
 * Extract error message from an error, with fallback.
 *
 * Use this in store catch blocks to get the message for error state.
 * Components should read error state and display inline errors.
 *
 * @param error - The caught error (AppError, Error, or unknown)
 * @param fallbackMessage - Message to return if error can't be parsed
 * @returns User-friendly error message
 *
 * @example
 * try {
 *   await api.threads.create(projectId, title)
 * } catch (error) {
 *   const message = getErrorMessageWithFallback(error, 'Failed to create thread')
 *   set({ error: message })
 *   throw error
 * }
 */
export function getErrorMessageWithFallback(
  error: unknown,
  fallbackMessage: string,
): string {
  return getErrorMessage(error) || fallbackMessage;
}
