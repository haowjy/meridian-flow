# Python `orch` MCP Server: Best Practices Reference

Reference document for building `orch` -- a typed, async MCP server CLI tool in Python 3.12+.

**Stack:** Python 3.12+ | pyright strict | FastMCP (official SDK) | SQLite | asyncio subprocess | click/typer | uv | Pydantic | ruff

---

## 1. Project Structure

### src Layout with uv

The `src/` layout is the recommended structure for packaged Python projects. It prevents accidental imports of the local source tree during testing and ensures tests always run against the installed package.

```
orch/
├── pyproject.toml
├── uv.lock                    # Checked into version control
├── README.md
├── src/
│   └── orch/
│       ├── __init__.py        # Version, top-level exports
│       ├── __main__.py        # python -m orch support
│       ├── cli.py             # Click/Typer entry point
│       ├── server.py          # FastMCP server definition
│       ├── tools/             # MCP tool implementations
│       │   ├── __init__.py
│       │   ├── plan.py
│       │   └── worker.py
│       ├── db/                # SQLite layer
│       │   ├── __init__.py
│       │   ├── models.py      # Frozen dataclasses for DB rows
│       │   ├── queries.py     # SQL query functions
│       │   └── migrations.py
│       ├── subprocess/        # Worker process management
│       │   ├── __init__.py
│       │   └── runner.py
│       ├── domain/            # Domain types and logic
│       │   ├── __init__.py
│       │   ├── types.py       # Frozen dataclasses, enums
│       │   └── errors.py      # Error hierarchy
│       └── _internal/         # Private utilities
│           ├── __init__.py
│           └── logging.py
└── tests/
    ├── __init__.py
    ├── conftest.py            # Shared fixtures
    ├── test_cli.py
    ├── test_server.py
    ├── test_tools/
    ├── test_db/
    └── test_subprocess/
```

### pyproject.toml

```toml
[project]
name = "orch"
version = "0.1.0"
description = "Orchestration MCP server for agent workflows"
requires-python = ">=3.12"
dependencies = [
    "mcp>=1.7",
    "click>=8.1",
    "pydantic>=2.0",
    "aiosqlite>=0.20",
]

[project.scripts]
orch = "orch.cli:main"

# build-system is REQUIRED for entry points to work with uv/uvx
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/orch"]

[dependency-groups]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "pytest-subprocess>=1.5",
    "ruff>=0.8",
    "pyright>=1.1",
]

[tool.pyright]
pythonVersion = "3.12"
typeCheckingMode = "strict"
include = ["src"]

[tool.ruff]
target-version = "py312"
src = ["src"]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "SIM", "TCH", "RUF"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

### uv Workflows

```bash
# Initialize project (--package ensures build-system is created)
uv init --package orch

# Add dependencies
uv add mcp click pydantic aiosqlite
uv add --group dev pytest pytest-asyncio ruff pyright

# Run the CLI during development
uv run orch --help

# Run as module
uv run python -m orch

# Lock and sync
uv lock
uv sync

# Run via uvx (ephemeral, no install needed -- for users)
uvx orch serve

# Type checking and linting
uv run pyright
uv run ruff check src/ tests/
uv run ruff format src/ tests/
```

Key point from the uv docs: a project is only considered a "package" if `[build-system]` is defined or `tool.uv.package = true` is set. Without this, `[project.scripts]` entry points will not work.

The `uv.lock` file should be committed to version control. It contains exact resolved versions and ensures consistent environments across developers.

---

## 2. Strict Typing Patterns

### pyright Strict Mode

Strict mode enables ~30 additional rules including mandatory annotations on all function signatures. Configure in `pyproject.toml`:

```toml
[tool.pyright]
typeCheckingMode = "strict"
```

For incremental adoption, use `# pyright: basic` at the top of files not yet fully typed.

### Protocol Classes (Structural Typing)

Use `Protocol` for dependency inversion. This is Python's answer to Go interfaces -- structural subtyping without inheritance.

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class WorkerRunner(Protocol):
    """Interface for running worker agent processes."""

    async def spawn(self, command: list[str], env: dict[str, str]) -> int:
        """Spawn a worker process. Returns exit code."""
        ...

    async def kill(self, pid: int) -> None:
        """Kill a running worker process."""
        ...


