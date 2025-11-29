import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import './globals.css'

const router = createRouter({
  routeTree,
})

// Dev-only diagnostics to trace how the router reacts to browser history changes.
// This helps debug cases where the URL changes (e.g., browser back/forward) but
// the expected route components don't appear to re-render.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  window.addEventListener('popstate', (event) => {
    // eslint-disable-next-line no-console
    console.log('[POPSTATE]', {
      path: window.location.pathname,
      state: event.state,
    })
  })

  router.history.subscribe((event) => {
    // eslint-disable-next-line no-console
    console.log('[HISTORY EVENT]', {
      action: event.action,
      path: event.location.pathname,
      state: event.location.state,
    })
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
