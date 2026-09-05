import pytest

from media_apps_mcp.tools.queue import manage_queue

QUEUE_RECORD = {
    "id": 1,
    "title": "Some.Show.S01E01",
    "status": "downloading",
    "trackedDownloadStatus": "ok",
    "size": 1000,
    "sizeleft": 200,
    "timeleft": "00:10:00",
    "indexer": "SomeIndexer",
    "statusMessages": [],
    "downloadId": "abc",
    "protocol": "torrent",
}


class FakeServarrClient:
    def __init__(self):
        self.calls = []
        self.queue_response = {"records": [QUEUE_RECORD], "totalRecords": 1}
        self.command_response = {"id": 5, "name": "RssSync"}

    async def queue(self):
        self.calls.append(("queue",))
        return self.queue_response

    async def delete_queue_item(self, queue_id, remove_from_client=True, blocklist=False):
        self.calls.append(("delete_queue_item", queue_id, remove_from_client, blocklist))

    async def run_command(self, name, **params):
        self.calls.append(("run_command", name, params))
        return self.command_response


class FakeRegistry:
    def __init__(self, client):
        self._client = client

    def servarr(self, kind):
        return self._client


async def test_list_returns_compact_queue_records_by_default():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_queue(registry, service="sonarr", action="list")

    assert client.calls == [("queue",)]
    assert result["records"][0] == {
        "id": 1,
        "title": "Some.Show.S01E01",
        "status": "downloading",
        "trackedDownloadStatus": "ok",
        "size": 1000,
        "sizeleft": 200,
        "timeleft": "00:10:00",
        "indexer": "SomeIndexer",
    }
    assert result["totalRecords"] == 1


async def test_list_standard_format_includes_extra_fields():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_queue(registry, service="sonarr", action="list", format="standard")

    assert result["records"][0]["statusMessages"] == []
    assert result["records"][0]["downloadId"] == "abc"


async def test_remove_requires_queue_id():
    registry = FakeRegistry(FakeServarrClient())

    with pytest.raises(ValueError, match="queue_id"):
        await manage_queue(registry, service="sonarr", action="remove")


async def test_remove_calls_delete_queue_item_with_options():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_queue(
        registry, service="sonarr", action="remove", queue_id=1, remove_from_client=False, blocklist=True
    )

    assert client.calls == [("delete_queue_item", 1, False, True)]
    assert result == {"removed": 1}


async def test_run_command_requires_command_name():
    registry = FakeRegistry(FakeServarrClient())

    with pytest.raises(ValueError, match="command_name"):
        await manage_queue(registry, service="sonarr", action="run_command")


async def test_run_command_forwards_to_client():
    client = FakeServarrClient()
    registry = FakeRegistry(client)

    result = await manage_queue(registry, service="sonarr", action="run_command", command_name="RssSync")

    assert client.calls == [("run_command", "RssSync", {})]
    assert result == {"id": 5, "name": "RssSync"}
