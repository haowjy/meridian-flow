from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Select, Footer, Button, Label, Input, Checkbox
from textual.containers import Container, Vertical
from textual.binding import Binding
from textual.validation import Integer
from ..widgets import FormSelect


PROVIDER_OPTIONS: list[tuple[str, str]] = [
    ("Anthropic", "anthropic"),
    ("OpenAI", "openai"),
    ("Lorem (test)", "lorem"),
]

MODEL_OPTIONS_BY_PROVIDER: dict[str, list[tuple[str, str]]] = {
    "anthropic": [
        ("Claude Haiku 4.5", "claude-haiku-4-5"),
        ("Claude Sonnet 4.5", "claude-sonnet-4-5"),
    ],
    "openai": [
        ("GPT-4o", "gpt-4o"),
        ("GPT-4o mini", "gpt-4o-mini"),
        ("o1-preview", "o1-preview"),
        ("o1-mini", "o1-mini"),
    ],
    "lorem": [
        ("Lorem Slow", "lorem-slow"),
        ("Lorem Fast", "lorem-fast"),
        ("Lorem Medium", "lorem-medium"),
    ],
}

DEFAULT_PROVIDER = "lorem"


class ParamsEditorScreen(Screen):
    """Parameter editor with multiple choice menus (no free text)."""

    BINDINGS = [
        Binding("up", "focus_previous", "Prev Field", show=False),
        Binding("down", "focus_next", "Next Field", show=False),
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        # Get current params from app
        params = self.app.current_params

        provider_value = params.get("provider", DEFAULT_PROVIDER)
        provider_values = {value for _, value in PROVIDER_OPTIONS}
        if provider_value not in provider_values:
            provider_value = DEFAULT_PROVIDER

        model_value = params.get("model")
        model_options = MODEL_OPTIONS_BY_PROVIDER.get(provider_value, [])
        model_values = {value for _, value in model_options}
        if model_value not in model_values:
            # Fallback to first model for the selected provider
            model_value = model_options[0][1] if model_options else None

        yield Container(
            Vertical(
                Label("Edit Parameters", classes="screen-title"),
                # Provider selection
                Label("Provider:", classes="field-label"),
                FormSelect(
                    options=PROVIDER_OPTIONS,
                    value=provider_value,
                    id="provider-select",
                ),
                # Model selection
                Label("Model:", classes="field-label"),
                FormSelect(
                    options=model_options,
                    value=model_value,
                    id="model-select",
                ),
                # Temperature selection
                Label("Temperature:", classes="field-label"),
                FormSelect(
                    options=[
                        ("0.0", "0.0"),
                        ("0.5", "0.5"),
                        ("1.0", "1.0"),
                    ],
                    value=str(params.get("temperature", 1.0)),
                    id="temperature-select",
                ),
                # Max tokens input
                Label("Max Tokens:", classes="field-label"),
                Input(
                    value=str(params.get("max_tokens", 128)),
                    id="max-tokens-input",
                    validators=[Integer()],
                ),
                # Thinking enabled checkbox
                Checkbox(
                    "Enable 'thinking' stream",
                    value=params.get("thinking_enabled", True),
                    id="thinking-enabled-checkbox",
                ),
                # Buttons
                Container(
                    Button("Save [Enter]", variant="primary", id="save"),
                    Button("Cancel [ESC]", variant="default", id="cancel"),
                    classes="button-row",
                ),
                id="params-editor",
            ),
        )
        yield Footer()

    def on_mount(self) -> None:
        # Start with the provider dropdown focused for keyboard navigation
        self.query_one("#provider-select", Select).focus()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "provider-select":
            self._update_model_options(event.value)

    def _update_model_options(self, provider: str) -> None:
        model_select = self.query_one("#model-select", Select)
        options = MODEL_OPTIONS_BY_PROVIDER.get(provider, [])
        if not options:
            model_select.set_options([])
            return

        model_select.set_options(options)
        model_select.value = options[0][1]

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save":
            self.action_save()
        elif event.button.id == "cancel":
            self.action_cancel()

    def action_focus_next(self) -> None:
        """↓ key: Move focus to next field."""
        self.screen.focus_next()

    def action_focus_previous(self) -> None:
        """↑ key: Move focus to previous field."""
        self.screen.focus_previous()

    def action_save(self) -> None:
        """[Enter] key: Save params and return."""
        # Extract values from widgets
        try:
            max_tokens = int(self.query_one("#max-tokens-input", Input).value)
        except (ValueError, TypeError):
            self.app.notify(
                "Invalid value for Max Tokens. Must be an integer.",
                severity="error",
            )
            return

        params = {
            "provider": self.query_one("#provider-select", Select).value,
            "model": self.query_one("#model-select", Select).value,
            "temperature": float(
                self.query_one("#temperature-select", Select).value
            ),
            "max_tokens": max_tokens,
            "thinking_enabled": self.query_one(
                "#thinking-enabled-checkbox", Checkbox
            ).value,
        }

        # Return params via dismiss callback
        self.dismiss(params)

    def action_cancel(self) -> None:
        """[ESC] key: Cancel without saving."""
        self.dismiss(None)
