# Rust CLI Best Practices Reference

Dense reference for the orchestrate Rust rewrite. Crate versions target Rust 2021 edition, stable toolchain. All version numbers are minimums as of early 2025.

---

## 1. Project Structure

### Workspace Layout

```
project-root/
  Cargo.toml          # [workspace] members = ["crates/*"]
  Cargo.lock           # always commit for binaries
  crates/
    core/              # shared library logic
      src/lib.rs
    cli/               # binary crate, depends on core
      src/main.rs
      src/commands/     # one module per subcommand
```

**Workspace `Cargo.toml`:**

```toml
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.dependencies]
# Pin shared deps here, reference with { workspace = true } in members
serde = { version = "1", features = ["derive"] }
anyhow = "1"
tokio = { version = "1", features = ["full"] }
```

Member crate references workspace deps:

```toml
[dependencies]
serde = { workspace = true }
```

### Library/Binary Split

Keep application logic in `lib.rs` so integration tests can import it. `main.rs` is just the entry point:

```rust
// src/main.rs
fn main() -> anyhow::Result<()> {
    my_cli::run()
}
```

For multiple binaries, use `src/bin/tool_a.rs`, `src/bin/tool_b.rs` or separate crates.

### Feature Flags

```toml
[features]
default = ["sqlite"]
sqlite = ["dep:rusqlite"]
llm-openai = ["dep:reqwest"]
```

Guard code with `#[cfg(feature = "sqlite")]`. Keep the default feature set minimal.

### Build Script (`build.rs`)

Embed git hash and build metadata at compile time:

```rust
// build.rs
fn main() {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .expect("git");
    let hash = String::from_utf8(output.stdout).unwrap();
    println!("cargo:rustc-env=GIT_HASH={}", hash.trim());
    // Rerun only when HEAD changes
    println!("cargo:rerun-if-changed=.git/HEAD");
}
```

Access in code: `env!("GIT_HASH")`.

---

## 2. CLI Framework (clap v4)

**Crate:** `clap = { version = "4", features = ["derive", "env"] }`

### Derive API

Always prefer derive over builder. Doc comments become help text automatically.

```rust
use clap::{Parser, Subcommand, Args, ValueEnum};

/// Orchestrate CLI - run agent workflows
#[derive(Parser)]
#[command(version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    #[command(flatten)]
    global: GlobalOpts,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Args)]
struct GlobalOpts {
    /// Enable verbose output
    #[arg(short, long, global = true)]
    verbose: bool,

    /// Output format
    #[arg(long, global = true, default_value = "text")]
    format: OutputFormat,

    /// Config file path
    #[arg(long, env = "ORCH_CONFIG")]
    config: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Commands {
    /// Run an agent with a skill
    Run(RunArgs),
    /// List available skills
    List,
}

#[derive(Args)]
struct RunArgs {
    /// Skill to execute
    skill: String,

    /// Model override
    #[arg(short, long, env = "ORCH_MODEL")]
    model: Option<String>,

    /// Extra arguments passed through to the agent
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    extra: Vec<String>,
}

#[derive(Copy, Clone, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
    Jsonl,
}
```

### Key Patterns

- **`#[command(flatten)]`** — share global opts across subcommands without repetition.
- **`#[arg(env = "VAR")]`** — auto-reads env var as fallback; shown in `--help`.
- **`#[arg(value_enum)]`** — restricts to enum variants with automatic validation.
- **`#[command(version)]`** — pulls version from `Cargo.toml` automatically.
- **`trailing_var_arg = true`** — capture everything after `--` for passthrough.
- **Doc comments** on variants/fields become help text. First line = short help, subsequent lines = long help (shown with `--help` but not `-h`).

---

## 3. Error Handling

### Application Code (Binaries)

**Crate:** `anyhow = "1"`

```rust
use anyhow::{Context, Result, bail};

fn load_config(path: &Path) -> Result<Config> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read config: {}", path.display()))?;
    let config: Config = serde_json::from_str(&content)
        .context("invalid config JSON")?;
    if config.skills.is_empty() {
        bail!("config must define at least one skill");
    }
    Ok(config)
}
```

