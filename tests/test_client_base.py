import json

import httpx
import pytest
import respx

from media_apps_mcp.clients.base import ApiClient, ApiError
from media_apps_mcp.config import ServiceInstance

INSTANCE = ServiceInstance(
    id="default",
    name="Sonarr",
    base_url="http://sonarr.local:8989",
    api_key="secret-key",
    is_default=True,
)


@respx.mock
async def test_get_sends_api_key_header_and_returns_json():
    route = respx.get("http://sonarr.local:8989/api/v3/system/status").mock(
        return_value=httpx.Response(200, json={"version": "4.0.0"})
    )

    client = ApiClient(INSTANCE)
    result = await client.get("/api/v3/system/status")

    assert result == {"version": "4.0.0"}
    assert route.calls.last.request.headers["X-Api-Key"] == "secret-key"


@respx.mock
async def test_post_sends_json_body():
    route = respx.post("http://sonarr.local:8989/api/v3/command").mock(
        return_value=httpx.Response(201, json={"id": 42})
    )

    client = ApiClient(INSTANCE)
    result = await client.post("/api/v3/command", json={"name": "RssSync"})

    assert result == {"id": 42}
    assert json.loads(route.calls.last.request.content) == {"name": "RssSync"}


@respx.mock
async def test_base_url_and_path_slashes_do_not_double_up():
    trailing_slash_instance = INSTANCE.model_copy(update={"base_url": "http://sonarr.local:8989/"})
    respx.get("http://sonarr.local:8989/api/v3/series").mock(return_value=httpx.Response(200, json=[]))

    client = ApiClient(trailing_slash_instance)
    result = await client.get("/api/v3/series")

    assert result == []


@respx.mock
async def test_401_raises_api_error_mentioning_api_key():
    respx.get("http://sonarr.local:8989/api/v3/system/status").mock(
        return_value=httpx.Response(401, text="Unauthorized")
    )

    client = ApiClient(INSTANCE)
    with pytest.raises(ApiError) as exc_info:
        await client.get("/api/v3/system/status")

    assert exc_info.value.status_code == 401
    assert "api key" in str(exc_info.value).lower()


@respx.mock
async def test_404_raises_api_error_mentioning_not_found():
    respx.get("http://sonarr.local:8989/api/v3/series/999").mock(
        return_value=httpx.Response(404, text="Not Found")
    )

    client = ApiClient(INSTANCE)
    with pytest.raises(ApiError) as exc_info:
        await client.get("/api/v3/series/999")

    assert exc_info.value.status_code == 404
    assert "not found" in str(exc_info.value).lower()


@respx.mock
async def test_5xx_raises_api_error_with_status_code():
    respx.get("http://sonarr.local:8989/api/v3/system/status").mock(
        return_value=httpx.Response(500, text="boom")
    )

    client = ApiClient(INSTANCE)
    with pytest.raises(ApiError) as exc_info:
        await client.get("/api/v3/system/status")

    assert exc_info.value.status_code == 500


@respx.mock
async def test_empty_response_body_returns_none():
    respx.delete("http://sonarr.local:8989/api/v3/series/1").mock(return_value=httpx.Response(200))

    client = ApiClient(INSTANCE)
    result = await client.delete("/api/v3/series/1")

    assert result is None
