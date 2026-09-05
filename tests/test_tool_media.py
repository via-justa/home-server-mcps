import pytest

from media_apps_mcp.tools.media import get_media


class FakeSeerrClient:
    def __init__(self, response):
        self._response = response

    async def media_details(self, media_type, media_id):
        self.last_call = (media_type, media_id)
        return self._response


class FakeServarrClient:
    def __init__(self, response):
        self._response = response

    async def library_item(self, item_id):
        self.last_call = item_id
        return self._response


class FakeRegistry:
    def __init__(self, seerr=None, servarr=None):
        self._seerr = seerr
        self._servarr = servarr

    def seerr(self):
        return self._seerr

    def servarr(self, kind):
        return self._servarr


SEERR_MOVIE = {
    "id": 123,
    "title": "Dune",
    "releaseDate": "2021-10-22",
    "posterPath": "/x.jpg",
    "status": 3,
    "overview": "long text",
    "genres": [{"id": 1, "name": "Sci-Fi"}],
    "voteAverage": 8.0,
    "mediaInfo": {"status": 5},
}


async def test_seerr_requires_media_type_and_media_id():
    registry = FakeRegistry(seerr=FakeSeerrClient({}))

    with pytest.raises(ValueError, match="media_type"):
        await get_media(registry, service="seerr", media_id=123)


async def test_seerr_returns_standard_fields_by_default():
    registry = FakeRegistry(seerr=FakeSeerrClient(SEERR_MOVIE))

    result = await get_media(registry, service="seerr", media_type="movie", media_id=123)

    assert result["id"] == 123
    assert result["title"] == "Dune"
    assert result["overview"] == "long text"
    assert result["mediaInfo"] == {"status": 5}


async def test_seerr_compact_level_drops_overview():
    registry = FakeRegistry(seerr=FakeSeerrClient(SEERR_MOVIE))

    result = await get_media(registry, service="seerr", media_type="movie", media_id=123, level="compact")

    assert "overview" not in result
    assert result["title"] == "Dune"


async def test_sonarr_requires_media_id():
    registry = FakeRegistry(servarr=FakeServarrClient({}))

    with pytest.raises(ValueError, match="media_id"):
        await get_media(registry, service="sonarr")


async def test_sonarr_fetches_library_item_by_id():
    raw = {
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
    registry = FakeRegistry(servarr=FakeServarrClient(raw))

    result = await get_media(registry, service="sonarr", media_id=1, level="compact")

    assert result == {
        "id": 1,
        "title": "Breaking Bad",
        "status": "continuing",
        "monitored": True,
        "seasonCount": 5,
        "path": "/tv/breaking-bad",
    }


async def test_lidarr_fetches_library_item_with_artist_name_field():
    raw = {"id": 9, "artistName": "Radiohead", "status": "continuing", "monitored": True, "path": "/music/radiohead"}
    registry = FakeRegistry(servarr=FakeServarrClient(raw))

    result = await get_media(registry, service="lidarr", media_id=9, level="compact")

    assert result["artistName"] == "Radiohead"
