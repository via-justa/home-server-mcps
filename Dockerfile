FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src/ src/
RUN uv sync --frozen --no-dev

ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000
EXPOSE 8000

CMD ["uv", "run", "media-apps-mcp"]
