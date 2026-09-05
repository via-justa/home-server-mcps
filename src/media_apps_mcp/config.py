import json
import os

import yaml
from pydantic import BaseModel, HttpUrl

DEFAULT_CONFIG_PATH_ENV_VAR = "MEDIA_APPS_MCP_CONFIG"
DEFAULT_CONFIG_PATH = "config.yaml"


class ServiceInstance(BaseModel):
    id: str
    name: str
    base_url: HttpUrl
    api_key: str
    is_default: bool = False


def _mark_first_as_default_if_none_are(instances: list[ServiceInstance]) -> list[ServiceInstance]:
    if instances and not any(i.is_default for i in instances):
        instances[0] = instances[0].model_copy(update={"is_default": True})
    return instances


def _load_yaml_instances(service: str, config_path: str) -> list[ServiceInstance]:
    if not os.path.isfile(config_path):
        return []
    with open(config_path) as f:
        data = yaml.safe_load(f) or {}
    raw_list = data.get("services", {}).get(service, [])
    instances = [ServiceInstance(**item) for item in raw_list]
    return _mark_first_as_default_if_none_are(instances)


def load_service_instances(service: str, config_path: str | None = None) -> list[ServiceInstance]:
    """Load configured instances for a service.

    Priority, highest first:
    1. `{SERVICE}_INSTANCES` env var — a JSON array of instance objects.
    2. `{SERVICE}_URL` + `{SERVICE}_API_KEY` env vars — a single default instance.
    3. A YAML config file (`{config_path}`, or the `MEDIA_APPS_MCP_CONFIG` env
       var, or `./config.yaml`) with a `services.{service}` list in the same shape.

    Exactly one instance is marked default: whichever sets `is_default: true`,
    or the first one if none do.
    """
    prefix = service.upper()

    raw_instances = os.environ.get(f"{prefix}_INSTANCES")
    if raw_instances:
        instances = [ServiceInstance(**item) for item in json.loads(raw_instances)]
        return _mark_first_as_default_if_none_are(instances)

    base_url = os.environ.get(f"{prefix}_URL")
    api_key = os.environ.get(f"{prefix}_API_KEY")
    if base_url and api_key:
        return [
            ServiceInstance(
                id="default",
                name=service,
                base_url=base_url,
                api_key=api_key,
                is_default=True,
            )
        ]

    if config_path is None:
        config_path = os.environ.get(DEFAULT_CONFIG_PATH_ENV_VAR, DEFAULT_CONFIG_PATH)
    return _load_yaml_instances(service, config_path)


def get_default_instance(instances: list[ServiceInstance]) -> ServiceInstance | None:
    return next((i for i in instances if i.is_default), None)
