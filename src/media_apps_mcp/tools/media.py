from typing import Any, Literal

from media_apps_mcp.formatting import DetailLevel, project_fields
from media_apps_mcp.tools._servarr_fields import ARR_ITEM_COMPACT_FIELDS, standard_fields_for

SEERR_COMPACT_FIELDS = ["id", "title", "name", "releaseDate", "firstAirDate", "posterPath", "status"]
SEERR_STANDARD_FIELDS = SEERR_COMPACT_FIELDS + [
    "overview",
    "genres",
    "runtime",
    "numberOfSeasons",
    "numberOfEpisodes",
    "voteAverage",
    "mediaInfo",
]


async def get_media(
    registry: Any,
    service: Literal["seerr", "sonarr", "radarr", "lidarr"],
    media_type: Literal["movie", "tv"] | None = None,
    media_id: int | None = None,
    level: DetailLevel = "standard",
) -> dict:
    """Fetch details for one media item. `seerr` needs `media_type` + `media_id`
    (TMDB id); `sonarr`/`radarr`/`lidarr` need `media_id` (local library id)."""
    if service == "seerr":
        if media_type is None or media_id is None:
            raise ValueError("service='seerr' requires both media_type and media_id")
        raw = await registry.seerr().media_details(media_type, media_id)
        return project_fields(raw, level, SEERR_COMPACT_FIELDS, SEERR_STANDARD_FIELDS)

    if media_id is None:
        raise ValueError(f"service='{service}' requires media_id")
    raw = await registry.servarr(service).library_item(media_id)
    return project_fields(raw, level, ARR_ITEM_COMPACT_FIELDS[service], standard_fields_for(service))
