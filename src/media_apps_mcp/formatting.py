from typing import Literal

DetailLevel = Literal["compact", "standard", "full"]


def project_fields(
    item: dict,
    level: DetailLevel,
    compact_fields: list[str],
    standard_fields: list[str] | None = None,
) -> dict:
    """Trim an upstream API response down to the fields a given detail level needs.

    `full` passes the item through untouched. `compact`/`standard` keep only the
    named fields (missing ones are silently skipped), so callers can request as
    little or as much detail as they need instead of paying for the whole payload.
    """
    if level == "full":
        return item

    fields = standard_fields if level == "standard" and standard_fields else compact_fields
    return {field: item[field] for field in fields if field in item}


def project_many(
    items: list[dict],
    level: DetailLevel,
    compact_fields: list[str],
    standard_fields: list[str] | None = None,
) -> list[dict]:
    return [project_fields(item, level, compact_fields, standard_fields) for item in items]
