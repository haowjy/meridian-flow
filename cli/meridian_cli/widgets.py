"""Custom widgets for Meridian CLI"""

from textual.widgets import TextArea, Select
from textual.binding import Binding
from textual.message import Message


class SubmittableTextArea(TextArea):
    """TextArea with built-in submit on Enter

    Posts a Submitted message when Enter is pressed, allowing
    parent screens to handle submission without key binding conflicts.
    Use Ctrl+J to insert a newline.
    """

    BINDINGS = [
        Binding("enter", "submit", "Submit", priority=True, show=True),
        Binding("ctrl+j", "insert_newline", "Newline", priority=True, show=True),
    ]

    def action_insert_newline(self) -> None:
        """Insert a newline when Ctrl+J is pressed"""
        self.insert("\n")

    def action_submit(self) -> None:
        """Post a Submitted message when Enter is pressed"""
        self.post_message(self.Submitted(self.text))

    class Submitted(Message):
        """Message sent when Enter is pressed

        Attributes:
            text: The content of the text area when submitted
        """

        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text


class FormSelect(Select):
    """Select widget for forms where arrows move between fields.

    Enter/space/left/right open the dropdown. Up/down are reserved
    for form navigation when the overlay is closed, but still work
    normally inside the opened overlay.
    """

    BINDINGS = [
        Binding("enter,space,left,right", "show_overlay", "Show menu", show=False),
    ]
