# Meridian CLI

Terminal UI for browsing and interacting with Meridian chat conversations.

## Features

- Browse projects and chats
- Navigate conversation trees with arrow keys
- View turn content with block labels (thinking, text)
- Create new messages with LLM streaming
- Edit LLM parameters (model, temperature, etc.)
- Real-time streaming with layout swap

## Installation

### Using uv (recommended)

```bash
# Install dependencies
uv sync

# Run the app
uv run meridian-cli
```

### Using pip

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install textual httpx pydantic

# Run the app
python -m meridian_cli
```

## Configuration

Set the backend URL via environment variable:

```bash
export MERIDIAN_BASE_URL=http://localhost:8080
uv run meridian-cli
```

Default: `http://localhost:8080`

## Usage

### Navigation

**Project/Chat Lists:**
- `↑/↓` - Navigate list
- `Enter` - Select item
- `n` - Create new project/chat
- `q` - Quit

**Turn Browser:**
- `↑` - Navigate to parent turn
- `↓` - Navigate to child turn (first child)
- `←` - Navigate to previous sibling
- `→` - Navigate to next sibling
- `Tab` - Switch focus between display and input boxes
- `p` - Edit LLM parameters
- `Enter` - Submit message (shows confirmation screen)
- `ESC` - Cancel streaming / Go back
- `q` - Quit

**Confirmation Screen:**
- `←/→` - Move between buttons
- `↑/↓` - Move between buttons
- `Enter` - Submit message
- `p` - Edit parameters
- `ESC` - Cancel

**Params Editor:**
- `↑/↓` - Move between fields/options
- `Enter` - Open/select dropdown or activate button
- `ESC` - Cancel editor without saving

### Streaming

When you submit a message:
1. User message shrinks to top box (read-only)
2. Assistant response streams in large bottom box
3. Block labels appear: `[thinking]`, `[text]`
4. Press `ESC` to cancel streaming
5. On complete, response moves to top display box

## Project Structure

```
cli/
├── meridian_cli/
│   ├── __main__.py         # Entry point (python -m meridian_cli)
│   ├── app.py              # Main Textual application
│   ├── models.py           # Pydantic data models
│   ├── navigation.py       # Navigation state logic
│   ├── api_client.py       # HTTP client for Meridian API
│   ├── app.tcss            # Textual CSS styling
│   └── screens/
│       ├── project_list.py
│       ├── chat_list.py
│       ├── turn_browser.py
│       ├── confirmation.py
│       └── params_editor.py
├── pyproject.toml          # Python project config
├── go.mod                  # Unused (CLI is Python-only)
└── go.sum                  # Unused (CLI is Python-only)
```

## Development

### Dependencies

- **textual** (>=0.82.0) - TUI framework
- **httpx** (>=0.27.0) - Async HTTP client for SSE
- **pydantic** (>=2.9.0) - Type-safe data models

### Architecture

- **Models**: Pydantic models mirror backend API responses
- **Navigation**: `NavigationState` class handles arrow key logic using `sibling_ids`
- **Screens**: Each screen is a separate Textual `Screen` subclass
- **API Client**: Async methods using `httpx` for REST + SSE streaming
- **Reactive State**: Textual's reactive attributes for automatic UI updates

## Troubleshooting

**Connection refused:**
- Ensure backend is running on configured URL
- Check `MERIDIAN_BASE_URL` environment variable

**Streaming not working:**
- Verify `/api/turns/{id}/stream` endpoint is accessible
- Check backend logs for SSE errors

**Layout issues:**
- Terminal must support ANSI colors
- Minimum recommended terminal size: 80x24
