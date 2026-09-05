from media_apps_mcp.clients.prowlarr import ProwlarrClient
from media_apps_mcp.clients.seerr import SeerrClient
from media_apps_mcp.clients.servarr import ServarrClient, ServarrKind
from media_apps_mcp.config import ServiceInstance, get_default_instance, load_service_instances


class ServiceRegistry:
    """Loads configured service instances once and hands out clients for them.

    Tools depend on this instead of constructing clients directly, so tests
    can substitute a fake registry instead of standing up real HTTP mocks.
    """

    def __init__(self):
        self._instances_cache: dict[str, list[ServiceInstance]] = {}

    def instances(self, service: str) -> list[ServiceInstance]:
        if service not in self._instances_cache:
            self._instances_cache[service] = load_service_instances(service)
        return self._instances_cache[service]

    def instance(self, service: str, instance_id: str | None = None) -> ServiceInstance:
        instances = self.instances(service)
        if not instances:
            prefix = service.upper()
            raise ValueError(
                f"No {service} instance configured. Set {prefix}_URL and {prefix}_API_KEY "
                f"(or {prefix}_INSTANCES for multiple)."
            )
        if instance_id is None:
            return get_default_instance(instances) or instances[0]
        for candidate in instances:
            if candidate.id == instance_id:
                return candidate
        known = ", ".join(i.id for i in instances)
        raise ValueError(f"Unknown {service} instance id '{instance_id}'. Configured ids: {known}")

    def servarr(self, kind: ServarrKind, instance_id: str | None = None) -> ServarrClient:
        return ServarrClient(self.instance(kind, instance_id), kind=kind)

    def prowlarr(self, instance_id: str | None = None) -> ProwlarrClient:
        return ProwlarrClient(self.instance("prowlarr", instance_id))

    def seerr(self, instance_id: str | None = None) -> SeerrClient:
        return SeerrClient(self.instance("seerr", instance_id))
