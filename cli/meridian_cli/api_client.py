import httpx
import json
import logging
from typing import AsyncIterator
from .models import Project, Chat, Turn, PaginatedTurnsResponse, CreateTurnResponse

logger = logging.getLogger("meridian_cli.api_client")


class APIClient:
    """Async HTTP client for Meridian API"""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=30.0)
        logger.debug(f"APIClient initialized with base_url={self.base_url}")

    async def close(self):
        """Close the HTTP client"""
        logger.debug("Closing API client")
        await self.client.aclose()

    # Project endpoints
    async def get_projects(self) -> list[Project]:
        """GET /api/projects"""
        logger.debug("API Request: GET /api/projects")
        response = await self.client.get(f"{self.base_url}/api/projects")
        response.raise_for_status()
        projects = [Project(**p) for p in response.json()]
        logger.debug(f"API Response: 200 OK ({len(projects)} projects)")
        return projects

    async def create_project(self, name: str) -> Project:
        """POST /api/projects"""
        logger.debug(f"API Request: POST /api/projects (name={name})")
        response = await self.client.post(
            f"{self.base_url}/api/projects", json={"name": name}
        )
        response.raise_for_status()
        project = Project(**response.json())
        logger.debug(f"API Response: 200 OK (created project id={project.id})")
        return project

    # Chat endpoints
    async def get_chats(self, project_id: str) -> list[Chat]:
        """GET /api/chats?project_id={project_id}"""
        logger.debug(f"API Request: GET /api/chats?project_id={project_id}")
        response = await self.client.get(
            f"{self.base_url}/api/chats", params={"project_id": project_id}
        )
        response.raise_for_status()
        chats = [Chat(**c) for c in response.json()]
        logger.debug(f"API Response: 200 OK ({len(chats)} chats)")
        return chats

    async def create_chat(self, project_id: str, title: str) -> Chat:
        """POST /api/chats"""
        logger.debug(f"API Request: POST /api/chats (project_id={project_id}, title={title})")
        response = await self.client.post(
            f"{self.base_url}/api/chats", json={"project_id": project_id, "title": title}
        )
        response.raise_for_status()
        chat = Chat(**response.json())
        logger.debug(f"API Response: 200 OK (created chat id={chat.id})")
        return chat

    # Turn endpoints
    async def get_turns(
        self,
        chat_id: str,
        from_turn_id: str | None = None,
        limit: int = 1,
        direction: str = "after",
    ) -> PaginatedTurnsResponse:
        """GET /api/chats/{chat_id}/turns with pagination"""
        params = {"limit": limit, "direction": direction}
        if from_turn_id:
            params["from_turn_id"] = from_turn_id

        logger.debug(f"API Request: GET /api/chats/{chat_id}/turns (params={params})")
        response = await self.client.get(
            f"{self.base_url}/api/chats/{chat_id}/turns", params=params
        )
        response.raise_for_status()
        result = PaginatedTurnsResponse(**response.json())
        logger.debug(f"API Response: 200 OK ({len(result.turns)} turns)")
        return result

    async def create_turn(
        self,
        chat_id: str,
        prev_turn_id: str | None,
        content: str,
        params: dict,
    ) -> CreateTurnResponse:
        """POST /api/chats/{chat_id}/turns to create a new user turn and assistant turn"""
        logger.debug(f"API Request: POST /api/chats/{chat_id}/turns (prev_turn_id={prev_turn_id}, content_len={len(content)})")
        response = await self.client.post(
            f"{self.base_url}/api/chats/{chat_id}/turns",
            json={
                "prev_turn_id": prev_turn_id,
                "role": "user",
                "turn_blocks": [{"block_type": "text", "text_content": content}],
                "request_params": params,
            },
        )
        response.raise_for_status()
        result = CreateTurnResponse(**response.json())
        logger.debug(f"API Response: 200 OK (user_turn={result.user_turn.id}, assistant_turn={result.assistant_turn.id})")
        return result

    async def stream_turn(self, turn_id: str) -> AsyncIterator[dict]:
        """GET /api/turns/{turn_id}/stream - SSE streaming"""
        logger.debug(f"API Request: GET /api/turns/{turn_id}/stream (SSE)")
        async with self.client.stream(
            "GET",
            f"{self.base_url}/api/turns/{turn_id}/stream",
            headers={"Accept": "text/event-stream"},
            timeout=300.0,  # 5 minutes for streaming
        ) as response:
            response.raise_for_status()
            logger.debug(f"SSE stream connected: {response.status_code} OK")

            event_type = None
            data_lines = []

            async for line in response.aiter_lines():
                if line.startswith("event: "):
                    event_type = line[7:]
                elif line.startswith("data: "):
                    data_lines.append(line[6:])
                elif line == "":
                    # Empty line marks end of event
                    if event_type and data_lines:
                        # Join multi-line data and parse JSON
                        data_str = "\n".join(data_lines)
                        try:
                            data = json.loads(data_str)
                            # Log event with relevant details
                            if event_type == "block_delta":
                                delta_type = data.get("delta_type", "unknown")
                                text_len = len(data.get("text_delta", ""))
                                logger.debug(f"SSE Event: {event_type} (delta_type={delta_type}, text_len={text_len})")
                            else:
                                logger.debug(f"SSE Event: {event_type} (data_keys={list(data.keys())})")
                            yield {"event": event_type, "data": data}
                        except json.JSONDecodeError as e:
                            logger.warning(f"SSE malformed JSON: {e} (data={data_str[:100]})")

                        # Reset for next event
                        event_type = None
                        data_lines = []

            logger.debug(f"SSE stream ended for turn {turn_id}")

    async def interrupt_turn(self, turn_id: str) -> None:
        """POST /api/turns/{turn_id}/interrupt to cancel streaming"""
        logger.debug(f"API Request: POST /api/turns/{turn_id}/interrupt")
        response = await self.client.post(
            f"{self.base_url}/api/turns/{turn_id}/interrupt"
        )
        response.raise_for_status()
        logger.debug(f"API Response: 200 OK (turn {turn_id} interrupted)")