class AsyncioWorkerRunner:
    """Concrete implementation using asyncio.create_subprocess_exec."""

    async def spawn(self, command: list[str], env: dict[str, str]) -> int:
        proc = await asyncio.create_subprocess_exec(
            *command,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.wait()
        return proc.returncode or 0

    async def kill(self, pid: int) -> None:
        import signal
        import os
        os.kill(pid, signal.SIGTERM)
```

### TypeVar and Generics

```python
from typing import TypeVar, Generic

T = TypeVar("T")
E = TypeVar("E", bound=Exception)


class Result(Generic[T, E]):
    """Simple result type for operations that can fail."""
    ...
```

For Python 3.12+, use the new syntax:

```python
# Python 3.12+ generic syntax (PEP 695)
type Result[T, E: Exception] = Ok[T] | Err[E]
```

### assert_never for Exhaustive Matching

```python
from typing import assert_never, Literal

type TaskStatus = Literal["pending", "running", "done", "failed"]

def handle_status(status: TaskStatus) -> str:
    match status:
        case "pending":
            return "Waiting..."
        case "running":
            return "In progress..."
        case "done":
            return "Complete!"
        case "failed":
            return "Error occurred"
        case _ as unreachable:
            assert_never(unreachable)  # Compile-time error if cases missed
```

### Frozen Dataclasses vs Pydantic: Decision Rules

**Use frozen dataclasses for internal domain types** -- immutable, hashable, zero validation overhead:

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class TaskId:
    """Value object: immutable, hashable, no validation overhead."""
    value: str

@dataclass(frozen=True, slots=True)
class WorkerProcess:
    pid: int
    task_id: TaskId
    command: tuple[str, ...]  # Tuple for immutability
    started_at: float
```

**Use Pydantic models at trust boundaries** -- API input, config files, MCP tool arguments:

```python
from pydantic import BaseModel, Field

class RunWorkerRequest(BaseModel):
    """Validated input from MCP tool call."""
    model_config = {"frozen": True}  # Also immutable after validation

    task_name: str = Field(min_length=1, max_length=100)
    model: str = Field(pattern=r"^[a-z0-9-]+$")
    timeout_seconds: int = Field(ge=1, le=3600, default=300)
```

**Rule of thumb:** Pydantic at the edges (MCP tool args, config files, external input), frozen dataclasses in the core (domain objects, DB row mappings, internal state).

### NewType for Semantic Typing

```python
from typing import NewType

TaskId = NewType("TaskId", str)
WorkerId = NewType("WorkerId", str)

def get_task(task_id: TaskId) -> Task: ...

# Prevents mixing up string IDs at compile time:
# get_task(WorkerId("w1"))  # pyright error!
```

---

## 3. Async Patterns

### The Sync/Async Boundary

The "colored functions" problem: sync code cannot call async code directly, and async code should not call blocking sync code. The boundary must be explicit.

**Pattern: sync CLI shell wrapping an async core**

```python
# cli.py -- sync entry point
import asyncio
import click

@click.group()
def main() -> None:
    """orch - orchestration MCP server."""
    pass

@main.command()
@click.option("--transport", default="stdio", type=click.Choice(["stdio", "http"]))
def serve(transport: str) -> None:
    """Start the MCP server."""
    asyncio.run(_serve(transport))

async def _serve(transport: str) -> None:
    """Async server implementation."""
    from orch.server import create_server
    server = create_server()
    server.run(transport=transport)
```

Alternative: use Typer which handles `asyncio.run()` automatically for async commands:

```python
# cli.py -- Typer handles async natively
import typer

app = typer.Typer()

@app.command()
async def serve(transport: str = "stdio") -> None:
    """Start the MCP server."""
    from orch.server import create_server
    server = create_server()
    server.run(transport=transport)
```

### aiosqlite for Async SQLite

aiosqlite wraps the standard `sqlite3` module, executing queries in a dedicated thread so they don't block the event loop.

```python
import aiosqlite
from pathlib import Path

class Database:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._conn = await aiosqlite.connect(self._path)
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()

    @property
    def conn(self) -> aiosqlite.Connection:
        assert self._conn is not None, "Database not connected"
        return self._conn

    async def get_task(self, task_id: str) -> Task | None:
        async with self.conn.execute(
            "SELECT id, name, status FROM tasks WHERE id = ?", (task_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return Task(id=row[0], name=row[1], status=row[2])
```

**When to use sync sqlite3 instead:** If the server does very few DB operations and they are always fast (small DB, indexed queries), sync `sqlite3` with `asyncio.to_thread()` is simpler and avoids the aiosqlite dependency. But for an MCP server that tracks state across many concurrent tool calls, aiosqlite is the right choice.

### Asyncio Subprocess Management

```python
import asyncio
from dataclasses import dataclass, field

@dataclass
class ProcessResult:
    exit_code: int
    stdout: str
    stderr: str

async def run_worker(
    command: list[str],
    env: dict[str, str] | None = None,
    timeout: float = 300.0,
) -> ProcessResult:
    """Run a subprocess with timeout and capture output."""
    proc = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return ProcessResult(
            exit_code=-1,
            stdout="",
            stderr=f"Process timed out after {timeout}s",
        )

    return ProcessResult(
        exit_code=proc.returncode or 0,
        stdout=stdout_bytes.decode() if stdout_bytes else "",
        stderr=stderr_bytes.decode() if stderr_bytes else "",
    )
```

**Managing multiple concurrent workers:**

```python
import asyncio
from dataclasses import dataclass, field

@dataclass
class WorkerPool:
    """Track and manage concurrent worker processes."""
    _processes: dict[str, asyncio.subprocess.Process] = field(default_factory=dict)
    _semaphore: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(4))

    async def spawn(self, task_id: str, command: list[str]) -> None:
        async with self._semaphore:  # Limit concurrency
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._processes[task_id] = proc
            try:
                await proc.wait()
            finally:
                self._processes.pop(task_id, None)

    async def cancel(self, task_id: str) -> bool:
        proc = self._processes.get(task_id)
        if proc is None:
            return False
        proc.terminate()
        # Give it 5s to shut down gracefully, then kill
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        return True

    async def cancel_all(self) -> None:
        tasks = [self.cancel(tid) for tid in list(self._processes)]
        await asyncio.gather(*tasks, return_exceptions=True)
```

### Offloading Blocking Work

For any sync/blocking operation inside the async context:

```python
import asyncio

# Run blocking I/O in a thread
result = await asyncio.to_thread(some_blocking_function, arg1, arg2)

# For CPU-bound work, use ProcessPoolExecutor
from concurrent.futures import ProcessPoolExecutor

pool = ProcessPoolExecutor(max_workers=2)
result = await asyncio.get_event_loop().run_in_executor(pool, cpu_heavy_function, arg)
```

---

## 4. MCP SDK (Python)

### Overview

The official Python SDK (`mcp` on PyPI, `modelcontextprotocol/python-sdk` on GitHub) provides two API levels:

1. **FastMCP** (high-level) -- decorator-based, automatic schema generation, recommended for most use cases
2. **Low-level Server** -- manual tool/resource registration, full protocol control

For `orch`, FastMCP is the right choice.

### Basic Server Setup

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    name="orch",
    instructions="Orchestration server for managing agent workflows",
    version="0.1.0",
)
```

### Defining Tools

Tools are the primary interaction surface for an MCP server. Use the `@mcp.tool()` decorator:

```python
from mcp.server.fastmcp import FastMCP, Context
from mcp.server.session import ServerSession
from pydantic import BaseModel, Field

