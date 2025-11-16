"""Streaming screen for displaying real-time LLM responses"""

import asyncio
import logging
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import RichLog, Static, Footer
from textual.containers import Container
from textual.binding import Binding
from rich.text import Text
from ..models import Turn

logger = logging.getLogger("meridian_cli.screens.streaming")


class StreamingScreen(Screen[str | None]):
    """Dedicated screen for streaming LLM responses

    Shows user message in input box (read-only) and streams
    assistant response in display box. Auto-closes when complete.

    Returns assistant_turn_id on success, None on cancellation.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("ctrl+c", "cancel", "Cancel", show=False),
    ]

    def __init__(self, user_turn: Turn, assistant_turn: Turn):
        super().__init__()
        self.user_turn = user_turn
        self.assistant_turn = assistant_turn

    def compose(self) -> ComposeResult:
        yield Container(
            RichLog(id="user-message-box", wrap=True, markup=True),
            Static(id="streaming-box"),
            id="streaming-container",
        )
        yield Footer()

    async def on_mount(self) -> None:
        """Start streaming when screen is mounted"""
        logger.info(f"StreamingScreen mounted for assistant turn: {self.assistant_turn.id}")
        logger.debug(f"User turn ID: {self.user_turn.id}")
        logger.debug(f"User turn has sibling_ids: {hasattr(self.user_turn, 'sibling_ids')}")
        logger.debug(f"User turn has blocks: {hasattr(self.user_turn, 'blocks')}")
        if hasattr(self.user_turn, 'blocks'):
            logger.debug(f"User turn blocks count: {len(self.user_turn.blocks) if self.user_turn.blocks else 0}")

        # Display user message in top box (formatted like turn_browser)
        user_box = self.query_one("#user-message-box", RichLog)
        user_box.clear()

        # Metadata
        turn_id_short = self.user_turn.id[:8]
        user_box.write(f"[bold cyan]Turn ID:[/bold cyan] {turn_id_short}")
        user_box.write(f"[bold cyan]Role:[/bold cyan] {self.user_turn.role}")
        user_box.write(f"[bold cyan]Status:[/bold cyan] {self.user_turn.status}")

        if self.user_turn.model:
            user_box.write(f"[bold cyan]Model:[/bold cyan] {self.user_turn.model}")

        if self.user_turn.error:
            user_box.write(f"[red]Error:[/red] {self.user_turn.error}")

        # Sibling info (if applicable)
        if hasattr(self.user_turn, 'sibling_ids') and self.user_turn.sibling_ids and len(self.user_turn.sibling_ids) > 1:
            idx = self.user_turn.sibling_index
            total = len(self.user_turn.sibling_ids)
            user_box.write(f"[dim]Sibling {idx + 1} of {total}[/dim]")

        user_box.write("")  # Blank line

        # Content blocks
        if hasattr(self.user_turn, 'blocks') and self.user_turn.blocks:
            for block in self.user_turn.blocks:
                if block.block_type == "thinking":
                    user_box.write("[dim][thinking][/dim]")
                    if block.text_content:
                        user_box.write(block.text_content)
                    user_box.write("")
                elif block.block_type == "text":
                    user_box.write("[dim][text][/dim]")
                    if block.text_content:
                        user_box.write(block.text_content)
                    user_box.write("")
                else:
                    # Other block types
                    user_box.write(f"[dim][{block.block_type}][/dim]")
                    user_box.write("")

        # Start streaming in bottom box (run in background to avoid blocking UI)
        self.run_worker(self.start_streaming())

    async def start_streaming(self) -> None:
        """Stream assistant response with block labels"""
        logger.info(f"Starting streaming for assistant turn: {self.assistant_turn.id}")

        try:
            # Bottom box shows streaming content
            display = self.query_one("#streaming-box", Static)

            # Accumulate all content in Text object for real-time streaming
            content = Text()

            # Track current block type
            current_block_type: str | None = None

            # Start SSE stream
            event_count = 0
            async for event in self.app.api_client.stream_turn(self.assistant_turn.id):
                event_count += 1
                event_type = event.get("event")
                data = event.get("data", {})

                if event_type == "block_start":
                    # New block starting - show label
                    block_type = data.get("block_type")
                    logger.debug(f"Block started: {block_type}")

                    if block_type != current_block_type:
                        current_block_type = block_type

                        # Append block label to content
                        if block_type:
                            if block_type == "thinking":
                                content.append("[thinking]\n", style="dim")
                            elif block_type == "text":
                                content.append("[text]\n", style="dim")
                            else:
                                # Other/unknown block types (tool_use, image, etc.)
                                content.append(f"[{block_type}]\n", style="dim")

                        # Update display with accumulated content
                        display.update(content)

                elif event_type == "block_delta":
                    # Content delta - append text / JSON depending on delta type
                    delta_type = data.get("delta_type")

                    # Some backends may include block_type on deltas instead of a separate block_start
                    block_type = data.get("block_type")
                    if block_type and block_type != current_block_type:
                        current_block_type = block_type
                        if block_type == "thinking":
                            content.append("[thinking]\n", style="dim")
                        elif block_type == "text":
                            content.append("[text]\n", style="dim")
                        else:
                            content.append(f"[{block_type}]\n", style="dim")
                        display.update(content)

                    # Text-like deltas (regular text and thinking text)
                    if delta_type in ["text_delta", "thinking_delta"]:
                        text = data.get("text_delta", "")
                        if text and current_block_type in ["thinking", "text"]:
                            content.append(text)
                            display.update(content)

                    # Tool input JSON deltas (streamed tool arguments)
                    elif delta_type == "input_json_delta":
                        json_delta = data.get("input_json_delta", "")
                        if json_delta and current_block_type in ["tool_use", "tool_result"]:
                            content.append(json_delta)
                            display.update(content)
                    else:
                        # Other delta types (usage, signatures, etc.) are not rendered yet
                        logger.debug(f"Ignoring unsupported block_delta type: {delta_type}")

                elif event_type == "turn_complete":
                    # Turn finished
                    logger.debug("Turn completed")

            logger.info(f"Streaming completed successfully - processed {event_count} events")

            # Warn if no events received
            if event_count == 0:
                content.append("\n[yellow]Warning: No events received from stream[/yellow]", style="yellow")
                display.update(content)
                await asyncio.sleep(2)

            # Dismiss with assistant_turn_id to navigate to it
            self.dismiss(self.assistant_turn.id)

        except Exception as e:
            logger.error(f"Streaming error: {e}", exc_info=True)

            # Try to display error in UI (widget might not exist if error occurred during mount)
            try:
                display = self.query_one("#streaming-box", Static)
                error_content = Text()
                error_content.append("\nStreaming Error:\n", style="bold red")
                error_content.append(f"{type(e).__name__}: {e}\n", style="red")
                error_content.append("\nCheck logs for details", style="dim")
                display.update(error_content)
            except Exception as display_error:
                # Widget doesn't exist yet - just log
                logger.error(f"Failed to display error in UI (widget not mounted): {display_error}")

            self.app.notify(f"Streaming error: {e}", severity="error", markup=False)

            # Wait 3 seconds before closing so user can see error
            await asyncio.sleep(3)
            self.dismiss(None)

    async def action_cancel(self) -> None:
        """Cancel streaming and close screen"""
        logger.info(f"Cancelling streaming for turn: {self.assistant_turn.id}")

        try:
            # Call interrupt API endpoint
            await self.app.api_client.interrupt_turn(self.assistant_turn.id)

            logger.debug("Streaming cancelled successfully")
            self.app.notify("Streaming cancelled", severity="information")

            # Dismiss with None to indicate cancellation
            self.dismiss(None)

        except Exception as e:
            logger.error(f"Error cancelling stream: {e}", exc_info=True)
            self.app.notify(f"Error cancelling stream: {e}", severity="error", markup=False)

            # Still close screen on error
            self.dismiss(None)