### Library Code

**Crate:** `thiserror = "2"`

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum OrchestrateError {
    #[error("skill not found: {0}")]
    SkillNotFound(String),
    #[error("agent process exited with code {code}")]
    AgentFailed { code: i32 },
    #[error("template error: {0}")]
    Template(#[from] minijinja::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
```

### Rich Diagnostics (Alternative)

**Crate:** `miette = { version = "7", features = ["fancy"] }` -- provides source spans, labels, and suggestions. Heavier than anyhow; use when error quality is a feature (linters, compilers).

### Exit Codes

```rust
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}"); // anyhow's alternate Display shows chain
            ExitCode::from(1)
        }
    }
}
```

Semantic codes: `0` = success, `1` = general error, `2` = usage error, `130` = interrupted (SIGINT convention).

**Rule:** never `panic!()` or `unwrap()` in production paths. Use `expect("reason")` only for invariants that are genuinely impossible to violate (e.g., regex compilation of a literal).

---

## 4. Output and Formatting

### Terminal Colors

**Crate:** `owo-colors = "4"` (zero-alloc, respects `NO_COLOR` with feature flag)

```toml
owo-colors = { version = "4", features = ["supports-colors"] }
```

```rust
use owo_colors::OwoColorize;

eprintln!("{} {}", "error:".red().bold(), msg);
eprintln!("{} {}", "hint:".cyan(), suggestion);
```

**Alternative:** `yansi = "1"` -- similar philosophy, slightly different API.

**Avoid:** `colored` (heavier, global mutex for color detection).

### Respect `NO_COLOR`

Convention from <https://no-color.org/>. With `owo-colors`, enable `supports-colors` feature and use `if_supports_color()`. Or check manually:

```rust
fn colors_enabled() -> bool {
    std::env::var_os("NO_COLOR").is_none() && atty::is(atty::Stream::Stderr)
}
```

**Crate for TTY detection:** `is-terminal = "0.4"` (successor to `atty`).

### Tabular Output

**Crate:** `comfy-table = "7"`

```rust
use comfy_table::{Table, presets::UTF8_FULL_CONDENSED};

let mut table = Table::new();
table.load_preset(UTF8_FULL_CONDENSED);
table.set_header(vec!["Skill", "Status", "Model"]);
table.add_row(vec!["research", "ready", "opus"]);
println!("{table}");
```

### Progress Indicators

**Crate:** `indicatif = "0.17"`

```rust
use indicatif::{ProgressBar, ProgressStyle};

let pb = ProgressBar::new_spinner();
pb.set_style(ProgressStyle::default_spinner()
    .template("{spinner:.cyan} {msg}")
    .unwrap());
pb.set_message("Running agent...");
// ... do work ...
pb.finish_with_message("Done");
```

### stdout vs stderr

- **stdout** = data (piped to other tools, redirected to files).
- **stderr** = diagnostics, progress, errors (visible to humans).

All status messages, spinners, and color output go to stderr. Machine-readable output (JSON, JSONL) goes to stdout.

### JSON Output Mode

```rust
if matches!(opts.format, OutputFormat::Json) {
    serde_json::to_writer(std::io::stdout(), &result)?;
    println!(); // trailing newline
} else {
    println!("{}", format_human_readable(&result));
}
```

---

## 5. Process Spawning

### Simple (sync)

```rust
use std::process::Command;

let status = Command::new("claude")
    .args(["--model", model, "--print"])
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::inherit()) // pass through to terminal
    .status()?;

if !status.success() {
    bail!("claude exited with {}", status.code().unwrap_or(-1));
}
```

### Async with Streaming

```rust
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};

let mut child = Command::new("claude")
    .args(["--print", "--output-format", "stream-json"])
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()?;

let stdout = child.stdout.take().unwrap();
let mut lines = BufReader::new(stdout).lines();

while let Some(line) = lines.next_line().await? {
    let event: StreamEvent = serde_json::from_str(&line)?;
    handle_event(event)?;
}

let status = child.wait().await?;
```

### PID Tracking and Signal Forwarding

```rust
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;

let child_pid = child.id().expect("child has pid");

