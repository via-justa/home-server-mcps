ARR_ITEM_COMPACT_FIELDS = {
    "sonarr": ["id", "title", "status", "monitored", "seasonCount", "path"],
    "radarr": ["id", "title", "status", "monitored", "hasFile", "path"],
    "lidarr": ["id", "artistName", "status", "monitored", "path"],
}
ARR_ITEM_EXTRA_STANDARD_FIELDS = ["overview", "added", "qualityProfileId"]


def standard_fields_for(service: str) -> list[str]:
    return ARR_ITEM_COMPACT_FIELDS[service] + ARR_ITEM_EXTRA_STANDARD_FIELDS
