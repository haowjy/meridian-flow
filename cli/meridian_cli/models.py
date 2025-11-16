from pydantic import BaseModel
from datetime import datetime


class TurnBlock(BaseModel):
    """Represents a content block within a turn"""
    id: str
    turn_id: str
    block_type: str  # "text", "thinking", "tool_use", "image", etc.
    sequence: int
    text_content: str | None = None
    content: dict | None = None
    created_at: datetime


class Turn(BaseModel):
    """Represents a single turn in a conversation"""
    id: str
    chat_id: str
    prev_turn_id: str | None
    role: str  # "user" | "assistant"
    status: str  # "pending" | "streaming" | "completed" | "failed"
    error: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    created_at: datetime
    completed_at: datetime | None = None
    request_params: dict | None = None
    stop_reason: str | None = None
    response_metadata: dict | None = None
    blocks: list[TurnBlock] = []
    sibling_ids: list[str] = []  # INCLUDES current turn's ID, ordered by created_at

    @property
    def sibling_index(self) -> int:
        """Current position in sibling list (0-indexed)"""
        try:
            return self.sibling_ids.index(self.id)
        except ValueError:
            return 0

    @property
    def text_content(self) -> str:
        """Extract text content from blocks"""
        texts = [
            block.text_content
            for block in self.blocks
            if block.text_content and block.block_type in ["text", "thinking"]
        ]
        return "\n".join(texts) if texts else ""


class CreateTurnResponse(BaseModel):
    """Response from POST /api/chats/{id}/turns"""
    user_turn: Turn
    assistant_turn: Turn
    stream_url: str


class PaginatedTurnsResponse(BaseModel):
    """Response from GET /api/chats/{id}/turns"""
    turns: list[Turn]
    has_more_before: bool
    has_more_after: bool


class Chat(BaseModel):
    """Represents a chat/conversation"""
    id: str
    title: str
    project_id: str
    created_at: datetime
    updated_at: datetime


class Project(BaseModel):
    """Represents a project"""
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
