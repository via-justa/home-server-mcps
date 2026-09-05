import pytest

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.tools.requests import request_media


class FakeSeerrClient:
    def __init__(self, response=None):
        self._response = response or {"id": 1}
        self.create_calls = []

    async def create_request(self, payload):
        self.create_calls.append(payload)
        return self._response


class FakeServarrClient:
    def __init__(self, response=None):
        self._response = response or {"id": 9}
        self.add_calls = []

    async def add_item(self, payload):
        self.add_calls.append(payload)
        return self._response


class FakeRegistry:
    def __init__(self, seerr=None, servarr=None):
        self._seerr = seerr
        self._servarr = servarr

    def seerr(self):
        return self._seerr

    def servarr(self, kind):
        return self._servarr


async def test_seerr_movie_request_does_not_need_confirmation():
    client = FakeSeerrClient()
    registry = FakeRegistry(seerr=client)

    result = await request_media(registry, service="seerr", media_type="movie", media_id=123)

    assert result == {"id": 1}
    assert client.create_calls == [{"mediaType": "movie", "mediaId": 123, "is4k": False}]


async def test_seerr_tv_single_season_does_not_need_confirmation():
    client = FakeSeerrClient()
    registry = FakeRegistry(seerr=client)

    await request_media(registry, service="seerr", media_type="tv", media_id=1, seasons=[1])

    assert client.create_calls[0]["seasons"] == [1]


async def test_seerr_tv_multi_season_without_confirmation_raises():
    registry = FakeRegistry(seerr=FakeSeerrClient())

    with pytest.raises(ValueError, match="confirmed"):
        await request_media(registry, service="seerr", media_type="tv", media_id=1, seasons=[1, 2, 3])


async def test_seerr_tv_all_seasons_without_confirmation_raises():
    registry = FakeRegistry(seerr=FakeSeerrClient())

    with pytest.raises(ValueError, match="confirmed"):
        await request_media(registry, service="seerr", media_type="tv", media_id=1, seasons="all")


async def test_seerr_tv_multi_season_with_confirmation_succeeds():
    client = FakeSeerrClient()
    registry = FakeRegistry(seerr=client)

    result = await request_media(
        registry, service="seerr", media_type="tv", media_id=1, seasons=[1, 2, 3], confirmed=True
    )

    assert result == {"id": 1}


async def test_seerr_tv_requires_seasons():
    registry = FakeRegistry(seerr=FakeSeerrClient())

    with pytest.raises(ValueError, match="seasons"):
        await request_media(registry, service="seerr", media_type="tv", media_id=1)


async def test_seerr_dry_run_does_not_call_create_request():
    client = FakeSeerrClient()
    registry = FakeRegistry(seerr=client)

    result = await request_media(
        registry, service="seerr", media_type="movie", media_id=123, dry_run=True
    )

    assert client.create_calls == []
    assert result["dryRun"] is True
    assert result["payload"]["mediaId"] == 123


async def test_lidarr_requires_payload():
    registry = FakeRegistry(servarr=FakeServarrClient())

    with pytest.raises(ValueError, match="payload"):
        await request_media(registry, service="lidarr")


async def test_lidarr_add_forwards_payload():
    client = FakeServarrClient()
    registry = FakeRegistry(servarr=client)
    payload = {"artistName": "Radiohead", "foreignArtistId": "abc"}

    result = await request_media(registry, service="lidarr", payload=payload)

    assert result == {"id": 9}
    assert client.add_calls == [payload]


async def test_lidarr_dry_run_does_not_call_add_item():
    client = FakeServarrClient()
    registry = FakeRegistry(servarr=client)

    result = await request_media(registry, service="lidarr", payload={"artistName": "x"}, dry_run=True)

    assert client.add_calls == []
    assert result["dryRun"] is True


async def test_shelfmark_raises_not_yet_supported():
    registry = FakeRegistry()

    with pytest.raises(NotYetSupportedError):
        await request_media(registry, service="shelfmark")
