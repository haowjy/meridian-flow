# `orch` Python Library Alternatives (Python 3.14)

**Date:** February 25, 2026  
**Status:** Research  
**Scope:** Typed async MCP server + CLI for `orch`

## Problem Statement
Select libraries for `orch` that maximize:
- strict typing (pyright strict)
- async correctness (MCP server + subprocess execution)
- Python 3.14 compatibility
- low dependency count
- long-term maintainability

## Codebase Context
Current `orch` planning docs expect:
- thin CLI/MCP adapters and business logic in `orch.lib` (`_docs/plans/meridian-channel/_archive/design/orchestrate-cli-python.md:299-306`)
- typed MCP tool IO via Pydantic (`_docs/plans/meridian-channel/_archive/design/orchestrate-cli-python.md:310-470`)
- SQLite state layer with WAL (`_docs/plans/meridian-channel/_archive/design/orchestrate-cli-python.md:947-1033`)
- initial dependency examples around `click`, `mcp`, `pydantic`, `jinja2`, `aiosqlite`, `pytest`, `pyright`, `ruff` (`_docs/plans/meridian-channel/_archive/design/orchestrate-cli-python.md:687-748`)

Related existing Python CLI in repo (`cli/`) currently uses Textual (`cli/pyproject.toml:8`).

## Best Practices (for this project)
- Keep protocol and domain boundaries strongly typed at IO boundaries (MCP payloads, config files, DB rows).
- Prefer stdlib when it does not materially increase complexity.
- Prefer async-native APIs for subprocess + server surfaces.
- Keep output mode separation strict: human (`plain`/`table`) vs machine (`--json` / `--porcelain`).
- Avoid ORM abstractions for a small local state store unless query complexity clearly demands it.

## Maintenance / Python 3.14 Snapshot (as of 2026-02-25)
From PyPI metadata (latest uploads):

- Very active + explicit `3.14` classifier: `typer`, `tyro`, `rich`, `textual`, `anyio`, `pydantic-settings`, `pytest`, `pytest-asyncio`, `pytest-mock`, `watchfiles`, `structlog`, `nox`.
- Active but no explicit `3.14` classifier: `cyclopts`, `click`, `aiosqlite`, `dynaconf`, `jinja2`, `mako`, `pytest-subprocess`.
- Lagging cadence / older ecosystem signal: `dataset` (last release 2023-07), `ward` (last release 2023-12 pre-release), `tabulate` (last release 2022-10), `pytest-snapshot` (last release 2022-04).

---

## 1) CLI Frameworks
Options reviewed: `typer`, `cyclopts`, `click`, `argparse`, `tyro`

### Findings
- `cyclopts` is strongly type-hint centered, has explicit async command support, command groups/subcommands, and strong unit-testing docs.
- `typer` is mature, type-hint friendly, great ergonomics, and first-class Click testing integration, but no first-party async command model in docs/source.
- `click` is very stable and well-tested, but less type-centric and mostly decorator/manual parameter style.
- `argparse` is stdlib and supports subcommands; in Python 3.14 it now supports color/suggestion features, but typing ergonomics are manual.
- `tyro` is excellent for typed config-driven CLIs (dataclass/attrs/pydantic parsing), but less natural for large imperative command trees (`orch run`, `orch workspace`, etc.).

### Recommendation
**Pick `cyclopts` for `orch` CLI if strict typing + async command handlers are top priorities.**

Why:
- best type-hint integration among the compared imperative CLI frameworks
- native async command support
- good subcommand/group structure
- clean pytest-based testing story

Risk:
- smaller ecosystem than Click/Typer
- no explicit PyPI `3.14` classifier yet (validate in CI immediately)

Fallback:
- If you want maximum ecosystem stability over async-first ergonomics, stay with **Typer**.

---

## 2) SQLite Layer
Options reviewed: `aiosqlite`, stdlib `sqlite3` (+ `asyncio.to_thread()`), `sqlmodel`, `peewee`, `dataset`

### Findings
- `aiosqlite` uses a single shared thread per connection with a request queue, which maps well to async service code and avoids event-loop blocking.
- `sqlite3` + `asyncio.to_thread()` can work and reduce dependencies, but you must design thread affinity / connection handling carefully (`check_same_thread` behavior, transaction boundaries).
- `sqlmodel` is strongly typed and convenient but brings SQLAlchemy/Alembic-level abstraction and dependency cost; likely too heavy for a local state/index DB.
- `peewee` is capable (including WAL pragmas and migration helpers), but still ORM overhead for this use case.
- `dataset` emphasizes convenience and automatic schema but is weak for strict typing and has older maintenance signals.

### Recommendation
**Keep `aiosqlite`** for `orch` v1.

Direct answer to your question:
- `sqlite3 + to_thread()` is viable for very small/low-concurrency cases.
- For an async MCP server with concurrent tool calls, `aiosqlite` is safer and simpler operationally than hand-rolled thread delegation.

