import json

import httpx
import respx

from media_apps_mcp.clients.seerr import SeerrClient
from media_apps_mcp.config import ServiceInstance

INSTANCE = ServiceInstance(
    id="default", name="Seerr", base_url="http://seerr.local:5055", api_key="seerr-key", is_default=True
)


@respx.mock
async def test_search_media_passes_query_and_page():
    route = respx.get("http://seerr.local:5055/api/v1/search").mock(
        return_value=httpx.Response(200, json={"results": []})
    )

    client = SeerrClient(INSTANCE)
    result = await client.search_media("dune", page=2)

    assert result == {"results": []}
    params = route.calls.last.request.url.params
    assert params["query"] == "dune"
    assert params["page"] == "2"


@respx.mock
async def test_media_details_uses_movie_or_tv_path():
    respx.get("http://seerr.local:5055/api/v1/movie/123").mock(
        return_value=httpx.Response(200, json={"id": 123, "title": "A Movie"})
    )

    client = SeerrClient(INSTANCE)
    result = await client.media_details("movie", 123)

    assert result == {"id": 123, "title": "A Movie"}


@respx.mock
async def test_create_request_posts_payload():
    route = respx.post("http://seerr.local:5055/api/v1/request").mock(
        return_value=httpx.Response(201, json={"id": 1})
    )

    client = SeerrClient(INSTANCE)
    payload = {"mediaType": "movie", "mediaId": 123}
    result = await client.create_request(payload)

    assert result == {"id": 1}
    assert json.loads(route.calls.last.request.content) == payload


@respx.mock
async def test_list_requests_passes_filter_and_paging():
    route = respx.get("http://seerr.local:5055/api/v1/request").mock(
        return_value=httpx.Response(200, json={"results": []})
    )

    client = SeerrClient(INSTANCE)
    await client.list_requests(filter="pending", take=10, skip=5, sort="added")

    params = route.calls.last.request.url.params
    assert params["filter"] == "pending"
    assert params["take"] == "10"
    assert params["skip"] == "5"
    assert params["sort"] == "added"


@respx.mock
async def test_get_request_by_id():
    respx.get("http://seerr.local:5055/api/v1/request/7").mock(
        return_value=httpx.Response(200, json={"id": 7})
    )

    client = SeerrClient(INSTANCE)
    result = await client.get_request(7)

    assert result == {"id": 7}


@respx.mock
async def test_approve_request_posts_to_approve_endpoint():
    route = respx.post("http://seerr.local:5055/api/v1/request/7/approve").mock(
        return_value=httpx.Response(200, json={"id": 7, "status": 2})
    )

    client = SeerrClient(INSTANCE)
    result = await client.approve_request(7)

    assert result == {"id": 7, "status": 2}
    assert route.calls.last.request.method == "POST"


@respx.mock
async def test_decline_request_posts_to_decline_endpoint():
    respx.post("http://seerr.local:5055/api/v1/request/7/decline").mock(
        return_value=httpx.Response(200, json={"id": 7, "status": 3})
    )

    client = SeerrClient(INSTANCE)
    result = await client.decline_request(7)

    assert result == {"id": 7, "status": 3}


@respx.mock
async def test_delete_request_sends_delete():
    route = respx.delete("http://seerr.local:5055/api/v1/request/7").mock(return_value=httpx.Response(204))

    client = SeerrClient(INSTANCE)
    await client.delete_request(7)

    assert route.calls.last.request.method == "DELETE"


@respx.mock
async def test_request_count_hits_count_endpoint():
    respx.get("http://seerr.local:5055/api/v1/request/count").mock(
        return_value=httpx.Response(200, json={"pending": 2, "approved": 5})
    )

    client = SeerrClient(INSTANCE)
    result = await client.request_count()

    assert result == {"pending": 2, "approved": 5}


@respx.mock
async def test_radarr_servers_lists_connected_servers():
    respx.get("http://seerr.local:5055/api/v1/service/radarr").mock(
        return_value=httpx.Response(200, json=[{"id": 0, "name": "Radarr", "is4k": False}])
    )

    client = SeerrClient(INSTANCE)
    result = await client.radarr_servers()

    assert result == [{"id": 0, "name": "Radarr", "is4k": False}]


@respx.mock
async def test_radarr_server_detail_by_id():
    respx.get("http://seerr.local:5055/api/v1/service/radarr/0").mock(
        return_value=httpx.Response(200, json={"profiles": [], "rootFolders": []})
    )

    client = SeerrClient(INSTANCE)
    result = await client.radarr_server(0)

    assert result == {"profiles": [], "rootFolders": []}


@respx.mock
async def test_sonarr_servers_lists_connected_servers():
    respx.get("http://seerr.local:5055/api/v1/service/sonarr").mock(
        return_value=httpx.Response(200, json=[{"id": 0, "name": "Sonarr"}])
    )

    client = SeerrClient(INSTANCE)
    result = await client.sonarr_servers()

    assert result == [{"id": 0, "name": "Sonarr"}]


@respx.mock
async def test_sonarr_server_detail_by_id():
    respx.get("http://seerr.local:5055/api/v1/service/sonarr/0").mock(
        return_value=httpx.Response(200, json={"profiles": [], "rootFolders": []})
    )

    client = SeerrClient(INSTANCE)
    result = await client.sonarr_server(0)

    assert result == {"profiles": [], "rootFolders": []}
