import logging
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Header, Footer, ListView, ListItem, Label, Input, Button
from textual.containers import Container, Vertical
from textual.binding import Binding
from ..models import Thread

logger = logging.getLogger("meridian_cli.screens.thread_list")


class NewThreadDialog(Screen):
    """Modal dialog for creating a new thread"""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        yield Container(
            Vertical(
                Label("Create New Thread", classes="dialog-title"),
                Input(placeholder="Thread title...", id="thread-title"),
                Container(
                    Button("Create", variant="primary", id="create"),
                    Button("Cancel", id="cancel"),
                    classes="button-row",
                ),
                id="dialog",
            ),
        )

    def on_mount(self) -> None:
        self.query_one("#thread-title", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "create":
            title = self.query_one("#thread-title", Input).value.strip()
            if title:
                self.dismiss(title)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ThreadListScreen(Screen):
    """Thread selection/creation screen"""

    BINDINGS = [
        Binding("n", "new_thread", "New Thread"),
        Binding("escape", "back", "Back to Projects"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield Container(
            Label("Select a Thread", classes="screen-title"),
            ListView(id="thread-list"),
        )
        yield Footer()

    async def on_mount(self) -> None:
        """Load threads from API"""
        logger.info(f"ThreadList screen mounted for project_id={self.app.current_project_id}")
        try:
            threads = await self.app.api_client.get_threads(self.app.current_project_id)
            list_view = self.query_one("#thread-list", ListView)

            if not threads:
                logger.debug("No threads found - showing empty state")
                list_view.append(
                    ListItem(Label("[dim]No threads yet. Press 'n' to create one.[/dim]"))
                )
            else:
                logger.debug(f"Loaded {len(threads)} threads")
                for thread in threads:
                    list_view.append(
                        ListItem(
                            Label(f"{thread.title}"),
                            classes="thread-item",
                        )
                    )
                    # Store thread data on the list item
                    list_view.children[-1].thread_data = thread

            list_view.focus()
        except Exception as e:
            logger.error(f"Error loading threads: {e}", exc_info=True)
            self.app.notify(f"Error loading threads: {e}", severity="error", markup=False)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        """Navigate to turn browser for selected thread"""
        if hasattr(event.item, "thread_data"):
            thread = event.item.thread_data
            logger.info(f"Selected thread: {thread.title} (id={thread.id})")
            self.app.current_thread_id = thread.id
            self.app.push_screen("turn_browser")

    async def action_new_thread(self) -> None:
        """Show dialog for creating new thread"""

        def on_create(title: str | None) -> None:
            if title:
                self.app.call_later(self.create_thread, title)

        self.app.push_screen(NewThreadDialog(), on_create)

    async def create_thread(self, title: str) -> None:
        """Create new thread via API"""
        logger.info(f"Creating thread: {title}")
        try:
            thread = await self.app.api_client.create_thread(
                self.app.current_project_id, title
            )
            logger.debug(f"Thread created successfully: {thread.id}")
            self.app.notify(f"Created thread: {title}", severity="information")

            # Reload thread list
            await self.on_mount()
        except Exception as e:
            logger.error(f"Error creating thread: {e}", exc_info=True)
            self.app.notify(f"Error creating thread: {e}", severity="error", markup=False)

    def action_back(self) -> None:
        """Return to project list"""
        self.app.pop_screen()

    def action_quit(self) -> None:
        """Quit the application"""
        self.app.exit()