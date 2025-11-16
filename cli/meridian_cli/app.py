"""Meridian CLI - Main Textual application"""

import logging
from textual.app import App
from textual.binding import Binding
from .api_client import APIClient
from .screens import (
    ProjectListScreen,
    ChatListScreen,
    TurnBrowserScreen,
)

logger = logging.getLogger("meridian_cli.app")


class MeridianCLI(App):
    """Main Textual application for Meridian CLI"""

    CSS_PATH = "app.tcss"

    BINDINGS = [
        Binding("ctrl+c", "handle_ctrl_c", "Quit", show=False),
    ]

    SCREENS = {
        "project_list": ProjectListScreen,
        "chat_list": ChatListScreen,
        "turn_browser": TurnBrowserScreen,
        # ConfirmationScreen and ParamsEditorScreen are instantiated directly
        # since they require parameters
    }

    def __init__(self, base_url: str):
        super().__init__()
        self.base_url = base_url
        self.api_client = APIClient(base_url)

        # Global state
        self.current_project_id: str | None = None
        self.current_chat_id: str | None = None
        self.current_params = {
            "provider": "lorem",
            "model": "lorem-slow",
            "temperature": 1.0,
            "max_tokens": 4096,
            "thinking_enabled": True,
        }

        # Double Ctrl+C state
        self._ctrl_c_pressed_once = False
        self._ctrl_c_timer = None

        logger.debug(f"MeridianCLI initialized with base_url={base_url}")

    def on_mount(self) -> None:
        """Initialize app with project list screen"""
        logger.debug("App mounted - pushing project_list screen")
        self.push_screen("project_list")

    async def on_unmount(self) -> None:
        """Cleanup when app exits"""
        logger.info("App unmounting - cleaning up")
        await self.api_client.close()

    async def action_handle_ctrl_c(self) -> None:
        """Handle Ctrl+C with double-press-to-quit pattern"""
        # StreamingScreen handles its own Ctrl+C binding
        # Double-press logic
        if self._ctrl_c_pressed_once:
            # Second press within time window - quit
            logger.info("Ctrl+C pressed twice - exiting app")
            if self._ctrl_c_timer:
                self._ctrl_c_timer.stop()
            self.exit()
        else:
            # First press - start timer and show notification
            logger.debug("Ctrl+C pressed once - starting countdown")
            self._ctrl_c_pressed_once = True
            self.notify(
                "Press Ctrl+C again to quit",
                severity="information",
                timeout=2.0
            )

            # Set 2-second timer to reset the flag
            self._ctrl_c_timer = self.set_timer(
                2.0,
                callback=self._reset_ctrl_c
            )

    def _reset_ctrl_c(self) -> None:
        """Reset Ctrl+C state after timeout"""
        logger.debug("Ctrl+C countdown expired - resetting state")
        self._ctrl_c_pressed_once = False
        self._ctrl_c_timer = None