// Forward SIGTERM to child on shutdown
tokio::spawn(async move {
    tokio::signal::ctrl_c().await.ok();
    signal::kill(Pid::from_raw(child_pid as i32), Signal::SIGTERM).ok();
});
```

### CLI Discovery

**Crate:** `which = "7"`

```rust
let claude_path = which::which("claude")
    .context("claude CLI not found in PATH")?;
```

### Graceful Shutdown

```rust
use tokio::select;

select! {
    status = child.wait() => {
        // Process exited normally
        handle_exit(status?);
    }
    _ = tokio::signal::ctrl_c() => {
        // SIGINT received, kill child and clean up
        child.kill().await.ok();
        eprintln!("\nInterrupted");
        std::process::exit(130);
    }
}
```

---

## 6. File I/O and Serialization

### JSON

**Crates:** `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`

```rust
#[derive(Serialize, Deserialize)]
struct AgentResult {
    model: String,
    tokens_used: u64,
    output: String,
}

// Write
let file = std::fs::File::create(path)?;
serde_json::to_writer_pretty(file, &result)?;

// Read
let file = std::fs::File::open(path)?;
let result: AgentResult = serde_json::from_reader(file)?;
```

### JSONL (streaming, line-delimited)

Never slurp the whole file. Process line by line:

```rust
use std::io::{BufRead, BufReader};

let file = std::fs::File::open("events.jsonl")?;
for line in BufReader::new(file).lines() {
    let line = line?;
    if line.trim().is_empty() { continue; }
    let event: Event = serde_json::from_str(&line)
        .with_context(|| format!("bad JSONL line: {line}"))?;
    process(event)?;
}
```

### YAML

**Crate:** `serde_yaml = "0.9"` (or `serde_yml = "0.0.12"` as its successor)

```rust
// Parse YAML frontmatter from a markdown file
fn parse_frontmatter<T: DeserializeOwned>(content: &str) -> Result<(T, &str)> {
    let content = content.strip_prefix("---\n")
        .context("missing frontmatter delimiter")?;
    let end = content.find("\n---\n")
        .context("missing closing frontmatter delimiter")?;
    let meta: T = serde_yaml::from_str(&content[..end])?;
    let body = &content[end + 5..]; // skip \n---\n
    Ok((meta, body))
}
```

### Atomic File Writes

Write to a temp file in the same directory, then rename. This prevents partial writes on crash:

```rust
use tempfile::NamedTempFile;

fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let dir = path.parent().context("no parent dir")?;
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(data)?;
    tmp.persist(path)
        .map_err(|e| e.error)
        .context("atomic rename failed")?;
    Ok(())
}
```

**Crate:** `tempfile = "3"`

### File Locking

**Crate:** `fd-lock = "4"` (cross-platform advisory locks)

```rust
use fd_lock::RwLock;

let file = std::fs::File::create(lock_path)?;
let mut lock = RwLock::new(file);
let _guard = lock.write().context("failed to acquire lock")?;
// ... do exclusive work ...
// lock released on drop
```

---

## 7. SQLite (State Management)

**Crate:** `rusqlite = { version = "0.32", features = ["bundled"] }`

The `bundled` feature compiles SQLite from source -- no system dependency needed.

### Connection Setup

```rust
use rusqlite::Connection;

fn open_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;     // concurrent readers
    conn.pragma_update(None, "busy_timeout", 5000)?;       // 5s retry on lock
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;    // safe with WAL
    run_migrations(&conn)?;
    Ok(conn)
}
```

### Embedded Migrations

Simple version-table approach (no extra crate needed):

```rust
const MIGRATIONS: &[&str] = &[
    // v1: initial schema
    "CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        skill TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'running'
    );",
    // v2: add output column
    "ALTER TABLE runs ADD COLUMN output TEXT;",
];

fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);"
    )?;
    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let ver = (i + 1) as i64;
        if ver > current {
            conn.execute_batch(sql)?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [ver])?;
        }
    }
    Ok(())
}
```

### Connection Pooling

For CLI tools, a single connection is usually fine. If you need pooling (multi-threaded server mode):

**Crate:** `r2d2 = "0.8"`, `r2d2_sqlite = "0.25"`

---

## 8. Template Engine

### minijinja (recommended)

**Crate:** `minijinja = "2"`

Lightweight Jinja2-compatible engine. Ideal for prompt composition.

```rust
use minijinja::Environment;