Migration guidance:
- use forward-only SQL migrations (raw SQL files + schema version table), not ORM migration layers.

---

## 3) Structured Output / Tables
Options reviewed: `rich`, `textual`, `tabulate`, plain formatting

### Findings
- `rich` supports tables/progress/markup and has explicit terminal detection + color controls (`NO_COLOR`, `is_terminal`, configurable color system).
- `textual` is a full TUI framework (great for interactive apps, heavy for standard command output).
- `tabulate` is lightweight and excellent for plain text tables, but no integrated color/progress/terminal behavior model.
- Plain formatting gives maximum stability for `--porcelain`, but weak human UX if used alone.

### Recommendation
**Use `rich` + explicit output-mode guards.**

Pattern:
- `--json` and `--porcelain`: bypass Rich tables entirely, emit deterministic plain/JSON only.
- interactive human mode: Rich tables/progress when `isatty`.
- non-TTY: disable color/ANSI.

Do **not** use Textual for normal command output in `orch`.

---

## 4) Process Management
Options reviewed: `asyncio.create_subprocess_exec`, `subprocess`, `anyio`

### Findings
- `asyncio.create_subprocess_exec` is the direct async stdlib fit for stream handling, cancellation, and process lifecycle in an asyncio app.
- `subprocess` is sync-first and fine for isolated sync code paths/tests.
- `anyio` adds portability (asyncio/trio), structured cancellation semantics, and subprocess wrappers, but is extra abstraction if you are all-in on asyncio.

### Recommendation
**Use `asyncio.create_subprocess_exec` for runtime execution paths.**

Use `subprocess` only in small sync helpers/tests. Add `anyio` only if you intentionally want multi-backend concurrency semantics beyond asyncio.

---

## 5) Config Parsing
Options reviewed: `tomllib`, `tomli`, `dynaconf`, `pydantic-settings`

### Findings
- `tomllib` is stdlib in Python 3.14 and sufficient for parsing `.orchestrate/config.toml` and `models.toml`.
- `tomli` is mainly a backport path for older Python; not needed for 3.14-only.
- `pydantic-settings` adds strong typed settings models + env/secrets loading.
- `dynaconf` is feature-rich (multi-source/layered config) but introduces more magic and dependency weight than `orch` likely needs.

### Recommendation
**Use `tomllib` + Pydantic models for validation.**

Add `pydantic-settings` only if you need environment/secret source layering beyond simple TOML + explicit overrides.

---

## 6) Template / Prompt Composition
Options reviewed: Python 3.14 t-strings (PEP 750), `jinja2`, `string.Template`, `mako`

### Findings
- t-strings are new in 3.14 and powerful for structured interpolation metadata in inline Python code.
- `jinja2` remains best for file-based templates, inheritance/macros/control flow, and optional sandboxing.
- `string.Template` is minimal and safe-ish but too limited for non-trivial prompt composition.
- `mako` is powerful but generally allows more direct Python-like templating complexity and security surface.

### Recommendation
**Primary: `jinja2` for file-based prompt templates.**

Optional: use **t-strings** for small inline prompt snippets generated in code. Do not make t-strings the only template mechanism for skills/prompts at this stage.

---

## 7) Testing Stack
Options reviewed: `pytest`, `ward`, `nox`

### Findings
- `pytest` remains the strongest ecosystem fit for async + CLI + subprocess testing.
- `ward` has interesting ergonomics but weaker maintenance signal and smaller plugin ecosystem.
- `nox` is not a test framework replacement; it is session automation (run lint/type/test matrices).

### Recommendation
**Keep `pytest` + `pytest-asyncio`. Add focused plugins:**
- `pytest-mock` for patching/mocks
- `pytest-subprocess` for subprocess fakes
- `pytest-cov` for coverage
- optional: `hypothesis` for parser/model property tests

For MCP server testing specifically:
- use the MCP SDK’s own client primitives (`ClientSession`, `stdio_client`) in integration tests.

For CLI testing:
- Typer/Click: `CliRunner`
- Cyclopts: parse/invoke patterns from Cyclopts unit-testing docs

Use `nox` to orchestrate sessions (lint/type/test on 3.14), not instead of pytest.

---

## 8) Additional Libraries Worth Considering

### High-value, low-risk adds
- **`structlog`**: structured logging with contextvars support, good fit for run/workspace traceability.
- **`tenacity`**: robust retry/backoff for flaky external calls (model APIs, transient subprocess startup failures).
- **`watchfiles`** (optional): async file watching for skill/model index refresh workflows.

### Maybe later
- **`orjson`**: faster JSON serialization for heavy output volume.
- **Result-type libs (`result`, `returns`)**: useful for explicit error channels but add style/learning overhead; avoid until error model complexity justifies it.

