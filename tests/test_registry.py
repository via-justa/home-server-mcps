import pytest

from media_apps_mcp.clients.prowlarr import ProwlarrClient
from media_apps_mcp.clients.seerr import SeerrClient
from media_apps_mcp.clients.servarr import ServarrClient
from media_apps_mcp.registry import ServiceRegistry


def test_instance_returns_default_when_no_id_given(monkeypatch):
    monkeypatch.setenv("SONARR_URL", "http://sonarr.local:8989")
    monkeypatch.setenv("SONARR_API_KEY", "key")

    registry = ServiceRegistry()
    instance = registry.instance("sonarr")

    assert instance.id == "default"


def test_instance_selects_by_id_among_multiple(monkeypatch):
    monkeypatch.delenv("RADARR_URL", raising=False)
    monkeypatch.delenv("RADARR_API_KEY", raising=False)
    monkeypatch.setenv(
        "RADARR_INSTANCES",
        '[{"id": "hd", "name": "HD", "base_url": "http://radarr:7878", "api_key": "k1"},'
        '{"id": "4k", "name": "4K", "base_url": "http://radarr4k:7878", "api_key": "k2"}]',
    )

    registry = ServiceRegistry()
    instance = registry.instance("radarr", "4k")

    assert instance.name == "4K"


def test_instance_raises_helpful_error_when_service_not_configured(monkeypatch):
    monkeypatch.delenv("PROWLARR_URL", raising=False)
    monkeypatch.delenv("PROWLARR_API_KEY", raising=False)
    monkeypatch.delenv("PROWLARR_INSTANCES", raising=False)

    registry = ServiceRegistry()
    with pytest.raises(ValueError, match="PROWLARR_URL"):
        registry.instance("prowlarr")


def test_instance_raises_helpful_error_for_unknown_instance_id(monkeypatch):
    monkeypatch.setenv("SONARR_URL", "http://sonarr.local:8989")
    monkeypatch.setenv("SONARR_API_KEY", "key")

    registry = ServiceRegistry()
    with pytest.raises(ValueError, match="nope"):
        registry.instance("sonarr", "nope")


def test_instances_are_cached_across_calls(monkeypatch):
    monkeypatch.setenv("SONARR_URL", "http://sonarr.local:8989")
    monkeypatch.setenv("SONARR_API_KEY", "key")

    registry = ServiceRegistry()
    first = registry.instances("sonarr")
    monkeypatch.setenv("SONARR_URL", "http://changed.local:8989")
    second = registry.instances("sonarr")

    assert first is second


def test_servarr_client_factory_builds_client_for_kind(monkeypatch):
    monkeypatch.setenv("LIDARR_URL", "http://lidarr.local:8686")
    monkeypatch.setenv("LIDARR_API_KEY", "key")

    registry = ServiceRegistry()
    client = registry.servarr("lidarr")

    assert isinstance(client, ServarrClient)


def test_prowlarr_client_factory(monkeypatch):
    monkeypatch.setenv("PROWLARR_URL", "http://prowlarr.local:9696")
    monkeypatch.setenv("PROWLARR_API_KEY", "key")

    registry = ServiceRegistry()
    client = registry.prowlarr()

    assert isinstance(client, ProwlarrClient)


def test_seerr_client_factory(monkeypatch):
    monkeypatch.setenv("SEERR_URL", "http://seerr.local:5055")
    monkeypatch.setenv("SEERR_API_KEY", "key")

    registry = ServiceRegistry()
    client = registry.seerr()

    assert isinstance(client, SeerrClient)
