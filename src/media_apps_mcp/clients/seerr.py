from typing import Any, Literal

from media_apps_mcp.clients.base import ApiClient
from media_apps_mcp.config import ServiceInstance

MediaType = Literal["movie", "tv"]


class SeerrClient:
    """Client for Overseerr/Jellyseerr's `/api/v1` request-management API."""

    def __init__(self, instance: ServiceInstance):
        self._api = ApiClient(instance)

    async def search_media(self, query: str, page: int = 1) -> Any:
        return await self._api.get("/api/v1/search", params={"query": query, "page": page})

    async def media_details(self, media_type: MediaType, tmdb_id: int) -> Any:
        return await self._api.get(f"/api/v1/{media_type}/{tmdb_id}")

    async def create_request(self, payload: dict) -> Any:
        return await self._api.post("/api/v1/request", json=payload)

    async def list_requests(
        self, filter: str = "all", take: int = 20, skip: int = 0, sort: str = "added"
    ) -> Any:
        return await self._api.get(
            "/api/v1/request",
            params={"filter": filter, "take": take, "skip": skip, "sort": sort},
        )

    async def get_request(self, request_id: int) -> Any:
        return await self._api.get(f"/api/v1/request/{request_id}")

    async def approve_request(self, request_id: int) -> Any:
        return await self._api.post(f"/api/v1/request/{request_id}/approve")

    async def decline_request(self, request_id: int) -> Any:
        return await self._api.post(f"/api/v1/request/{request_id}/decline")

    async def delete_request(self, request_id: int) -> Any:
        return await self._api.delete(f"/api/v1/request/{request_id}")

    async def request_count(self) -> Any:
        return await self._api.get("/api/v1/request/count")

    async def radarr_servers(self) -> Any:
        return await self._api.get("/api/v1/service/radarr")

    async def radarr_server(self, server_id: int) -> Any:
        return await self._api.get(f"/api/v1/service/radarr/{server_id}")

    async def sonarr_servers(self) -> Any:
        return await self._api.get("/api/v1/service/sonarr")

    async def sonarr_server(self, server_id: int) -> Any:
        return await self._api.get(f"/api/v1/service/sonarr/{server_id}")