mcp = FastMCP("orch")

# Simple tool -- args become JSON schema automatically
@mcp.tool()
def list_tasks() -> list[dict[str, str]]:
    """List all orchestration tasks."""
    return [{"id": "1", "status": "running"}]

# Async tool with context for logging/progress
@mcp.tool()
async def run_task(
    task_name: str,
    model: str,
    ctx: Context[ServerSession, object],
) -> str:
    """Run an orchestration task with the specified model."""
    await ctx.info(f"Starting task: {task_name}")
    await ctx.report_progress(progress=0, total=100, message="Initializing")

    # ... do work ...

    await ctx.report_progress(progress=100, total=100, message="Complete")
    return f"Task {task_name} completed successfully"

# Tool returning structured data via Pydantic
class TaskResult(BaseModel):
    task_id: str
    status: str
    exit_code: int | None = None
    output: str = ""

@mcp.tool()
async def get_task_status(task_id: str) -> TaskResult:
    """Get the status of a running task."""
    return TaskResult(task_id=task_id, status="running")
```

### Lifespan and Dependency Injection

Use the lifespan pattern to manage resources (DB connections, worker pools) and make them available to tools via context:

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.session import ServerSession

@dataclass
class AppContext:
    db: Database
    worker_pool: WorkerPool

@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[AppContext]:
    db = Database(Path("~/.orch/state.db").expanduser())
    await db.connect()
    worker_pool = WorkerPool()
    try:
        yield AppContext(db=db, worker_pool=worker_pool)
    finally:
        await worker_pool.cancel_all()
        await db.close()

mcp = FastMCP("orch", lifespan=app_lifespan)

# Access context in tools
@mcp.tool()
async def run_worker(
    command: str,
    ctx: Context[ServerSession, AppContext],
) -> str:
    """Spawn a worker process."""
    app = ctx.request_context.lifespan_context
    # app.db, app.worker_pool are available here
    await app.worker_pool.spawn("task-1", command.split())
    return "Worker spawned"
```

