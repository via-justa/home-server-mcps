from typing import Any, Literal

from media_apps_mcp.formatting import DetailLevel, project_fields, project_many
from media_apps_mcp.tools._servarr_fields import ARR_ITEM_COMPACT_FIELDS, standard_fields_for


async def manage_library(
    registry: Any,
    service: Literal["sonarr", "radarr", "lidarr"],
    action: Literal["list", "get", "delete"],
    media_id: int | None = None,
    delete_files: bool = False,
    format: DetailLevel = "compact",
) -> dict:
    """List/get/delete already-added library items (series/movies/artists) in
    Sonarr/Radarr/Lidarr's local database. Use `search` instead to find new
    media to add."""
    client = registry.servarr(service)
    compact_fields = ARR_ITEM_COMPACT_FIELDS[service]
    standard_fields = standard_fields_for(service)

    if action == "list":
        raw = await client.library_items()
        return {"items": project_many(raw, format, compact_fields, standard_fields)}

    if action == "get":
        if media_id is None:
            raise ValueError("action='get' requires media_id")
        raw = await client.library_item(media_id)
        return project_fields(raw, format, compact_fields, standard_fields)

    # action == "delete"
    if media_id is None:
        raise ValueError("action='delete' requires media_id")
    await client.delete_item(media_id, delete_files=delete_files)
    return {"deleted": media_id}
