import asyncio
import logging
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import RichLog, Footer
from textual.reactive import reactive
from textual.containers import Container
from textual.binding import Binding
from ..navigation import NavigationState
from ..models import Turn, PaginatedTurnsResponse
from ..widgets import SubmittableTextArea

logger = logging.getLogger("meridian_cli.screens.turn_browser")


class TurnBrowserScreen(Screen):
    """Main turn browser with two-box layout and arrow key navigation"""

    BINDINGS = [
        Binding("w", "navigate_up", "W: ↑ Parent"),
        Binding("s", "navigate_down", "S: ↓ Child"),
        Binding("a", "navigate_left", "A: ← Prev Sibling"),
        Binding("d", "navigate_right", "D: → Next Sibling"),
        Binding("p", "edit_params", "Params"),
        Binding("tab", "focus_next", "Switch Focus", show=False),
        Binding("escape", "go_back", "Back"),
    ]

    # Reactive state
    current_turn: reactive[Turn | None] = reactive(None)
    nav_state: reactive[NavigationState | None] = reactive(None)

    def __init__(self):
        super().__init__()
        self.chat_id = None
        self._navigation_task: asyncio.Task | None = None

    def compose(self) -> ComposeResult:
        yield Container(
            RichLog(id="display-box", wrap=True, markup=True),
            SubmittableTextArea(id="input-box"),
            id="turn-browser",
        )
        yield Footer()

    async def on_mount(self) -> None:
        """Initial load: GET /api/chats/{chat_id}/turns?limit=1&direction=after"""
        self.chat_id = self.app.current_chat_id
        logger.info(f"TurnBrowser mounted for chat_id={self.chat_id}")

        try:
            # Load first turn
            response = await self.app.api_client.get_turns(
                self.chat_id, limit=1, direction="after"
            )

            if response.turns:
                logger.debug(f"Loaded initial turn: {response.turns[0].id}")
                self.nav_state = NavigationState(response.turns[0], response)
                self.current_turn = response.turns[0]
                self.update_display()
            else:
                logger.debug("No turns in chat - showing empty state")
                display = self.query_one("#display-box", RichLog)
                display.write("[dim]No turns in this chat yet. Start typing below![/dim]")

            # Focus input box by default
            self.query_one("#input-box", SubmittableTextArea).focus()
        except Exception as e:
            logger.error(f"Error loading turns: {e}", exc_info=True)
            self.app.notify(f"Error loading turns: {e}", severity="error", markup=False)

    def watch_current_turn(self, turn: Turn | None) -> None:
        """Reactive: Update display when current_turn changes"""
        if turn:
            self.update_display()

            # Lock input if turn has error
            input_box = self.query_one("#input-box", SubmittableTextArea)
            if turn.error:
                input_box.disabled = True
                input_box.tooltip = f"Turn has error: {turn.error}"
            else:
                input_box.disabled = False
                input_box.tooltip = None

    def update_display(self) -> None:
        """Render current turn in display box"""
        display = self.query_one("#display-box", RichLog)
        display.clear()

        if not self.current_turn:
            return

        # Render turn metadata
        turn_id_short = self.current_turn.id[:8]
        display.write(f"[bold cyan]Turn ID:[/bold cyan] {turn_id_short}")
        display.write(f"[bold cyan]Role:[/bold cyan] {self.current_turn.role}")
        display.write(f"[bold cyan]Status:[/bold cyan] {self.current_turn.status}")

        if self.current_turn.model:
            display.write(f"[bold cyan]Model:[/bold cyan] {self.current_turn.model}")

        if self.current_turn.error:
            display.write(f"[red]Error:[/red] {self.current_turn.error}")

        # Render sibling info
        if self.current_turn.sibling_ids and len(self.current_turn.sibling_ids) > 1:
            idx = self.current_turn.sibling_index
            total = len(self.current_turn.sibling_ids)
            display.write(f"[dim]Sibling {idx + 1} of {total}[/dim]")

        # Navigation hints - always show all 4 directions (empty if unavailable)
        if self.nav_state:
            # Define labels with consistent padding
            up_label = "W: ↑ Parent"
            down_label = "S: ↓ Child"
            left_label = "A: ← Prev"
            right_label = "D: → Next"

            hints = []

            # A: Left (Prev Sibling)
            hints.append(left_label if self.nav_state.can_go_left else " " * len(left_label))

            # S: Down (Child)
            hints.append(down_label if self.nav_state.can_go_down else " " * len(down_label))

            # W: Up (Parent)
            hints.append(up_label if self.nav_state.can_go_up else " " * len(up_label))

            # D: Right (Next Sibling)
            hints.append(right_label if self.nav_state.can_go_right else " " * len(right_label))

            display.write(' | '.join(hints))

        display.write("")  # Blank line

        # Render content blocks
        for block in self.current_turn.blocks:
            if block.block_type == "thinking":
                display.write("[dim][thinking][/dim]")
                if block.text_content:
                    display.write(block.text_content)
                display.write("")
            elif block.block_type == "text":
                display.write("[dim][text][/dim]")
                if block.text_content:
                    display.write(block.text_content)
                display.write("")
            else:
                # Other block types
                display.write(f"[dim][{block.block_type}][/dim]")
                display.write("")

    async def navigate_to_turn(self, turn_id: str) -> None:
        """Fetch and display a specific turn (cancels any pending navigation)"""
        logger.debug(f"Navigating to turn: {turn_id}")
        # Cancel any pending navigation request
        if self._navigation_task and not self._navigation_task.done():
            logger.debug("Cancelling pending navigation task")
            self._navigation_task.cancel()
            try:
                await self._navigation_task
            except asyncio.CancelledError:
                pass  # Expected - we cancelled it

        # Create new task for this navigation
        self._navigation_task = asyncio.create_task(self._do_navigate(turn_id))

        # Await the task (so caller can handle exceptions)
        try:
            await self._navigation_task
        except asyncio.CancelledError:
            # This navigation was cancelled by a newer one - silent return
            logger.debug(f"Navigation to {turn_id} was cancelled")

    async def _do_navigate(self, turn_id: str) -> None:
        """Internal: Perform the actual navigation"""
        try:
            response = await self.app.api_client.get_turns(
                self.chat_id, from_turn_id=turn_id, limit=1, direction="after"
            )

            if response.turns:
                logger.debug(f"Navigation successful - displaying turn {response.turns[0].id}")
                self.nav_state = NavigationState(response.turns[0], response)
                self.current_turn = response.turns[0]
        except Exception as e:
            logger.error(f"Navigation error to turn {turn_id}: {e}", exc_info=True)
            self.app.notify(f"Navigation error: {e}", severity="error", markup=False)

    # Arrow key navigation actions
    async def action_navigate_up(self) -> None:
        """↑ key: Navigate to parent"""
        if self.nav_state and self.nav_state.can_go_up and self.nav_state.prev_turn_id:
            logger.debug(f"Navigation up - moving to parent turn {self.nav_state.prev_turn_id}")
            await self.navigate_to_turn(self.nav_state.prev_turn_id)

    async def action_navigate_down(self) -> None:
        """↓ key: Navigate to child"""
        if self.nav_state and self.nav_state.can_go_down and self.nav_state.next_turn_id:
            logger.debug(f"Navigation down - moving to child turn {self.nav_state.next_turn_id}")
            await self.navigate_to_turn(self.nav_state.next_turn_id)

    async def action_navigate_left(self) -> None:
        """← key: Navigate to previous sibling"""
        if self.nav_state and self.nav_state.can_go_left and self.nav_state.prev_sibling_id:
            logger.debug(f"Navigation left - moving to prev sibling {self.nav_state.prev_sibling_id}")
            await self.navigate_to_turn(self.nav_state.prev_sibling_id)

    async def action_navigate_right(self) -> None:
        """→ key: Navigate to next sibling"""
        if self.nav_state and self.nav_state.can_go_right and self.nav_state.next_sibling_id:
            logger.debug(f"Navigation right - moving to next sibling {self.nav_state.next_sibling_id}")
            await self.navigate_to_turn(self.nav_state.next_sibling_id)

    def action_edit_params(self) -> None:
        """[p] key: Open params editor"""
        from .params_editor import ParamsEditorScreen

        def on_params_updated(params: dict | None) -> None:
            if params:
                self.app.current_params = params

        self.app.push_screen(ParamsEditorScreen(), on_params_updated)

    def action_focus_next(self) -> None:
        """Tab key: Switch focus between boxes"""
        self.screen.focus_next()

    def action_go_back(self) -> None:
        """ESC key: Go back to chat list"""
        self.app.pop_screen()

    def action_quit(self) -> None:
        """Quit the application"""
        self.app.exit()

    # Text input handling
    def on_submittable_text_area_submitted(
        self, message: SubmittableTextArea.Submitted
    ) -> None:
        """Handle Ctrl+Enter submission from SubmittableTextArea"""
        content = message.text.strip()
        if not content:
            return

        self._handle_submission(content)

    def action_submit_input(self) -> None:
        """Enter key: Submit message from input box"""
        input_box = self.query_one("#input-box", SubmittableTextArea)

        # Only submit if input box has focus
        if not input_box.has_focus:
            return

        content = input_box.text.strip()
        if not content:
            return

        self._handle_submission(content)

    def _handle_submission(self, content: str) -> None:
        """Common submission logic for both action and message handlers"""
        input_box = self.query_one("#input-box", SubmittableTextArea)

        # Show confirmation screen (lazy import to avoid circular dependency)
        from .confirmation import ConfirmationScreen

        def on_submit(should_submit: bool) -> None:
            if should_submit:
                self.app.call_later(self.submit_message, content)
                # Clear input box
                input_box.text = ""

        self.app.push_screen(ConfirmationScreen(content), on_submit)

    async def submit_message(self, content: str) -> None:
        """Create user turn and push streaming screen for assistant response"""
        logger.info(f"Submitting message (length={len(content)}, prev_turn={self.current_turn.id if self.current_turn else None})")
        try:
            # Create user turn (backend creates both user and assistant turns)
            prev_turn_id = self.current_turn.id if self.current_turn else None
            create_response = await self.app.api_client.create_turn(
                self.chat_id, prev_turn_id, content, self.app.current_params
            )

            logger.debug(f"Created turns - user: {create_response.user_turn.id}, assistant: {create_response.assistant_turn.id}")

            # Navigate to new user turn
            await self.navigate_to_turn(create_response.user_turn.id)

            # Push streaming screen for assistant response
            from .streaming import StreamingScreen

            def on_streaming_done(assistant_turn_id: str | None) -> None:
                """Reload assistant turn when streaming completes"""
                if assistant_turn_id:
                    self.app.call_later(self.navigate_to_turn, assistant_turn_id)

            self.app.push_screen(
                StreamingScreen(create_response.user_turn, create_response.assistant_turn),
                on_streaming_done
            )

        except Exception as e:
            logger.error(f"Error submitting message: {e}", exc_info=True)
            self.app.notify(f"Error submitting message: {e}", severity="error", markup=False)