### Running as Stdio Server

For use with Claude Code and other MCP clients:

```python
# In cli.py
@main.command()
def serve() -> None:
    """Start orch as an MCP stdio server."""
    mcp.run(transport="stdio")  # This is the default
```

The server reads JSON-RPC messages from stdin and writes responses to stdout. This is the standard transport for MCP servers invoked by AI tools.

### Server Configuration for Claude Code

In the client's MCP config (e.g., `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "orch": {
      "command": "uvx",
      "args": ["orch", "serve"]
    }
  }
}
```

Or during development:

```json
{
  "mcpServers": {
    "orch": {
      "command": "uv",
      "args": ["--directory", "/path/to/orch", "run", "orch", "serve"]
    }
  }
}
```

---

## 5. Error Handling Patterns

### Error Hierarchy

Define a narrow exception hierarchy for domain errors:

```python
class OrchError(Exception):
    """Base error for all orch operations."""
    pass

class TaskNotFoundError(OrchError):
    """Raised when a task ID doesn't exist."""
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task not found: {task_id}")

class WorkerSpawnError(OrchError):
    """Raised when a worker process fails to start."""
    def __init__(self, command: list[str], reason: str) -> None:
        self.command = command
        self.reason = reason
        super().__init__(f"Failed to spawn worker: {reason}")

class WorkerTimeoutError(OrchError):
    """Raised when a worker exceeds its timeout."""
    pass
