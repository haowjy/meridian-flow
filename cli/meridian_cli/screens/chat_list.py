import logging
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Header, Footer, ListView, ListItem, Label, Input, Button
from textual.containers import Container, Vertical
from textual.binding import Binding
from ..models import Chat

logger = logging.getLogger("meridian_cli.screens.chat_list")


class NewChatDialog(Screen):
    """Modal dialog for creating a new chat"""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        yield Container(
            Vertical(
                Label("Create New Chat", classes="dialog-title"),
                Input(placeholder="Chat title...", id="chat-title"),
                Container(
                    Button("Create", variant="primary", id="create"),
                    Button("Cancel", id="cancel"),
                    classes="button-row",
                ),
                id="dialog",
            ),
        )

    def on_mount(self) -> None:
        self.query_one("#chat-title", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "create":
            title = self.query_one("#chat-title", Input).value.strip()
            if title:
                self.dismiss(title)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ChatListScreen(Screen):
    """Chat selection/creation screen"""

    BINDINGS = [
        Binding("n", "new_chat", "New Chat"),
        Binding("escape", "back", "Back to Projects"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield Container(
            Label("Select a Chat", classes="screen-title"),
            ListView(id="chat-list"),
        )
        yield Footer()

    async def on_mount(self) -> None:
        """Load chats from API"""
        logger.info(f"ChatList screen mounted for project_id={self.app.current_project_id}")
        try:
            chats = await self.app.api_client.get_chats(self.app.current_project_id)
            list_view = self.query_one("#chat-list", ListView)

            if not chats:
                logger.debug("No chats found - showing empty state")
                list_view.append(
                    ListItem(Label("[dim]No chats yet. Press 'n' to create one.[/dim]"))
                )
            else:
                logger.debug(f"Loaded {len(chats)} chats")
                for chat in chats:
                    list_view.append(
                        ListItem(
                            Label(f"{chat.title}"),
                            classes="chat-item",
                        )
                    )
                    # Store chat data on the list item
                    list_view.children[-1].chat_data = chat

            list_view.focus()
        except Exception as e:
            logger.error(f"Error loading chats: {e}", exc_info=True)
            self.app.notify(f"Error loading chats: {e}", severity="error", markup=False)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        """Navigate to turn browser for selected chat"""
        if hasattr(event.item, "chat_data"):
            chat = event.item.chat_data
            logger.info(f"Selected chat: {chat.title} (id={chat.id})")
            self.app.current_chat_id = chat.id
            self.app.push_screen("turn_browser")

    async def action_new_chat(self) -> None:
        """Show dialog for creating new chat"""

        def on_create(title: str | None) -> None:
            if title:
                self.app.call_later(self.create_chat, title)

        self.app.push_screen(NewChatDialog(), on_create)

    async def create_chat(self, title: str) -> None:
        """Create new chat via API"""
        logger.info(f"Creating chat: {title}")
        try:
            chat = await self.app.api_client.create_chat(
                self.app.current_project_id, title
            )
            logger.debug(f"Chat created successfully: {chat.id}")
            self.app.notify(f"Created chat: {title}", severity="information")

            # Reload chat list
            await self.on_mount()
        except Exception as e:
            logger.error(f"Error creating chat: {e}", exc_info=True)
            self.app.notify(f"Error creating chat: {e}", severity="error", markup=False)

    def action_back(self) -> None:
        """Return to project list"""
        self.app.pop_screen()

    def action_quit(self) -> None:
        """Quit the application"""
        self.app.exit()
