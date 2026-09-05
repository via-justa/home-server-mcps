import pytest

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.tools.config_sync import manage_config

INDEXER = {
    "id": 1,
    "name": "SomeIndexer",
    "protocol": "torrent",
    "enable": True,
    "priority": 25,
    "definitionName": "someindexer",
    "tags": [],
}
APPLICATION = {"id": 1, "name": "Sonarr", "syncLevel": "fullSync", "implementation": "Sonarr", "tags": []}


class FakeProwlarrClient:
    def __init__(self):
        self.calls = []
        self.indexers_response = [INDEXER]
        self.applications_response = [APPLICATION]
        self.test_response = {"isValid": True}
        self.command_response = {"id": 9, "name": "ApplicationIndexerSync"}

    async def indexers(self):
        self.calls.append(("indexers",))
        return self.indexers_response

    async def applications(self):
        self.calls.append(("applications",))
        return self.applications_response

    async def test_indexer(self, indexer_id):
        self.calls.append(("test_indexer", indexer_id))
        return self.test_response

    async def run_command(self, name, **params):
        self.calls.append(("run_command", name, params))
        return self.command_response


class FakeRegistry:
    def __init__(self, client):
        self._client = client

    def prowlarr(self):
        return self._client


async def test_list_indexers_returns_compact_fields_by_default():
    client = FakeProwlarrClient()
    registry = FakeRegistry(client)

    result = await manage_config(registry, service="prowlarr", action="list_indexers")

    assert result["indexers"] == [
        {"id": 1, "name": "SomeIndexer", "protocol": "torrent", "enable": True, "priority": 25}
    ]


async def test_test_indexer_requires_indexer_id():
    registry = FakeRegistry(FakeProwlarrClient())

    with pytest.raises(ValueError, match="indexer_id"):
        await manage_config(registry, service="prowlarr", action="test_indexer")


async def test_test_indexer_forwards_to_client():
    client = FakeProwlarrClient()
    registry = FakeRegistry(client)

    result = await manage_config(registry, service="prowlarr", action="test_indexer", indexer_id=1)

    assert client.calls == [("test_indexer", 1)]
    assert result == {"isValid": True}


async def test_list_applications_returns_compact_fields():
    client = FakeProwlarrClient()
    registry = FakeRegistry(client)

    result = await manage_config(registry, service="prowlarr", action="list_applications")

    assert result["applications"] == [{"id": 1, "name": "Sonarr", "syncLevel": "fullSync"}]


async def test_sync_triggers_application_indexer_sync_command():
    client = FakeProwlarrClient()
    registry = FakeRegistry(client)

    result = await manage_config(registry, service="prowlarr", action="sync")

    assert client.calls == [("run_command", "ApplicationIndexerSync", {})]
    assert result == {"id": 9, "name": "ApplicationIndexerSync"}


async def test_profilarr_raises_not_yet_supported():
    registry = FakeRegistry(None)

    with pytest.raises(NotYetSupportedError):
        await manage_config(registry, service="profilarr", action="list_indexers")