---

## Recommended Stack for `orch` (Python 3.14)

- CLI: **Cyclopts** (or Typer for conservative ecosystem choice)
- MCP SDK: **mcp** (official SDK)
- Validation: **Pydantic v2.12+**
- SQLite: **aiosqlite** + raw SQL migrations + WAL
- Output: **Rich** with strict output-mode separation (`plain`/`json`/`porcelain`)
- Process: **asyncio.create_subprocess_exec**
- Config: **tomllib** (+ optional `pydantic-settings` for env/secrets layering)
- Templates: **Jinja2** (+ optional t-strings for small inline templates)
- Testing: **pytest + pytest-asyncio + pytest-mock + pytest-subprocess (+ pytest-cov)**
- Tooling: **ruff + pyright + uv**

## Open Questions
1. Is command-handler-level async execution a hard requirement for CLI commands, or is async only required inside the MCP server? (This affects Cyclopts vs Typer.)
2. Do you want environment-variable override semantics in v1 config, or TOML-only + explicit CLI flags?
3. Do you need prompt template inheritance/macros at v1, or only single-file substitution?
4. Should `orch` commit to a strict stable plain-text `--porcelain` contract from day one (recommended)?

## Sources

### Repository context
- `_docs/plans/meridian-channel/_archive/design/orchestrate-cli-python.md` (local)
- `cli/pyproject.toml` (local)

### Core docs / specs
- Python `argparse`: https://docs.python.org/3/library/argparse.html
- Python `asyncio` subprocess: https://docs.python.org/3/library/asyncio-subprocess.html
- Python `asyncio.to_thread`: https://docs.python.org/3/library/asyncio-task.html#asyncio.to_thread
- Python `sqlite3`: https://docs.python.org/3/library/sqlite3.html
- Python `tomllib`: https://docs.python.org/3/library/tomllib.html
- Python template string literals (`t`-strings): https://docs.python.org/3/library/string.templatelib.html
- PEP 750: https://peps.python.org/pep-0750/
- Python `string.Template`: https://docs.python.org/3/library/string.html#template-strings-strings

### CLI frameworks
- Typer docs/README: https://typer.tiangolo.com/ and https://github.com/fastapi/typer
- Click docs: https://click.palletsprojects.com/en/stable/
- Cyclopts docs: https://cyclopts.readthedocs.io/en/latest/
- Tyro docs/README: https://brentyi.github.io/tyro/ and https://github.com/brentyi/tyro

### SQLite + migrations
- aiosqlite docs: https://aiosqlite.omnilib.dev/en/stable/
- SQLModel README: https://github.com/fastapi/sqlmodel
- Peewee docs: https://docs.peewee-orm.com/en/latest/
- Dataset docs: https://dataset.readthedocs.io/en/latest/
- Alembic docs: https://alembic.sqlalchemy.org/en/latest/
- SQLite WAL docs: https://sqlite.org/wal.html
- SQLite PRAGMA journal_mode: https://sqlite.org/pragma.html#pragma_journal_mode

### Output and UI
- Rich docs: https://rich.readthedocs.io/en/latest/console.html
- Textual docs: https://textual.textualize.io/
- Tabulate README: https://github.com/astanin/python-tabulate

### Process / concurrency
- AnyIO docs: https://anyio.readthedocs.io/en/stable/

### Config + templates
- pydantic-settings docs: https://docs.pydantic.dev/latest/concepts/pydantic_settings/
- pydantic-settings repo docs: https://github.com/pydantic/pydantic-settings
- Dynaconf docs: https://www.dynaconf.com/
- Tomli README: https://github.com/hukkin/tomli
- Jinja docs: https://jinja.palletsprojects.com/en/stable/
- Mako docs: https://docs.makotemplates.org/en/latest/

### Testing
- pytest docs: https://docs.pytest.org/en/latest/
- pytest-asyncio docs: https://pytest-asyncio.readthedocs.io/en/latest/
- pytest-subprocess docs: https://pytest-subprocess.readthedocs.io/en/latest/
- pytest-mock docs: https://pytest-mock.readthedocs.io/en/latest/
- Ward docs: https://ward.readthedocs.io/en/latest/
- Nox README/docs: https://github.com/wntrblm/nox and https://nox.thea.codes/
- MCP Python SDK: https://github.com/modelcontextprotocol/python-sdk

### Additional libraries
- watchfiles docs: https://watchfiles.helpmanual.io/
- structlog docs: https://www.structlog.org/en/stable/
- tenacity docs: https://tenacity.readthedocs.io/en/latest/
- rustedpy result: https://github.com/rustedpy/result
- returns docs: https://returns.readthedocs.io/en/latest/

### Compatibility & maintenance metadata (release recency / classifiers)
- PyPI package pages for each evaluated package (e.g., `https://pypi.org/project/<package>/`).
