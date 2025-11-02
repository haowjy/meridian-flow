import { useCallback, useState } from 'react'

/**
 * State for an async action.
 */
export interface AsyncActionState<T> {
  data: T | null
  loading: boolean
  error: Error | null
}

/**
 * Hook for managing async action state (loading, error, data).
 * Provides execute function that handles try/catch and state updates.
 *
 * @returns Tuple of [state, execute function]
 *
 * @example
 * ```tsx
 * const [state, createProject] = useAsyncAction(async (name: string) => {
 *   return await api.projects.create({ name })
 * })
 *
 * // In component:
 * <Button onClick={() => createProject('My Project')} disabled={state.loading}>
 *   {state.loading ? 'Creating...' : 'Create'}
 * </Button>
 * ```
 */
export function useAsyncAction<T, Args extends any[]>(
  action: (...args: Args) => Promise<T>
): [AsyncActionState<T>, (...args: Args) => Promise<void>] {
  const [state, setState] = useState<AsyncActionState<T>>({
    data: null,
    loading: false,
    error: null,
  })

  const execute = useCallback(
    async (...args: Args) => {
      setState({ data: null, loading: true, error: null })

      try {
        const result = await action(...args)
        setState({ data: result, loading: false, error: null })
      } catch (error) {
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error : new Error('Unknown error'),
        })
      }
    },
    [action]
  )

  return [state, execute]
}
