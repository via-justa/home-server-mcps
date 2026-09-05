import pytest

from media_apps_mcp.errors import NotYetSupportedError
from media_apps_mcp.tools.search import search


class FakeSeerrClient:
    def __init__(self, response):
        self._response = response
        self.calls = []

    async def search_media(self, query, page=1):
        self.calls.append(query)
        return self._response


class FakeServarrClient:
    def __init__(self, results):
        self._results = results
        self.calls = []

    async def lookup(self, term):
        self.calls.append(term)
        return self._results


class FakeProwlarrClient:
    def __init__(self, results):
        self._results = results
        self.calls = []

    async def search(self, query, indexer_ids=None, categories=None, search_type="search"):
        self.calls.append((query, indexer_ids, search_type))
        return self._results


class FakeRegistry:
    def __init__(self, seerr=None, servarr=None, prowlarr=None):
        self._seerr = seerr
        self._servarr = servarr
        self._prowlarr = prowlarr

    def seerr(self):
        return self._seerr

    def servarr(self, kind):
        return self._servarr

    def prowlarr(self):
        return self._prowlarr


SEERR_RESPONSE = {
    "results": [
        {
            "id": 1,
            "mediaType": "movie",
            "title": "Dune",
            "releaseDate": "2021-10-22",
            "posterPath": "/x.jpg",
            "overview": "A long overview" * 10,
            "voteAverage": 8.0,
        },
        {
            "id": 2,
            "mediaType": "movie",
            "title": "Dune Part Two",
            "releaseDate": "2024-03-01",
            "posterPath": "/y.jpg",
            "overview": "another",
            "voteAverage": 8.5,
        },
    ]
}


async def test_seerr_search_trims_to_compact_fields_and_respects_limit():
    registry = FakeRegistry(seerr=FakeSeerrClient(SEERR_RESPONSE))

    result = await search(registry, service="seerr", query="dune", limit=1)

    assert len(result["results"]) == 1
    item = result["results"][0]
    assert item["id"] == 1
    assert item["title"] == "Dune"
    assert "overview" not in item


async def test_seerr_search_full_format_returns_raw_results():
    registry = FakeRegistry(seerr=FakeSeerrClient(SEERR_RESPONSE))

    result = await search(registry, service="seerr", query="dune", format="full")

    assert result["results"] == SEERR_RESPONSE["results"]


async def test_lidarr_search_calls_lookup_and_trims_fields():
    raw = [
        {
            "artistName": "Radiohead",
            "foreignArtistId": "abc-123",
            "disambiguation": "",
            "overview": "long bio" * 20,
        }
    ]
    registry = FakeRegistry(servarr=FakeServarrClient(raw))

    result = await search(registry, service="lidarr", query="radiohead")

    assert result["results"] == [{"artistName": "Radiohead", "foreignArtistId": "abc-123", "disambiguation": ""}]


async def test_prowlarr_search_maps_media_type_to_search_type_and_trims_fields():
    raw = [
        {
            "title": "Some.Release.1080p",
            "indexer": "SomeIndexer",
            "size": 123456,
            "seeders": 10,
            "protocol": "torrent",
            "guid": "abc",
            "publishDate": "2024-01-01",
        }
    ]
    client = FakeProwlarrClient(raw)
    registry = FakeRegistry(prowlarr=client)

    result = await search(registry, service="prowlarr", query="some release", media_type="tv")

    assert client.calls == [("some release", None, "tvsearch")]
    assert result["results"][0]["title"] == "Some.Release.1080p"
    assert "guid" not in result["results"][0]


async def test_shelfmark_search_raises_not_yet_supported():
    registry = FakeRegistry()

    with pytest.raises(NotYetSupportedError):
        await search(registry, service="shelfmark", query="foundation")
