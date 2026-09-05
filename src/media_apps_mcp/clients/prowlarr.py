from typing import Any

from media_apps_mcp.clients.base import ApiClient
from media_apps_mcp.config import ServiceInstance


class ProwlarrClient:
    """Client for Prowlarr's indexer-manager API (`/api/v1`)."""

    def __init__(self, instance: ServiceInstance):
        self._api = ApiClient(instance)

    async def indexers(self) -> Any:
        return await self._api.get("/api/v1/indexer")

    async def indexer(self, indexer_id: int) -> Any:
        return await self._api.get(f"/api/v1/indexer/{indexer_id}")

    async def applications(self) -> Any:
        return await self._api.get("/api/v1/applications")

    async def search(
        self,
        query: str,
        indexer_ids: list[int] | None = None,
        categories: list[int] | None = None,
        search_type: str = "search",
    ) -> Any:
        params: dict[str, str] = {"query": query, "type": search_type}
        if indexer_ids:
            params["indexerIds"] = ",".join(str(i) for i in indexer_ids)
        if categories:
            params["categories"] = ",".join(str(c) for c in categories)
        return await self._api.get("/api/v1/search", params=params)

    async def run_command(self, name: str, **params: Any) -> Any:
        return await self._api.post("/api/v1/command", json={"name": name, **params})

    async def test_indexer(self, indexer_id: int) -> Any:
        definition = await self.indexer(indexer_id)
        return await self._api.post("/api/v1/indexer/test", json=definition)