let mut env = Environment::new();
env.add_template("prompt", include_str!("../templates/research.j2"))?;

let tmpl = env.get_template("prompt")?;
let rendered = tmpl.render(minijinja::context! {
    skill_name => "research",
    query => user_query,
    context => file_contents,
})?;
```

Template file (`research.j2`):

```jinja
You are a research agent using the {{ skill_name }} skill.

## Task
{{ query }}

{% if context %}
## Context
{{ context }}
{% endif %}
```

### tera (alternative)

**Crate:** `tera = "1"` -- heavier, supports template inheritance, more filters. Use if you need Django-style template hierarchies.

---

## 9. Testing

### CLI Integration Tests

**Crate:** `assert_cmd = "2"`

```rust
// tests/cli_tests.rs
use assert_cmd::Command;

#[test]
fn test_list_skills() {
    Command::cargo_bin("orch")
        .unwrap()
        .arg("list")
        .assert()
        .success()
        .stdout(predicates::str::contains("research"));
}

#[test]
fn test_missing_skill_fails() {
    Command::cargo_bin("orch")
        .unwrap()
        .args(["run", "nonexistent"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("skill not found"));
}
```

### Snapshot Testing

**Crate:** `insta = { version = "1", features = ["yaml"] }`

```rust
#[test]
fn test_help_output() {
    let output = Command::cargo_bin("orch")
        .unwrap()
        .arg("--help")
        .output()
        .unwrap();
    insta::assert_snapshot!(String::from_utf8_lossy(&output.stdout));
}
```

Run `cargo insta review` to accept/reject snapshot changes interactively.

### Isolated Test Directories

```rust
use tempfile::TempDir;

#[test]
fn test_init_creates_config() {
    let dir = TempDir::new().unwrap();
    Command::cargo_bin("orch")
        .unwrap()
        .args(["init"])
        .current_dir(dir.path())
        .assert()
        .success();
    assert!(dir.path().join("orch.toml").exists());
}
```

### Trait-Based Mocking

**Crate:** `mockall = "0.13"`

```rust
#[cfg_attr(test, mockall::automock)]
trait AgentRunner {
    fn run(&self, skill: &str, model: &str) -> Result<AgentOutput>;
}
```

### Organization

- Unit tests: `#[cfg(test)] mod tests { ... }` in each module.
- Integration tests: `tests/` directory at crate root.
- Test fixtures: `tests/fixtures/` for sample files.
- Use `#[test_case]` from `test-case = "3"` for parameterized tests.

---

## 10. Distribution

### Static Linking (Linux)

```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

### Cross-Compilation

**Crate/tool:** `cross` (Docker-based cross-compilation)

```bash
cargo install cross
cross build --release --target aarch64-unknown-linux-musl
```

### Binary Size Optimization

```toml
# Cargo.toml
[profile.release]
opt-level = "z"     # optimize for size
lto = true          # link-time optimization
codegen-units = 1   # slower compile, better optimization
strip = true        # strip debug symbols
panic = "abort"     # smaller than unwind
```

### Shell Completions

**Crate:** `clap_complete = "4"`

```rust
// src/commands/completions.rs
use clap::CommandFactory;
use clap_complete::{generate, Shell};

pub fn generate_completions(shell: Shell) {
    let mut cmd = Cli::command();
    generate(shell, &mut cmd, "orch", &mut std::io::stdout());
}
```

Usage: `orch completions bash > /etc/bash_completion.d/orch`

### GitHub Actions Release Pattern

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ["v*"]

jobs:
  release:
    strategy:
      matrix:
        include:
          - target: x86_64-unknown-linux-musl
            os: ubuntu-latest
          - target: aarch64-apple-darwin
            os: macos-latest
          - target: x86_64-pc-windows-msvc
            os: windows-latest
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - run: cargo build --release --target ${{ matrix.target }}
      - uses: softprops/action-gh-release@v2
        with:
          files: target/${{ matrix.target }}/release/orch*
```

---

## 11. Conventions from Successful CLI Tools

Patterns observed in ripgrep, bat, fd, zoxide, delta, starship:

### Config File Discovery

Follow XDG Base Directory spec:

```rust
fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("ORCH_CONFIG") {
        return PathBuf::from(p);
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").expect("HOME not set");
            PathBuf::from(home).join(".config")
        });
    base.join("orch").join("config.toml")
}
```

Precedence: explicit flag > env var > XDG path > project-local file.

### Progressive Disclosure

- Simple defaults that work out of the box.
- `-v` / `--verbose` adds detail.
- `--debug` for full trace output.
- Power-user flags hidden from short help (`#[arg(hide = true)]` or shown only in `--help`, not `-h`).
- `#[arg(long, hide_short_help = true)]` for advanced options.

### `--help` as Documentation

- Short help (`-h`): fits in a terminal, one line per flag.
- Long help (`--help`): full descriptions with examples.
- Add examples via `#[command(after_help = "EXAMPLES:\n  orch run research ...")]`.

### Shell Integration

zoxide pattern for shell hooks:

```rust
#[derive(Subcommand)]
enum Commands {
    /// Generate shell integration script
    Init {
        #[arg(value_enum)]
        shell: Shell,
    },
}
```

### Other Conventions

- **Pager support**: pipe long output through `$PAGER` (bat, delta do this).
- **Respect `TERM=dumb`**: disable colors and fancy output.
- **Symlink-friendly**: resolve `argv[0]` for multi-call binaries.
- **Exit silently on SIGPIPE**: prevents "broken pipe" errors when piped to `head`.

```rust
// In main(), before anything else (Unix only):
#[cfg(unix)]
{
    // Reset SIGPIPE to default behavior (terminate silently)
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL); }
}
```

---

## 12. Async Considerations

### When to Use Async

**Use async when:**
- Spawning multiple child processes concurrently.
- Streaming stdout/stderr from processes.
- Making HTTP requests (LLM API calls).
- Waiting on signals + process completion simultaneously (`select!`).

**Stay sync when:**
- Simple file I/O with no concurrency needs.
- Pure computation (parsing, template rendering).
- Sequential single-process execution.

Many CLIs are fine fully synchronous. Add tokio only when you need concurrent I/O.

### Runtime Setup

**Crate:** `tokio = { version = "1", features = ["rt-multi-thread", "macros", "process", "signal", "io-util"] }`

Minimal feature set -- do not use `features = ["full"]` in production; enable only what you need.

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cli::run().await
}
```

For more control (e.g., single-threaded runtime for simpler CLI):

```rust
fn main() -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(cli::run())
}
```

### Avoid Async in Computation

Do not `.await` in tight loops or CPU-bound code. Use `tokio::task::spawn_blocking` for heavy computation:

```rust
let result = tokio::task::spawn_blocking(move || {
    expensive_template_render(&data)
}).await??;
```

---

## Quick Dependency Reference

| Purpose | Crate | Version |
|---|---|---|
| CLI parsing | `clap` (derive, env) | 4 |
| App errors | `anyhow` | 1 |
| Lib errors | `thiserror` | 2 |
| Serialization | `serde`, `serde_json` | 1 |
| YAML | `serde_yaml` | 0.9 |
| Colors | `owo-colors` | 4 |
| Tables | `comfy-table` | 7 |
| Progress | `indicatif` | 0.17 |
| TTY detection | `is-terminal` | 0.4 |
| Async runtime | `tokio` | 1 |
| Templates | `minijinja` | 2 |
| SQLite | `rusqlite` (bundled) | 0.32 |
| Temp files | `tempfile` | 3 |
| File locking | `fd-lock` | 4 |
| CLI testing | `assert_cmd` | 2 |
| Snapshots | `insta` | 1 |
| Mocking | `mockall` | 0.13 |
| CLI discovery | `which` | 7 |
| Completions | `clap_complete` | 4 |
| Cross-compile | `cross` (tool) | 0.2 |
