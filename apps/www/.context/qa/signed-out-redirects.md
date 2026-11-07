# Signed-out redirects

Checks the circle between the landing page and the app. `DEV_AUTH_BYPASS=1` has no
signed-out state, so set `DEV_AUTH_BYPASS=0` in the worktree's `.env.local` and run
`pnpm dev --restart`. `MERIDIAN_WWW_ORIGIN` is exported in the default tailscale mode,
not with `--no-tailscale`, which runs no www.

| Start | Expect |
|---|---|
| Signed out, app `/` | The landing page |
| Signed out, app `/p/<id>` | WorkOS sign-in, then back to that page |
| Signed out, app `/login`, then Back home | The landing page |
| Signed out, app `/logout` | The landing page, with no redirect loop |
| Landing page, Sign in | App `/login` |
| Landing page, either Start writing | WorkOS sign-up, then the project library |
| Signed in, app `/signup` or `/login` | The project library |
| Signed in, account menu, Log out | The landing page. If WorkOS's default page appears instead, the landing URL isn't registered under Redirects → Sign-out redirects |

Run the signed-out rows at 1440x900 and 390x844.
