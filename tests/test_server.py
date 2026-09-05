import json

import httpx
import respx
from fastmcp import Client

from media_apps_mcp.server import mcp

EXPECTED_TOOL_NAMES = {
    "get_services",
    "search",
    "get_media",
    "request_media",
    "manage_requests",
    "manage_queue",
    "manage_library",
    "manage_config",
}


async def test_lists_exactly_the_eight_planned_tools():
    async with Client(mcp) as client:
        tools = await client.list_tools()

    assert {t.name for t in tools} == EXPECTED_TOOL_NAMES


async def test_read_only_tools_are_annotated_read_only():
    async with Client(mcp) as client:
        tools = {t.name: t for t in await client.list_tools()}

    for name in ("get_services", "search", "get_media"):
        assert tools[name].annotations.read_only_hint is True


async def test_write_tools_are_not_annotated_read_only():
    async with Client(mcp) as client:
        tools = {t.name: t for t in await client.list_tools()}

    for name in ("request_media", "manage_requests", "manage_queue", "manage_library", "manage_config"):
        assert tools[name].annotations.read_only_hint is not True


@respx.mock
async def test_get_services_tool_call_returns_configured_sonarr_instance(monkeypatch):
    monkeypatch.setenv("SONARR_URL", "http://sonarr.local:8989")
    monkeypatch.setenv("SONARR_API_KEY", "key")
    from media_apps_mcp.server import registry

    registry._instances_cache.clear()

    async with Client(mcp) as client:
        result = await client.call_tool("get_services", {"service": "sonarr"})

    payload = json.loads(result.content[0].text)
    assert payload["sonarr"][0]["id"] == "default"


async def test_unconfigured_service_call_surfaces_helpful_error(monkeypatch):
    monkeypatch.delenv("PROWLARR_URL", raising=False)
    monkeypatch.delenv("PROWLARR_API_KEY", raising=False)
    monkeypatch.delenv("PROWLARR_INSTANCES", raising=False)
    from media_apps_mcp.server import registry

    registry._instances_cache.clear()

    async with Client(mcp) as client:
        result = await client.call_tool(
            "manage_config", {"service": "prowlarr", "action": "list_indexers"}, raise_on_error=False
        )

    assert result.is_error
    assert "PROWLARR_URL" in result.content[0].text
