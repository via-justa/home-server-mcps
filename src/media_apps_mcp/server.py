from typing import Literal

from fastmcp import FastMCP

from media_apps_mcp.formatting import DetailLevel
from media_apps_mcp.registry import ServiceRegistry
from media_apps_mcp.tools import config_sync as config_sync_tool
from media_apps_mcp.tools import library as library_tool
from media_apps_mcp.tools import media as media_tool
from media_apps_mcp.tools import queue as queue_tool
from media_apps_mcp.tools import requests as requests_tool
from media_apps_mcp.tools import search as search_tool
from media_apps_mcp.tools import services as services_tool

mcp = FastMCP(
    name="media-apps",
    instructions=(
        "Operates a home media stack: Sonarr (TV), Radarr (movies), Lidarr (music), "
        "Prowlarr (indexers), Seerr/Overseerr-Jellyseerr (movie & TV requests). "
        "Start with get_services to see what's configured. Use search to find new "
        "media, request_media to add/request it, and manage_* tools to inspect or "
        "change what's already there. Profilarr and shelfmark aren't wired up yet."
    ),
)

registry = ServiceRegistry()


@mcp.tool(annotations={"title": "List configured services", "readOnlyHint": True})
async def get_services(service: str | None = None, detail: bool = False) -> dict:
    """List configured instances per service (sonarr/radarr/lidarr/prowlarr/seerr/
    shelfmark/profilarr). Omit `service` to list all. Set `detail=True` to also
    fetch quality profiles/root folders/tags for arr-family services — needed
    before calling request_media so you have valid profileId/rootFolder values."""
    return await services_tool.get_services(registry, service=service, detail=detail)


@mcp.tool(annotations={"title": "Search for media/releases", "readOnlyHint": True})
async def search(
    service: Literal["seerr", "lidarr", "prowlarr", "shelfmark"],
    query: str,
    limit: int = 10,
    format: DetailLevel = "compact",
    media_type: Literal["movie", "tv"] | None = None,
    indexer_ids: list[int] | None = None,
) -> dict:
    """Search for media or releases. `seerr` searches movies/TV (TMDB); `lidarr`
    looks up artists; `prowlarr` searches indexers for releases (pass `media_type`
    to narrow the search type, `indexer_ids` to limit to specific indexers).
    `shelfmark` (books) isn't wired up yet. Use `format='full'` when you need the
    raw result to build a request_media payload (e.g. for lidarr)."""
    return await search_tool.search(
        registry,
        service=service,
        query=query,
        limit=limit,
        format=format,
        media_type=media_type,
        indexer_ids=indexer_ids,
    )


@mcp.tool(annotations={"title": "Get media details", "readOnlyHint": True})
async def get_media(
    service: Literal["seerr", "sonarr", "radarr", "lidarr"],
    media_type: Literal["movie", "tv"] | None = None,
    media_id: int | None = None,
    level: DetailLevel = "standard",
) -> dict:
    """Fetch details for one media item. `seerr` needs `media_type` + `media_id`
    (TMDB id, from search); `sonarr`/`radarr`/`lidarr` need `media_id` (the local
    library id, from manage_library or get_services)."""
    return await media_tool.get_media(
        registry, service=service, media_type=media_type, media_id=media_id, level=level
    )


@mcp.tool(annotations={"title": "Request or add media", "readOnlyHint": False, "destructiveHint": False})
async def request_media(
    service: Literal["seerr", "lidarr", "shelfmark"],
    media_type: Literal["movie", "tv"] | None = None,
    media_id: int | None = None,
    seasons: list[int] | Literal["all"] | None = None,
    is4k: bool = False,
    server_id: int | None = None,
    profile_id: int | None = None,
    root_folder: str | None = None,
    confirmed: bool = False,
    dry_run: bool = False,
    payload: dict | None = None,
) -> dict:
    """Request/add media. `seerr` requests movies (auto-approved by Overseerr/
    Jellyseerr's own rules) or TV (a single season needs no confirmation; multiple
    seasons or seasons='all' need `confirmed=True`, to avoid an accidental
    mass-request). `lidarr` adds an artist from a `payload` built by enriching a
    prior `search(service='lidarr', format='full')` result with rootFolderPath/
    qualityProfileId/metadataProfileId/monitored. Pass `dry_run=True` to preview
    without making the request. `shelfmark` (books) isn't wired up yet."""
    return await requests_tool.request_media(
        registry,
        service=service,
        media_type=media_type,
        media_id=media_id,
        seasons=seasons,
        is4k=is4k,
        server_id=server_id,
        profile_id=profile_id,
        root_folder=root_folder,
        confirmed=confirmed,
        dry_run=dry_run,
        payload=payload,
    )


