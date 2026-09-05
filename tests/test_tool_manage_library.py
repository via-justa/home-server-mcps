import pytest

from media_apps_mcp.tools.library import manage_library

ITEM = {
    "id": 1,
    "title": "Breaking Bad",
    "status": "continuing",
    "monitored": True,
    "seasonCount": 5,
    "path": "/tv/breaking-bad",
    "overview": "long",
    "added": "2020-01-01",
    "qualityProfileId": 4,
}


class FakeServarrClient:
    def __init__(self):
        self.calls = []
        self.items_response = [ITEM]
        self.item_response = ITEM

    async def library_items(self):
        self.calls.append(("library_items",))
        return self.items_response

    async def library_item(self, item_id):
        self.calls.append(("library_item", item_id))
        return self.item_response

    async def delete_item(self, item_id, delete_files=False):
        self.calls.append(("delete_item", item_id, delete_files))


class FakeRegistry:
    def __init__(self, client):
        self._client = client

    def servarr(self, kind):
        return self._client


async def test_list_returns_compact_fields_by_default():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_library(registry, service="sonarr", action="list")

    assert client.calls == [("library_items",)]
    assert result["items"] == [
        {
            "id": 1,
            "title": "Breaking Bad",
            "status": "continuing",
            "monitored": True,
            "seasonCount": 5,
            "path": "/tv/breaking-bad",
        }
    ]


async def test_get_requires_media_id():
    registry = FakeRegistry(FakeServarrClient())

    with pytest.raises(ValueError, match="media_id"):
        await manage_library(registry, service="sonarr", action="get")


async def test_get_returns_single_item():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_library(registry, service="sonarr", action="get", media_id=1, format="full")

    assert result == ITEM


async def test_delete_requires_media_id():
    registry = FakeRegistry(FakeServarrClient())

    with pytest.raises(ValueError, match="media_id"):
        await manage_library(registry, service="sonarr", action="delete")


async def test_delete_forwards_delete_files_flag():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_library(registry, service="sonarr", action="delete", media_id=1, delete_files=True)

    assert client.calls == [("delete_item", 1, True)]
    assert result == {"deleted": 1}
