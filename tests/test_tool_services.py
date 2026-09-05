from media_apps_mcp.config import ServiceInstance
from media_apps_mcp.tools.services import ALL_SERVICE_TYPES, get_services


class FakeServarrClient:
    def __init__(self, profiles, folders, tags):
        self._profiles = profiles
        self._folders = folders
        self._tags = tags

    async def quality_profiles(self):
        return self._profiles

    async def root_folders(self):
        return self._folders

    async def tags(self):
        return self._tags


class FakeRegistry:
    def __init__(self, instances_by_service, servarr_clients_by_id=None):
        self._instances_by_service = instances_by_service
        self._servarr_clients_by_id = servarr_clients_by_id or {}

    def instances(self, service):
        return self._instances_by_service.get(service, [])

    def servarr(self, kind, instance_id):
        return self._servarr_clients_by_id[instance_id]


def make_instance(id="default", name="Sonarr", is_default=True):
    return ServiceInstance(
        id=id, name=name, base_url="http://sonarr.local:8989", api_key="key", is_default=is_default
    )


async def test_returns_all_service_types_when_no_filter():
    registry = FakeRegistry({"sonarr": [make_instance()]})

    result = await get_services(registry)

    assert set(result.keys()) == set(ALL_SERVICE_TYPES)
    assert result["sonarr"][0]["id"] == "default"
    assert result["radarr"] == []


async def test_filters_to_single_service_type_when_given():
    registry = FakeRegistry({"sonarr": [make_instance()], "radarr": [make_instance(name="Radarr")]})

    result = await get_services(registry, service="sonarr")

    assert set(result.keys()) == {"sonarr"}


async def test_includes_basic_fields_per_instance():
    registry = FakeRegistry({"sonarr": [make_instance(id="main", name="Main Sonarr", is_default=True)]})

    result = await get_services(registry, service="sonarr")

    entry = result["sonarr"][0]
    assert entry["id"] == "main"
    assert entry["name"] == "Main Sonarr"
    assert entry["isDefault"] is True
    assert entry["baseUrl"].startswith("http://sonarr.local")


async def test_detail_true_fetches_profiles_folders_tags_for_servarr_kinds():
    instance = make_instance(id="main")
    fake_client = FakeServarrClient(
        profiles=[{"id": 1, "name": "HD"}],
        folders=[{"path": "/tv"}],
        tags=[{"id": 1, "label": "anime"}],
    )
    registry = FakeRegistry({"sonarr": [instance]}, servarr_clients_by_id={"main": fake_client})

    result = await get_services(registry, service="sonarr", detail=True)

    entry = result["sonarr"][0]
    assert entry["qualityProfiles"] == [{"id": 1, "name": "HD"}]
    assert entry["rootFolders"] == [{"path": "/tv"}]
    assert entry["tags"] == [{"id": 1, "label": "anime"}]


async def test_detail_true_skips_non_servarr_kinds():
    seerr_instance = ServiceInstance(
        id="default", name="Seerr", base_url="http://seerr.local:5055", api_key="key", is_default=True
    )
    registry = FakeRegistry({"seerr": [seerr_instance]})

    result = await get_services(registry, service="seerr", detail=True)

    entry = result["seerr"][0]
    assert "qualityProfiles" not in entry
