import json

import httpx
import respx

from media_apps_mcp.clients.prowlarr import ProwlarrClient
from media_apps_mcp.config import ServiceInstance

INSTANCE = ServiceInstance(
    id="default", name="Prowlarr", base_url="http://prowlarr.local:9696", api_key="prowlarr-key", is_default=True
)


@respx.mock
async def test_indexers_lists_configured_indexers():
    respx.get("http://prowlarr.local:9696/api/v1/indexer").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "name": "SomeIndexer"}])
    )

    client = ProwlarrClient(INSTANCE)
    result = await client.indexers()

    assert result == [{"id": 1, "name": "SomeIndexer"}]


@respx.mock
async def test_search_passes_query_indexer_ids_and_type():
    route = respx.get("http://prowlarr.local:9696/api/v1/search").mock(
        return_value=httpx.Response(200, json=[{"title": "Release.1080p"}])
    )

    client = ProwlarrClient(INSTANCE)
    result = await client.search("some release", indexer_ids=[1, 2], search_type="tvsearch")

    assert result == [{"title": "Release.1080p"}]
    params = route.calls.last.request.url.params
    assert params["query"] == "some release"
    assert params["indexerIds"] == "1,2"
    assert params["type"] == "tvsearch"


@respx.mock
async def test_applications_lists_configured_apps():
    respx.get("http://prowlarr.local:9696/api/v1/applications").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "name": "Sonarr"}])
    )

    client = ProwlarrClient(INSTANCE)
    result = await client.applications()

    assert result == [{"id": 1, "name": "Sonarr"}]


@respx.mock
async def test_run_command_posts_name():
    route = respx.post("http://prowlarr.local:9696/api/v1/command").mock(
        return_value=httpx.Response(201, json={"id": 5, "name": "ApplicationIndexerSync"})
    )

    client = ProwlarrClient(INSTANCE)
    result = await client.run_command("ApplicationIndexerSync")

    assert result == {"id": 5, "name": "ApplicationIndexerSync"}
    assert json.loads(route.calls.last.request.content) == {"name": "ApplicationIndexerSync"}


@respx.mock
async def test_test_indexer_fetches_definition_then_posts_it_to_test_endpoint():
    respx.get("http://prowlarr.local:9696/api/v1/indexer/3").mock(
        return_value=httpx.Response(200, json={"id": 3, "name": "SomeIndexer", "fields": []})
    )
    test_route = respx.post("http://prowlarr.local:9696/api/v1/indexer/test").mock(
        return_value=httpx.Response(200, json={})
    )

    client = ProwlarrClient(INSTANCE)
    await client.test_indexer(3)

    sent_body = json.loads(test_route.calls.last.request.content)
    assert sent_body == {"id": 3, "name": "SomeIndexer", "fields": []}
