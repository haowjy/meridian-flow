# CLI Contract

**Required reading:**
- [`README.md`](README.md) (always)
- [`design-philosophy.md`](design-philosophy.md) (P3 — LLM-recognizable CLI)
- [`mcp-tools.md`](mcp-tools.md) (parity contract)

## Resource-First Command Grammar

Follows docker/kubectl/gh/aws conventions for discoverability:

```bash
meridian serve                                  # MCP server mode (stdio) — primary agent interface
meridian workspace start|resume|list|show|close # workspace management
meridian run create|list|show|continue|retry|wait  # run management
meridian skills list|search|show|reindex        # skill registry (P8)
meridian models list|show                       # model catalog (P11)
meridian context pin|unpin|list                 # context pinning
meridian diag doctor|repair                     # diagnostics
meridian export                                 # gather committable artifacts
meridian migrate                                # one-time JSONL-to-SQLite migration
```

Short aliases for common commands: `meridian start` = `meridian workspace start`, `meridian run` (with `-p`) = `meridian run create`, `meridian list` = `meridian run list`.

**MCP tools** (the primary agent interface — see [mcp-tools.md](mcp-tools.md)):
- Agents call `skills.search(query)` and `skills.load(id)` as MCP tools
- No skill descriptions injected into agent context by default
- Progressive disclosure — agent discovers what it needs

## Output Contract

**stdout vs stderr:**
- stdout: data output only (JSON, porcelain, report content)
- stderr: progress, diagnostics, warnings, error messages
- `--format json` implies stdout is valid JSON — no mixing

**Output modes:**
| Flag | Audience | Stable? | Uses rich? |
|------|----------|---------|-----------|
| (default) | Human in TTY | No | Yes (if TTY detected) |
| `--json` / `--format json` | Machine / agent | Yes (versioned) | No |
| `--porcelain` | Shell scripts | Yes (fixed columns) | No |
| `--verbose` / `--output wide` | Human debugging | No | Yes |

**Output stability contract:**
- `--format json` output schema is versioned and stable (add `--format-version` for future schema changes)
- Plain text output may change between versions (human-oriented)
- `--porcelain` option for stable plain-text scripting (like `git status --porcelain`)
- MCP tool response schemas are versioned and stable

**Non-TTY behavior:** When stdout is not a TTY, `rich` formatting is automatically disabled. ANSI escapes are never emitted to non-TTY.

## Interactive Prompting

- `--yes` / `-y`: skip all confirmation prompts (assume yes)
- `--no-input`: fail on any prompt (for CI/scripting)
- Default: prompt on TTY, fail on non-TTY

## Error Output (stable JSON schema)

```json
{
  "error": "run_not_found",
  "message": "Run r42 does not exist",
  "hint": "Use 'meridian run list' to see available runs"
}
```
