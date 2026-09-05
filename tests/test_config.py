import pytest

from media_apps_mcp.config import ServiceInstance, get_default_instance, load_service_instances


def write_yaml(path, content):
    path.write_text(content)
    return str(path)


def test_single_instance_from_url_and_key_env_vars(monkeypatch):
    monkeypatch.setenv("SONARR_URL", "http://sonarr.local:8989")
    monkeypatch.setenv("SONARR_API_KEY", "abc123")

    instances = load_service_instances("sonarr")

    assert instances == [
        ServiceInstance(
            id="default",
            name="sonarr",
            base_url="http://sonarr.local:8989",
            api_key="abc123",
            is_default=True,
        )
    ]


def test_multi_instance_from_json_env_var(monkeypatch):
    monkeypatch.delenv("RADARR_URL", raising=False)
    monkeypatch.delenv("RADARR_API_KEY", raising=False)
    monkeypatch.setenv(
        "RADARR_INSTANCES",
        '[{"id": "hd", "name": "Radarr HD", "base_url": "http://radarr:7878", "api_key": "k1"},'
        '{"id": "4k", "name": "Radarr 4K", "base_url": "http://radarr4k:7878", "api_key": "k2", "is_default": true}]',
    )

    instances = load_service_instances("radarr")

    assert [i.id for i in instances] == ["hd", "4k"]
    assert get_default_instance(instances).id == "4k"


def test_multi_instance_json_defaults_first_to_default_when_none_marked(monkeypatch):
    monkeypatch.delenv("LIDARR_URL", raising=False)
    monkeypatch.delenv("LIDARR_API_KEY", raising=False)
    monkeypatch.setenv(
        "LIDARR_INSTANCES",
        '[{"id": "main", "name": "Lidarr", "base_url": "http://lidarr:8686", "api_key": "k1"}]',
    )

    instances = load_service_instances("lidarr")

    assert get_default_instance(instances).id == "main"
    assert get_default_instance(instances).is_default is True


def test_missing_service_returns_empty_list(monkeypatch):
    monkeypatch.delenv("PROFILARR_URL", raising=False)
    monkeypatch.delenv("PROFILARR_API_KEY", raising=False)
    monkeypatch.delenv("PROFILARR_INSTANCES", raising=False)

    assert load_service_instances("profilarr") == []


def test_get_default_instance_returns_none_when_empty():
    assert get_default_instance([]) is None


def test_yaml_config_used_when_no_env_vars_set(tmp_path, monkeypatch):
    monkeypatch.delenv("SEERR_URL", raising=False)
    monkeypatch.delenv("SEERR_API_KEY", raising=False)
    monkeypatch.delenv("SEERR_INSTANCES", raising=False)
    config_path = write_yaml(
        tmp_path / "config.yaml",
        """
services:
  seerr:
    - id: default
      name: Seerr
      base_url: http://seerr.local:5055
      api_key: yaml-key
      is_default: true
""",
    )

    instances = load_service_instances("seerr", config_path=config_path)

    assert instances == [
        ServiceInstance(
            id="default", name="Seerr", base_url="http://seerr.local:5055", api_key="yaml-key", is_default=True
        )
    ]


def test_yaml_config_defaults_first_instance_when_none_marked(tmp_path, monkeypatch):
    monkeypatch.delenv("PROWLARR_URL", raising=False)
    monkeypatch.delenv("PROWLARR_API_KEY", raising=False)
    monkeypatch.delenv("PROWLARR_INSTANCES", raising=False)
    config_path = write_yaml(
        tmp_path / "config.yaml",
        """
services:
  prowlarr:
    - id: main
      name: Prowlarr
      base_url: http://prowlarr.local:9696
      api_key: yaml-key
""",
    )

    instances = load_service_instances("prowlarr", config_path=config_path)

    assert get_default_instance(instances).id == "main"


def test_env_url_and_key_take_priority_over_yaml_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SONARR_URL", "http://from-env:8989")
    monkeypatch.setenv("SONARR_API_KEY", "env-key")
    config_path = write_yaml(
        tmp_path / "config.yaml",
        """
services:
  sonarr:
    - id: yaml-instance
      name: Sonarr from YAML
      base_url: http://from-yaml:8989
      api_key: yaml-key
""",
    )

    instances = load_service_instances("sonarr", config_path=config_path)

    assert len(instances) == 1
    assert instances[0].id == "default"
    assert str(instances[0].base_url) == "http://from-env:8989/"


def test_env_instances_json_takes_priority_over_yaml_config(tmp_path, monkeypatch):
    monkeypatch.delenv("RADARR_URL", raising=False)
    monkeypatch.delenv("RADARR_API_KEY", raising=False)
    monkeypatch.setenv(
        "RADARR_INSTANCES",
        '[{"id": "from-env", "name": "Radarr", "base_url": "http://radarr-env:7878", "api_key": "k"}]',
    )
    config_path = write_yaml(
        tmp_path / "config.yaml",
        """
services:
  radarr:
    - id: from-yaml
      name: Radarr from YAML
      base_url: http://radarr-yaml:7878
      api_key: yaml-key
""",
    )

    instances = load_service_instances("radarr", config_path=config_path)

    assert [i.id for i in instances] == ["from-env"]


def test_missing_yaml_file_returns_empty_list(tmp_path, monkeypatch):
    monkeypatch.delenv("LIDARR_URL", raising=False)
    monkeypatch.delenv("LIDARR_API_KEY", raising=False)
    monkeypatch.delenv("LIDARR_INSTANCES", raising=False)

    instances = load_service_instances("lidarr", config_path=str(tmp_path / "does-not-exist.yaml"))

    assert instances == []


def test_yaml_config_service_not_listed_returns_empty_list(tmp_path, monkeypatch):
    monkeypatch.delenv("LIDARR_URL", raising=False)
    monkeypatch.delenv("LIDARR_API_KEY", raising=False)
    monkeypatch.delenv("LIDARR_INSTANCES", raising=False)
    config_path = write_yaml(
        tmp_path / "config.yaml",
        """
services:
  sonarr:
    - id: default
      name: Sonarr
      base_url: http://sonarr.local:8989
      api_key: yaml-key
""",
    )

    instances = load_service_instances("lidarr", config_path=config_path)

    assert instances == []


def test_default_config_path_comes_from_env_var(tmp_path, monkeypatch):
    monkeypatch.delenv("SHELFMARK_URL", raising=False)
    monkeypatch.delenv("SHELFMARK_API_KEY", raising=False)
    monkeypatch.delenv("SHELFMARK_INSTANCES", raising=False)
    config_path = write_yaml(
        tmp_path / "config.yaml",
        """
services:
  shelfmark:
    - id: default
      name: Shelfmark
      base_url: http://shelfmark.local:8084
      api_key: yaml-key
""",
    )
    monkeypatch.setenv("MEDIA_APPS_MCP_CONFIG", config_path)

    instances = load_service_instances("shelfmark")

    assert instances[0].name == "Shelfmark"
