from typing import Any, Literal

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.formatting import DetailLevel, project_fields, project_many

REQUEST_COMPACT_FIELDS = ["id", "status", "is4k", "createdAt"]
REQUEST_STANDARD_FIELDS = REQUEST_COMPACT_FIELDS + ["media", "seasons", "requestedBy", "updatedAt"]


async def request_media(
    registry: Any,
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
    """Request/add media. `seerr` requests movies (auto) or TV (single season
    auto, multiple seasons or "all" need `confirmed: true` to avoid accidental
    mass-requests). `lidarr` adds an artist from a `payload` built from a prior
    `search` result. `shelfmark` (books) isn't wired up yet."""
    if service == "seerr":
        return await _request_seerr(
            registry, media_type, media_id, seasons, is4k, server_id, profile_id, root_folder, confirmed, dry_run
        )

    if service == "lidarr":
        return await _request_lidarr(registry, payload, dry_run)

    raise NotYetSupportedError(service, "its API is undocumented; needs live endpoint discovery first")


async def _request_seerr(
    registry: Any,
    media_type: Literal["movie", "tv"] | None,
    media_id: int | None,
    seasons: list[int] | Literal["all"] | None,
    is4k: bool,
    server_id: int | None,
    profile_id: int | None,
    root_folder: str | None,
    confirmed: bool,
    dry_run: bool,
) -> dict:
    if media_type is None or media_id is None:
        raise ValueError("service='seerr' requires media_type and media_id")

    payload: dict[str, Any] = {"mediaType": media_type, "mediaId": media_id, "is4k": is4k}
    if server_id is not None:
        payload["serverId"] = server_id
    if profile_id is not None:
        payload["profileId"] = profile_id
    if root_folder is not None:
        payload["rootFolder"] = root_folder

    if media_type == "tv":
        if seasons is None:
            raise ValueError("service='seerr', media_type='tv' requires seasons (a list of season numbers or 'all')")
        is_multi_season = seasons == "all" or (isinstance(seasons, list) and len(seasons) > 1)
        if is_multi_season and not confirmed and not dry_run:
            raise ValueError(
                "Requesting multiple seasons (or seasons='all') needs confirmed=True to avoid an accidental "
                "mass-request. Pass dry_run=True first to preview, or confirmed=True to proceed."
            )
        payload["seasons"] = seasons

    if dry_run:
        return {"dryRun": True, "payload": payload}
    return await registry.seerr().create_request(payload)


async def _request_lidarr(registry: Any, payload: dict | None, dry_run: bool) -> dict:
    if not payload:
        raise ValueError(
            "service='lidarr' requires payload: the enriched object from a prior "
            "search(service='lidarr', format='full') result, plus rootFolderPath/"
            "qualityProfileId/metadataProfileId/monitored."
        )
    if dry_run:
        return {"dryRun": True, "payload": payload}
    return await registry.servarr("lidarr").add_item(payload)


async def manage_requests(
    registry: Any,
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
    """Get/list/approve/decline/delete Seerr requests, or get pending/approved
    counts. `shelfmark` (books) isn't wired up yet."""
    if service != "seerr":
        raise NotYetSupportedError(service, "its API is undocumented; needs live endpoint discovery first")

    client = registry.seerr()

    if action == "list":
        raw = await client.list_requests(filter, take, skip, sort)
        results = project_many(raw["results"], format, REQUEST_COMPACT_FIELDS, REQUEST_STANDARD_FIELDS)
        return {"results": results}

    if action == "get":
        if request_id is None:
            raise ValueError("action='get' requires request_id")
        raw = await client.get_request(request_id)
        return project_fields(raw, format, REQUEST_COMPACT_FIELDS, REQUEST_STANDARD_FIELDS)

    if action == "approve":
        if request_id is None:
            raise ValueError("action='approve' requires request_id")
        return await client.approve_request(request_id)

    if action == "decline":
        if request_id is None:
            raise ValueError("action='decline' requires request_id")
        return await client.decline_request(request_id)

    if action == "delete":
        ids = request_ids if request_ids else ([request_id] if request_id is not None else None)
        if not ids:
            raise ValueError("action='delete' requires request_id or request_ids")
        for rid in ids:
            await client.delete_request(rid)
        return {"deleted": ids}

    # action == "count"
    return await client.request_count()
