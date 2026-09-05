from typing import Any, Literal

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.formatting import DetailLevel, project_many

SEERR_COMPACT_FIELDS = ["id", "mediaType", "title", "name", "releaseDate", "firstAirDate", "posterPath"]
SEERR_STANDARD_FIELDS = SEERR_COMPACT_FIELDS + ["overview", "voteAverage", "genreIds"]

LIDARR_COMPACT_FIELDS = ["artistName", "foreignArtistId", "disambiguation"]
LIDARR_STANDARD_FIELDS = LIDARR_COMPACT_FIELDS + ["overview", "genres"]

PROWLARR_COMPACT_FIELDS = ["title", "indexer", "size", "seeders", "protocol"]
PROWLARR_STANDARD_FIELDS = PROWLARR_COMPACT_FIELDS + ["publishDate", "categories", "guid", "downloadUrl"]

_MEDIA_TYPE_TO_PROWLARR_SEARCH_TYPE = {"movie": "movie", "tv": "tvsearch"}


async def search(
    registry: Any,
    service: Literal["seerr", "lidarr", "prowlarr", "shelfmark"],
    query: str,
    limit: int = 10,
    format: DetailLevel = "compact",
    media_type: Literal["movie", "tv"] | None = None,
    indexer_ids: list[int] | None = None,
) -> dict:
    """Search for media/releases. `seerr` for movies/TV, `lidarr` for artists,
    `prowlarr` for indexer releases. `shelfmark` (books) isn't wired up yet."""
    if service == "seerr":
        raw = await registry.seerr().search_media(query)
        results = project_many(raw["results"][:limit], format, SEERR_COMPACT_FIELDS, SEERR_STANDARD_FIELDS)
        return {"results": results}

    if service == "lidarr":
        raw = await registry.servarr("lidarr").lookup(query)
        results = project_many(raw[:limit], format, LIDARR_COMPACT_FIELDS, LIDARR_STANDARD_FIELDS)
        return {"results": results}

    if service == "prowlarr":
        search_type = _MEDIA_TYPE_TO_PROWLARR_SEARCH_TYPE.get(media_type, "search")
        raw = await registry.prowlarr().search(query, indexer_ids=indexer_ids, search_type=search_type)
        results = project_many(raw[:limit], format, PROWLARR_COMPACT_FIELDS, PROWLARR_STANDARD_FIELDS)
        return {"results": results}

    raise NotYetSupportedError(service, "its API is undocumented; needs live endpoint discovery first")