```

### Union Return Types (Errors as Values)

For internal functions where you want explicit error handling without exceptions, use union return types. This is the most idiomatic Python approach, using `isinstance()` for type narrowing:

```python
def parse_config(raw: str) -> Config | ConfigError:
    """Parse configuration. Returns error instead of raising."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return ConfigError(f"Invalid JSON: {e}")
    # ... validate ...
    return Config(**data)

# Caller gets type narrowing from isinstance:
result = parse_config(raw_text)
if isinstance(result, ConfigError):
    # pyright knows result is ConfigError here
    log.error(result.message)
    return
# pyright knows result is Config here
use_config(result)
```

### MCP Tool Error Handling

In MCP tools, errors should be returned as text content (not raised), since the LLM client needs to understand what went wrong:

```python
@mcp.tool()
async def get_task(
    task_id: str,
    ctx: Context[ServerSession, AppContext],
) -> str:
    """Get task details."""
    app = ctx.request_context.lifespan_context
    try:
        task = await app.db.get_task(task_id)
    except OrchError as e:
        # Return error as text -- the LLM can read and react to this
        return f"Error: {e}"

    if task is None:
        return f"Error: Task '{task_id}' not found"

    return f"Task {task.id}: status={task.status}, started={task.started_at}"
```

### When to Use Which Pattern

| Pattern | Use When |
|---|---|
| Exception hierarchy | Unrecoverable errors, errors that bubble up multiple layers |
| Union returns | Expected failures in pure functions, when caller must handle |
| MCP text errors | Tool responses to the LLM client |
| `assert` | Invariant violations that indicate bugs |

---

## 6. Testing Patterns

### pytest + pytest-asyncio Setup

With `asyncio_mode = "auto"` in `pyproject.toml`, any `async def test_*` function is automatically treated as an async test.

```python
# tests/conftest.py
import pytest
import tempfile
from pathlib import Path

@pytest.fixture
def tmp_db_path(tmp_path: Path) -> Path:
    return tmp_path / "test.db"

@pytest.fixture
async def db(tmp_db_path: Path) -> AsyncIterator[Database]:
    """Async fixture providing a test database."""
    database = Database(tmp_db_path)
    await database.connect()
    await database.run_migrations()
    yield database
    await database.close()
```

### Testing Async Code

```python
# tests/test_db.py
async def test_create_and_get_task(db: Database) -> None:
    task_id = await db.create_task("my-task", "pending")
    task = await db.get_task(task_id)
    assert task is not None
    assert task.name == "my-task"
    assert task.status == "pending"

async def test_task_not_found(db: Database) -> None:
    task = await db.get_task("nonexistent")
    assert task is None
```

### Mocking Subprocesses

Use `pytest-subprocess` for clean subprocess mocking:

```python
# tests/test_worker.py
import pytest
from pytest_subprocess import FakeProcess

async def test_run_worker_success(fp: FakeProcess) -> None:
    fp.register(["claude", "--model", "sonnet", "run"], stdout="Done", returncode=0)

    result = await run_worker(["claude", "--model", "sonnet", "run"])
    assert result.exit_code == 0
    assert result.stdout == "Done"

async def test_run_worker_timeout(fp: FakeProcess) -> None:
    # Simulate a process that hangs
    fp.register(["slow-cmd"], callback=lambda _: None)  # Never completes

    result = await run_worker(["slow-cmd"], timeout=0.1)
    assert result.exit_code == -1
    assert "timed out" in result.stderr
```

For more control, use `unittest.mock.AsyncMock`:

```python
from unittest.mock import AsyncMock, patch

async def test_worker_pool_spawn() -> None:
    mock_proc = AsyncMock()
    mock_proc.wait = AsyncMock(return_value=None)
    mock_proc.returncode = 0

    with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
        pool = WorkerPool()
        await pool.spawn("task-1", ["echo", "hello"])
        mock_exec.assert_called_once()
```

### Testing MCP Servers

Test tools directly as Python functions (they are just decorated async/sync functions):

```python
# tests/test_tools.py
async def test_list_tasks_tool(db: Database) -> None:
    # Populate test data
    await db.create_task("task-1", "running")

    # Call tool function directly
    result = list_tasks()
    assert len(result) == 1
    assert result[0]["status"] == "running"
```

For integration testing with the MCP protocol, use the SDK's client:

```python
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

async def test_mcp_server_integration() -> None:
    """Full integration test via stdio transport."""
    async with stdio_client(
        StdioServerParameters(command="uv", args=["run", "orch", "serve"])
    ) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            tool_names = [t.name for t in tools.tools]
            assert "list_tasks" in tool_names

            result = await session.call_tool("list_tasks", {})
            assert result.content[0].text  # type: ignore[union-attr]
```

### Test Organization

```
tests/
├── conftest.py          # Shared fixtures (db, worker pool)
├── unit/
│   ├── test_domain.py   # Pure domain logic
│   ├── test_db.py       # Database operations (uses tmp db)
│   └── test_errors.py   # Error types and handling
├── integration/
│   ├── test_tools.py    # MCP tools with real DB
│   └── test_server.py   # Full MCP client-server tests
└── e2e/
    └── test_cli.py      # CLI invocation via subprocess
```

---

## 7. Packaging and Distribution

### Making `orch` Installable via uvx

The key requirements for `uvx orch` to work:

1. **`[build-system]`** must be defined in `pyproject.toml` (see Section 1)
2. **`[project.scripts]`** must define the CLI entry point
3. The package must be published to PyPI (or a private index)

```toml
[project.scripts]
orch = "orch.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/orch"]
```

### __main__.py for `python -m` Support

```python
# src/orch/__main__.py
from orch.cli import main

main()
```

### Publishing

```bash
# Build
uv build

# Publish to PyPI
uv publish

# Test with uvx
uvx orch --help
uvx orch serve
```

### Development Install

```bash
# Editable install for development
uv sync

# Run during development
uv run orch serve

# Or directly
uv run python -m orch serve
```

### Build Backend Choice

**hatchling** is recommended for new projects -- it is fast, well-maintained, and the default for uv. Other options:

| Backend | Notes |
|---|---|
| `hatchling` | Default for uv, fast, simple config |
| `setuptools` | Broad compatibility, more config needed |
| `flit-core` | Minimal, good for pure Python |
| `pdm-backend` | If using pdm ecosystem |

---

## Summary: Key Decisions for `orch`

| Decision | Choice | Rationale |
|---|---|---|
| Layout | `src/` | Testing isolation, uv best practice |
| Build backend | `hatchling` | uv default, fast, simple |
| Type checker | pyright strict | Catches more bugs, better IDE support |
| MCP API | FastMCP (high-level) | Decorator-based, auto schema, less boilerplate |
| Transport | stdio (default) | Standard for Claude Code integration |
| CLI framework | click | Mature, sync wrapper around async core |
| DB | aiosqlite | Non-blocking in async context |
| Validation | Pydantic at edges, frozen dataclasses internally | Safety where needed, speed where it matters |
| Error handling | Exception hierarchy + union returns | Exceptions for unexpected, unions for expected |
| Testing | pytest + pytest-asyncio + pytest-subprocess | Standard async testing stack |
| Packaging | uv + hatchling | Modern, fast, uvx-compatible |
