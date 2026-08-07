# Context browser TODO

- `ContextTreePanel.tsx` and `client/api/projects-api.ts`: add a real Uploads
  intake action backed by the server's multipart
  `POST /api/projects/:projectId/context/uploads/upload` route, including the
  active thread Work ID and invalidating that Work's `uploads` tree after a
  successful response. Keep the route's flat-path and supported-file-type
  errors writer-readable. Do not expose a picker until the request and cache
  refresh are wired end to end.
