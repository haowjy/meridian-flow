from .models import Turn, PaginatedTurnsResponse


class NavigationState:
    """Handles all arrow key navigation logic for turn browsing"""

    def __init__(self, current_turn: Turn, response: PaginatedTurnsResponse):
        self.current = current_turn
        self.response = response

    # ↑ Key: Navigate to parent turn
    @property
    def can_go_up(self) -> bool:
        """Check if we can navigate to parent"""
        return self.current.prev_turn_id is not None

    @property
    def prev_turn_id(self) -> str | None:
        """Get parent turn ID for ↑ navigation"""
        return self.current.prev_turn_id

    # ↓ Key: Navigate to child turn
    @property
    def can_go_down(self) -> bool:
        """Check if we can navigate to child (first child)"""
        return len(self.response.turns) > 1

    @property
    def next_turn_id(self) -> str | None:
        """Get first child turn ID for ↓ navigation"""
        if len(self.response.turns) > 1:
            return self.response.turns[1].id
        return None

    # ← Key: Navigate to previous sibling
    @property
    def can_go_left(self) -> bool:
        """Check if we can navigate to previous sibling"""
        return self.current.sibling_index > 0

    @property
    def prev_sibling_id(self) -> str | None:
        """Get previous sibling turn ID for ← navigation"""
        idx = self.current.sibling_index
        if idx > 0:
            return self.current.sibling_ids[idx - 1]
        return None

    # → Key: Navigate to next sibling
    @property
    def can_go_right(self) -> bool:
        """Check if we can navigate to next sibling"""
        idx = self.current.sibling_index
        return idx < len(self.current.sibling_ids) - 1

    @property
    def next_sibling_id(self) -> str | None:
        """Get next sibling turn ID for → navigation"""
        idx = self.current.sibling_index
        if idx < len(self.current.sibling_ids) - 1:
            return self.current.sibling_ids[idx + 1]
        return None
