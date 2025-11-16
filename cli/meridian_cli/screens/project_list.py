import logging
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Header, Footer, ListView, ListItem, Label, Input, Button
from textual.containers import Container, Vertical
from textual.binding import Binding
from ..models import Project

logger = logging.getLogger("meridian_cli.screens.project_list")


class NewProjectDialog(Screen):
    """Modal dialog for creating a new project"""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        yield Container(
            Vertical(
                Label("Create New Project", classes="dialog-title"),
                Input(placeholder="Project name...", id="project-name"),
                Container(
                    Button("Create", variant="primary", id="create"),
                    Button("Cancel", id="cancel"),
                    classes="button-row",
                ),
                id="dialog",
            ),
        )

    def on_mount(self) -> None:
        self.query_one("#project-name", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "create":
            name = self.query_one("#project-name", Input).value.strip()
            if name:
                self.dismiss(name)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ProjectListScreen(Screen):
    """Project selection/creation screen"""

    BINDINGS = [
        Binding("n", "new_project", "New Project"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield Container(
            Label("Select a Project", classes="screen-title"),
            ListView(id="project-list"),
        )
        yield Footer()

    async def on_mount(self) -> None:
        """Load projects from API"""
        logger.info("ProjectList screen mounted")
        try:
            projects = await self.app.api_client.get_projects()
            list_view = self.query_one("#project-list", ListView)

            if not projects:
                logger.debug("No projects found - showing empty state")
                list_view.append(
                    ListItem(Label("[dim]No projects yet. Press 'n' to create one.[/dim]"))
                )
            else:
                logger.debug(f"Loaded {len(projects)} projects")
                for project in projects:
                    list_view.append(
                        ListItem(
                            Label(f"{project.name}"),
                            classes="project-item",
                        )
                    )
                    # Store project data on the list item
                    list_view.children[-1].project_data = project

            list_view.focus()
        except Exception as e:
            logger.error(f"Error loading projects: {e}", exc_info=True)
            self.app.notify(f"Error loading projects: {e}", severity="error", markup=False)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        """Navigate to chat list for selected project"""
        if hasattr(event.item, "project_data"):
            project = event.item.project_data
            logger.info(f"Selected project: {project.name} (id={project.id})")
            self.app.current_project_id = project.id
            self.app.push_screen("chat_list")

    async def action_new_project(self) -> None:
        """Show dialog for creating new project"""

        def on_create(name: str | None) -> None:
            if name:
                self.app.call_later(self.create_project, name)

        self.app.push_screen(NewProjectDialog(), on_create)

    async def create_project(self, name: str) -> None:
        """Create new project via API"""
        logger.info(f"Creating project: {name}")
        try:
            project = await self.app.api_client.create_project(name)
            logger.debug(f"Project created successfully: {project.id}")
            self.app.notify(f"Created project: {name}", severity="information")

            # Reload project list
            await self.on_mount()
        except Exception as e:
            logger.error(f"Error creating project: {e}", exc_info=True)
            self.app.notify(f"Error creating project: {e}", severity="error", markup=False)

    def action_quit(self) -> None:
        """Quit the application"""
        self.app.exit()
