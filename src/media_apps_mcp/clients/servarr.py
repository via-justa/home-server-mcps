from typing import Any, Literal

from media_apps_mcp.clients.base import ApiClient
from media_apps_mcp.config import ServiceInstance

ServarrKind = Literal["sonarr", "radarr", "lidarr"]

# Sonarr/Radarr are on the v3 API; Lidarr never moved past v1.
_KIND_CONFIG = {
    "sonarr": {"api_version": "v3", "resource": "series"},
    "radarr": {"api_version": "v3", "resource": "movie"},
    "lidarr": {"api_version": "v1", "resource": "artist"},
}


class ServarrClient:
    """Shared client for the Servarr-family apps (Sonarr/Radarr/Lidarr).

    They expose near-identical REST APIs differing only in API version and
    the name of the primary library resource (series/movie/artist).
    """

    def __init__(self, instance: ServiceInstance, kind: ServarrKind):
        self._api = ApiClient(instance)
        config = _KIND_CONFIG[kind]
        self._api_version = config["api_version"]
        self._resource = config["resource"]

    def _path(self, *segments: str) -> str:
        return "/".join(["", "api", self._api_version, *segments])

    async def system_status(self) -> Any:
        return await self._api.get(self._path("system", "status"))

    async def quality_profiles(self) -> Any:
        return await self._api.get(self._path("qualityprofile"))

    async def root_folders(self) -> Any:
        return await self._api.get(self._path("rootfolder"))

    async def tags(self) -> Any:
        return await self._api.get(self._path("tag"))

    async def library_items(self) -> Any:
        return await self._api.get(self._path(self._resource))

    async def library_item(self, item_id: int) -> Any:
        return await self._api.get(self._path(self._resource, str(item_id)))

    async def lookup(self, term: str) -> Any:
        return await self._api.get(self._path(self._resource, "lookup"), params={"term": term})

    async def add_item(self, payload: dict) -> Any:
        return await self._api.post(self._path(self._resource), json=payload)

    async def delete_item(self, item_id: int, delete_files: bool = False) -> Any:
        return await self._api.request(
            "DELETE",
            self._path(self._resource, str(item_id)),
            params={"deleteFiles": str(delete_files).lower()},
        )

    async def queue(self) -> Any:
        return await self._api.get(self._path("queue"))

    async def delete_queue_item(
        self, queue_id: int, remove_from_client: bool = True, blocklist: bool = False
    ) -> Any:
        return await self._api.request(
            "DELETE",
            self._path("queue", str(queue_id)),
            params={
                "removeFromClient": str(remove_from_client).lower(),
                "blocklist": str(blocklist).lower(),
            },
        )

    async def history(self) -> Any:
        return await self._api.get(self._path("history"))

    async def wanted_missing(self) -> Any:
        return await self._api.get(self._path("wanted", "missing"))

    async def run_command(self, name: str, **params: Any) -> Any:
        return await self._api.post(self._path("command"), json={"name": name, **params})
