from typing import Any, Literal

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.formatting import DetailLevel, project_many

INDEXER_COMPACT_FIELDS = ["id", "name", "protocol", "enable", "priority"]
INDEXER_STANDARD_FIELDS = INDEXER_COMPACT_FIELDS + ["definitionName", "tags"]

APPLICATION_COMPACT_FIELDS = ["id", "name", "syncLevel"]
APPLICATION_STANDARD_FIELDS = APPLICATION_COMPACT_FIELDS + ["implementation", "tags"]


async def manage_config(
    registry: Any,
    service: Literal["prowlarr", "profilarr"],
    action: Literal["list_indexers", "test_indexer", "list_applications", "sync"],
    indexer_id: int | None = None,
    format: DetailLevel = "compact",
) -> dict:
    """Manage Prowlarr indexers/applications: list them, test an indexer, or
    trigger an indexer-to-app sync. Profilarr isn't supported yet — its public
    API hasn't shipped (tracked upstream, targeted for a future 2.x release)."""
    if service == "profilarr":
        raise NotYetSupportedError(service, "its public API hasn't shipped yet (tracked upstream for a 2.x release)")

    client = registry.prowlarr()

    if action == "list_indexers":
        raw = await client.indexers()
        return {"indexers": project_many(raw, format, INDEXER_COMPACT_FIELDS, INDEXER_STANDARD_FIELDS)}

    if action == "test_indexer":
        if indexer_id is None:
            raise ValueError("action='test_indexer' requires indexer_id")
        return await client.test_indexer(indexer_id)

    if action == "list_applications":
        raw = await client.applications()
        return {"applications": project_many(raw, format, APPLICATION_COMPACT_FIELDS, APPLICATION_STANDARD_FIELDS)}

    # action == "sync"
    return await client.run_command("ApplicationIndexerSync")
