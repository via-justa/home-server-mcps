from typing import Any

import httpx

from media_apps_mcp.config import ServiceInstance

_HINTS = {
    401: "check the configured API key for this service",
    403: "check the configured API key's permissions for this service",
    404: "resource not found - check the id",
    429: "rate limited by the upstream service, retry later",
}


class ApiError(Exception):
    """Raised for any non-2xx response from an upstream service."""

    def __init__(self, service_name: str, status_code: int, detail: str):
        self.service_name = service_name
        self.status_code = status_code
        hint = _HINTS.get(status_code)
        message = f"{service_name} API error {status_code}: {detail}"
        if hint:
            message += f" ({hint})"
        super().__init__(message)


class ApiClient:
    """Thin async JSON/REST client shared by all upstream service clients.

    Injects the service's API key as a header on every request and maps
    non-2xx responses to `ApiError` with a hint where one is known.
    """

    def __init__(self, instance: ServiceInstance, api_key_header: str = "X-Api-Key", timeout: float = 15.0):
        self.instance = instance
        self.api_key_header = api_key_header
        self.timeout = timeout

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        base_url = str(self.instance.base_url).rstrip("/")
        async with httpx.AsyncClient(
            base_url=base_url,
            headers={self.api_key_header: self.instance.api_key},
            timeout=self.timeout,
        ) as client:
            response = await client.request(method, path, **kwargs)

        if response.status_code >= 400:
            raise ApiError(self.instance.name, response.status_code, response.text[:200])
        if not response.content:
            return None
        return response.json()

    async def get(self, path: str, params: dict | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, json: Any = None) -> Any:
        return await self.request("POST", path, json=json)

    async def put(self, path: str, json: Any = None) -> Any:
        return await self.request("PUT", path, json=json)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)
