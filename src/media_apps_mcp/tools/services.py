from typing import Any

ALL_SERVICE_TYPES = ["sonarr", "radarr", "lidarr", "prowlarr", "seerr", "shelfmark", "profilarr"]
SERVARR_KINDS = {"sonarr", "radarr", "lidarr"}


async def get_services(registry: Any, service: str | None = None, detail: bool = False) -> dict:
    """List configured instances per service type, with optional per-instance detail."""
    types = [service] if service else ALL_SERVICE_TYPES

    result: dict[str, list[dict]] = {}
    for service_type in types:
        entries = []
        for instance in registry.instances(service_type):
            entry = {
                "id": instance.id,
                "name": instance.name,
                "baseUrl": str(instance.base_url),
                "isDefault": instance.is_default,
            }
            if detail and service_type in SERVARR_KINDS:
                client = registry.servarr(service_type, instance.id)
                entry["qualityProfiles"] = await client.quality_profiles()
                entry["rootFolders"] = await client.root_folders()
                entry["tags"] = await client.tags()
            entries.append(entry)
        result[service_type] = entries

    return result
