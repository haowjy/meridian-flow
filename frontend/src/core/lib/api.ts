import { Project } from '@/features/projects/types/project'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`)
  }

  return response.json()
}

export const api = {
  projects: {
    list: () => fetchAPI<Project[]>('/api/projects'),
    get: (id: string) => fetchAPI<Project>(`/api/projects/${id}`),
    create: (name: string) =>
      fetchAPI<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    update: (id: string, name: string) =>
      fetchAPI<Project>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      fetchAPI<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  },
  // Add documents API later in Phase 4
}
