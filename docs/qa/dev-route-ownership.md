# Dev route ownership

Use only disposable checkouts and processes you own. Record the shared
`pnpm portless:list` before and after; unrelated routes and PIDs must not change.

1. Create two detached worktrees at the same commit. Run `pnpm dev --print`
   in each. Names must include distinct detached prefixes, never bare
   `app.meridian` or `server.meridian`. Named worktrees retain their branch prefix.
2. In an owned scratch directory, start temporary Portless services using the
   exact app/server names planned for your test checkout, with a simple HTTP
   response identifying the scratch holder. Let Portless allocate backend ports.
3. Run ordinary `pnpm dev` in the test checkout. It must refuse with the
   conflicting hostname, PID, cwd and backend, suggesting `--restart`/`--force`.
   It must not claim `started` by probing the scratch services.
4. Run `pnpm dev --force`. Expect a takeover warning and verified startup.
   Discover the URL with `pnpm portless:list`, open it in a named
   `agent-browser` session and verify the Meridian screen replaces the scratch
   response. Check route owner cwd and configured backend ports.
5. Repeat the conflict and takeover with `pnpm dev --restart`. Ordinary
   `pnpm dev` against a healthy owned stack should still say `already running`.
6. Stop only your stack (`pnpm dev --stop`), close your named browser session,
   and terminate scratch processes. Remove disposable worktrees and their
   databases with the targeted cleanup tooling. Recheck unrelated route PIDs.

## Active identity after a Git change

On an owned detached checkout, start with `pnpm dev --no-tailscale` and record
the URLs and session metadata. Move HEAD with an owned empty commit while the
stack stays running. `pnpm dev --no-tailscale` must say `already running` with
the original URLs. `./mf project list` and the E2E URL resolver must discover
that same stack, not new names derived from HEAD. Open the discovered app URL
in a named browser session and verify Meridian still renders. `--print` must
describe that active session; `--restart --print` must plan the new identity.
Stop the old stack through its recorded identity and remove only your fixture.
Capture the original database name before moving HEAD so cleanup can drop the
database the stack actually used, not the name planned from the new commit.