@mcp.tool(annotations={"title": "Manage media requests", "readOnlyHint": False, "destructiveHint": True})
async def manage_requests(
    service: Literal["seerr", "shelfmark"],
    action: Literal["get", "list", "approve", "decline", "delete", "count"],
    request_id: int | None = None,
    request_ids: list[int] | None = None,
    filter: str = "all",
    take: int = 20,
    skip: int = 0,
    sort: str = "added",
    format: DetailLevel = "compact",
) -> dict:
    """Get/list/approve/decline/delete Seerr requests, or fetch pending/approved
    counts (`action='count'`). `delete` accepts a single `request_id` or a batch
    via `request_ids`. `shelfmark` (books) isn't wired up yet."""
    return await requests_tool.manage_requests(
        registry,
        service=service,
        action=action,
        request_id=request_id,
        request_ids=request_ids,
        filter=filter,
        take=take,
        skip=skip,
        sort=sort,
        format=format,
    )


@mcp.tool(annotations={"title": "Manage the download queue", "readOnlyHint": False, "destructiveHint": True})
async def manage_queue(
    service: Literal["sonarr", "radarr", "lidarr"],
    action: Literal["list", "remove", "run_command"],
    queue_id: int | None = None,
    remove_from_client: bool = True,
    blocklist: bool = False,
    command_name: str | None = None,
    format: DetailLevel = "compact",
) -> dict:
    """View/remove items in the Sonarr/Radarr/Lidarr download queue, or trigger a
    command (e.g. `command_name='RssSync'` or `'MissingEpisodeSearch'`)."""
    return await queue_tool.manage_queue(
        registry,
        service=service,
        action=action,
        queue_id=queue_id,
        remove_from_client=remove_from_client,
        blocklist=blocklist,
        command_name=command_name,
        format=format,
    )


@mcp.tool(annotations={"title": "Manage the local library", "readOnlyHint": False, "destructiveHint": True})
async def manage_library(
    service: Literal["sonarr", "radarr", "lidarr"],
    action: Literal["list", "get", "delete"],
    media_id: int | None = None,
    delete_files: bool = False,
    format: DetailLevel = "compact",
) -> dict:
    """List/get/delete already-added series/movies/artists in Sonarr/Radarr/
    Lidarr's local library. Use `search` to find new media to add instead."""
    return await library_tool.manage_library(
        registry, service=service, action=action, media_id=media_id, delete_files=delete_files, format=format
    )


@mcp.tool(annotations={"title": "Manage indexer/profile config", "readOnlyHint": False, "destructiveHint": False})
async def manage_config(
    service: Literal["prowlarr", "profilarr"],
    action: Literal["list_indexers", "test_indexer", "list_applications", "sync"],
    indexer_id: int | None = None,
    format: DetailLevel = "compact",
) -> dict:
    """Manage Prowlarr indexers/applications: list them, test one
    (`action='test_indexer'`, needs `indexer_id`), or trigger an indexer-to-app
    sync. Profilarr isn't supported yet — its public API hasn't shipped."""
    return await config_sync_tool.manage_config(
        registry, service=service, action=action, indexer_id=indexer_id, format=format
    )


def run() -> None:
    import os

    mcp.run(
        transport="http",
        host=os.environ.get("MCP_HOST", "0.0.0.0"),
        port=int(os.environ.get("MCP_PORT", "8000")),
    )


if __name__ == "__main__":
    run()
