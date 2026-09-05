import pytest

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.tools.requests import manage_requests

REQUEST = {
    "id": 1,
    "status": 1,
    "is4k": False,
    "createdAt": "2024-01-01",
    "media": {"tmdbId": 123, "mediaType": "movie", "status": 2},
    "seasons": [],
    "requestedBy": {"id": 1, "displayName": "me"},
}


class FakeSeerrClient:
    def __init__(self):
        self.calls = []
        self.list_response = {"results": [REQUEST]}
        self.get_response = REQUEST
        self.count_response = {"pending": 1, "approved": 2}

    async def list_requests(self, filter, take, skip, sort):
        self.calls.append(("list", filter, take, skip, sort))
        return self.list_response

    async def get_request(self, request_id):
        self.calls.append(("get", request_id))
        return self.get_response

    async def approve_request(self, request_id):
        self.calls.append(("approve", request_id))
        return {"id": request_id, "status": 2}

    async def decline_request(self, request_id):
        self.calls.append(("decline", request_id))
        return {"id": request_id, "status": 3}

    async def delete_request(self, request_id):
        self.calls.append(("delete", request_id))
        return None

    async def request_count(self):
        self.calls.append(("count",))
        return self.count_response


class FakeRegistry:
    def __init__(self, seerr):
        self._seerr = seerr

    def seerr(self):
        return self._seerr


async def test_list_trims_to_compact_fields_by_default():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    result = await manage_requests(registry, service="seerr", action="list")

    assert client.calls == [("list", "all", 20, 0, "added")]
    assert result["results"][0] == {"id": 1, "status": 1, "is4k": False, "createdAt": "2024-01-01"}


async def test_list_standard_format_includes_media_and_requester():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    result = await manage_requests(registry, service="seerr", action="list", format="standard")

    assert result["results"][0]["media"] == REQUEST["media"]
    assert result["results"][0]["requestedBy"] == REQUEST["requestedBy"]


async def test_get_requires_request_id():
    registry = FakeRegistry(FakeSeerrClient())

    with pytest.raises(ValueError, match="request_id"):
        await manage_requests(registry, service="seerr", action="get")


async def test_get_returns_single_request():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    result = await manage_requests(registry, service="seerr", action="get", request_id=1)

    assert result["id"] == 1


async def test_approve_calls_approve_request():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    result = await manage_requests(registry, service="seerr", action="approve", request_id=1)

    assert client.calls == [("approve", 1)]
    assert result == {"id": 1, "status": 2}


async def test_decline_calls_decline_request():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    await manage_requests(registry, service="seerr", action="decline", request_id=1)

    assert client.calls == [("decline", 1)]


async def test_delete_supports_batch_via_request_ids():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    result = await manage_requests(registry, service="seerr", action="delete", request_ids=[1, 2])

    assert client.calls == [("delete", 1), ("delete", 2)]
    assert result == {"deleted": [1, 2]}


async def test_delete_requires_request_id_or_request_ids():
    registry = FakeRegistry(FakeSeerrClient())

    with pytest.raises(ValueError, match="request_id"):
        await manage_requests(registry, service="seerr", action="delete")


async def test_count_returns_summary_stats():
    client = FakeSeerrClient()
    registry = FakeRegistry(client)

    result = await manage_requests(registry, service="seerr", action="count")

    assert result == {"pending": 1, "approved": 2}


async def test_shelfmark_raises_not_yet_supported():
    registry = FakeRegistry(None)

    with pytest.raises(NotYetSupportedError):
        await manage_requests(registry, service="shelfmark", action="list")
