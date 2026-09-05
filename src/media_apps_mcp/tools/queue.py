from typing import Any, Literal

from media_apps_mcp.formatting import DetailLevel, project_many

QUEUE_COMPACT_FIELDS = ["id", "title", "status", "trackedDownloadStatus", "size", "sizeleft", "timeleft", "indexer"]
QUEUE_STANDARD_FIELDS = QUEUE_COMPACT_FIELDS + ["statusMessages", "downloadId", "protocol"]


async def manage_queue(
    registry: Any,
    service: Literal["sonarr", "radarr", "lidarr"],
    action: Literal["list", "remove", "run_command"],
    queue_id: int | None = None,
    remove_from_client: bool = True,
    blocklist: bool = False,
    command_name: str | None = None,
    format: DetailLevel = "compact",
) -> dict:
    """View/remove the download queue, or trigger a command (e.g. RssSync,
    MissingEpisodeSearch) on Sonarr/Radarr/Lidarr."""
    client = registry.servarr(service)

    if action == "list":
        raw = await client.queue()
        records = project_many(raw["records"], format, QUEUE_COMPACT_FIELDS, QUEUE_STANDARD_FIELDS)
        return {"records": records, "totalRecords": raw.get("totalRecords", len(records))}

    if action == "remove":
        if queue_id is None:
            raise ValueError("action='remove' requires queue_id")
        await client.delete_queue_item(queue_id, remove_from_client=remove_from_client, blocklist=blocklist)
        return {"removed": queue_id}

    # action == "run_command"
    if not command_name:
        raise ValueError("action='run_command' requires command_name")
    return await client.run_command(command_name)
