import httpx
import pytest
import respx

from media_apps_mcp.clients.servarr import ServarrClient
from media_apps_mcp.config import ServiceInstance

SONARR_INSTANCE = ServiceInstance(
    id="default", name="Sonarr", base_url="http://sonarr.local:8989", api_key="sonarr-key", is_default=True
)
LIDARR_INSTANCE = ServiceInstance(
    id="default", name="Lidarr", base_url="http://lidarr.local:8686", api_key="lidarr-key", is_default=True
)


@respx.mock
async def test_sonarr_uses_v3_series_resource():
    respx.get("http://sonarr.local:8989/api/v3/series").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "title": "Show"}])
    )

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    result = await client.library_items()

    assert result == [{"id": 1, "title": "Show"}]


@respx.mock
async def test_lidarr_uses_v1_artist_resource():
    respx.get("http://lidarr.local:8686/api/v1/artist").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "artistName": "Band"}])
    )

    client = ServarrClient(LIDARR_INSTANCE, kind="lidarr")
    result = await client.library_items()

    assert result == [{"id": 5, "artistName": "Band"}]


@respx.mock
async def test_lookup_hits_resource_lookup_endpoint_with_term():
    route = respx.get("http://sonarr.local:8989/api/v3/series/lookup").mock(
        return_value=httpx.Response(200, json=[{"title": "Breaking Bad"}])
    )

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    result = await client.lookup("breaking bad")

    assert result == [{"title": "Breaking Bad"}]
    assert route.calls.last.request.url.params["term"] == "breaking bad"


@respx.mock
async def test_add_item_posts_payload_to_resource_root():
    route = respx.post("http://lidarr.local:8686/api/v1/artist").mock(
        return_value=httpx.Response(201, json={"id": 9})
    )

    client = ServarrClient(LIDARR_INSTANCE, kind="lidarr")
    result = await client.add_item({"artistName": "Band"})

    assert result == {"id": 9}
    assert route.calls.last.request.method == "POST"


@respx.mock
async def test_delete_item_sends_delete_files_query_param():
    route = respx.delete("http://sonarr.local:8989/api/v3/series/1").mock(return_value=httpx.Response(200))

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    await client.delete_item(1, delete_files=True)

    assert route.calls.last.request.url.params["deleteFiles"] == "true"


@respx.mock
async def test_queue_gets_queue_endpoint():
    respx.get("http://sonarr.local:8989/api/v3/queue").mock(
        return_value=httpx.Response(200, json={"records": []})
    )

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    result = await client.queue()

    assert result == {"records": []}


@respx.mock
async def test_delete_queue_item_sends_removal_options():
    route = respx.delete("http://sonarr.local:8989/api/v3/queue/7").mock(return_value=httpx.Response(200))

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    await client.delete_queue_item(7, remove_from_client=False, blocklist=True)

    params = route.calls.last.request.url.params
    assert params["removeFromClient"] == "false"
    assert params["blocklist"] == "true"


@respx.mock
async def test_run_command_posts_name_and_extra_params():
    route = respx.post("http://sonarr.local:8989/api/v3/command").mock(
        return_value=httpx.Response(201, json={"id": 3, "name": "RssSync"})
    )

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    result = await client.run_command("RssSync")

    assert result == {"id": 3, "name": "RssSync"}
    import json

    assert json.loads(route.calls.last.request.content) == {"name": "RssSync"}


@respx.mock
async def test_quality_profiles_delegates_to_shared_get():
    respx.get("http://sonarr.local:8989/api/v3/qualityprofile").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "name": "HD-1080p"}])
    )

    client = ServarrClient(SONARR_INSTANCE, kind="sonarr")
    result = await client.quality_profiles()

    assert result == [{"id": 1, "name": "HD-1080p"}]
