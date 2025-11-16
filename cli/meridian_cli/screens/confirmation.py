from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Static, Button, Footer
from textual.containers import Container, Vertical
from textual.binding import Binding


class ConfirmationScreen(Screen):
    """Message confirmation screen before submission"""

    BINDINGS = [
        Binding("p", "edit_params", "Edit Params"),
        Binding("up", "focus_previous", "Prev", show=False),
        Binding("down", "focus_next", "Next", show=False),
        Binding("left", "focus_previous", "Prev", show=False),
        Binding("right", "focus_next", "Next", show=False),
        Binding("enter", "submit", "Submit"),
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, message_content: str):
        super().__init__()
        self.message_content = message_content

    def compose(self) -> ComposeResult:
        yield Container(
            Vertical(
                Static("Message Preview:", classes="section-title"),
                Static(self.message_content, classes="preview-content"),
                Static("Parameters:", classes="section-title"),
                Static(id="params-display", classes="params-content"),
                Container(
                    Button("Submit [Enter]", variant="primary", id="submit"),
                    Button("Edit Params [p]", variant="default", id="edit-params"),
                    Button("Cancel [ESC]", variant="default", id="cancel"),
                    classes="button-row",
                ),
                id="confirmation-dialog",
            ),
        )
        yield Footer()

    def on_mount(self) -> None:
        """Render current params"""
        self.update_params_display()
        # Start keyboard focus on the primary action
        self.query_one("#submit", Button).focus()

    def update_params_display(self) -> None:
        """Format and display current parameters"""
        params = self.app.current_params
        lines = [
            f"Provider: {params.get('provider', 'N/A')}",
            f"Model: {params.get('model', 'N/A')}",
            f"Temperature: {params.get('temperature', 'N/A')}",
            f"Max Tokens: {params.get('max_tokens', 'N/A')}",
            f"Thinking Enabled: {params.get('thinking_enabled', False)}",
        ]
        self.query_one("#params-display", Static).update("\n".join(lines))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "submit":
            self.action_submit()
        elif event.button.id == "edit-params":
            self.action_edit_params()
        elif event.button.id == "cancel":
            self.action_cancel()

    def action_focus_next(self) -> None:
        """Arrow key: move focus to next button"""
        self.screen.focus_next()

    def action_focus_previous(self) -> None:
        """Arrow key: move focus to previous button"""
        self.screen.focus_previous()

    def action_edit_params(self) -> None:
        """[p] key: Edit params"""
        from .params_editor import ParamsEditorScreen

        def on_params_updated(params: dict | None) -> None:
            if params:
                self.app.current_params = params
                self.update_params_display()

        self.app.push_screen(ParamsEditorScreen(), on_params_updated)

    def action_submit(self) -> None:
        """[Enter] key: Confirm and submit"""
        self.dismiss(True)

    def action_cancel(self) -> None:
        """[ESC] key: Cancel submission"""
        self.dismiss(False)
