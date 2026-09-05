from media_apps_mcp.formatting import project_fields, project_many

ITEM = {
    "id": 1,
    "title": "Example",
    "overview": "A long description",
    "year": 2024,
    "internalDebugBlob": {"huge": "payload"},
}


def test_full_level_returns_item_unchanged():
    assert project_fields(ITEM, "full", compact_fields=["id", "title"]) == ITEM


def test_compact_level_keeps_only_compact_fields():
    result = project_fields(ITEM, "compact", compact_fields=["id", "title"])

    assert result == {"id": 1, "title": "Example"}


def test_compact_level_skips_missing_fields():
    result = project_fields(ITEM, "compact", compact_fields=["id", "not_a_real_field"])

    assert result == {"id": 1}


def test_standard_level_uses_standard_fields_when_given():
    result = project_fields(
        ITEM,
        "standard",
        compact_fields=["id", "title"],
        standard_fields=["id", "title", "year"],
    )

    assert result == {"id": 1, "title": "Example", "year": 2024}


def test_standard_level_falls_back_to_compact_fields_when_not_given():
    result = project_fields(ITEM, "standard", compact_fields=["id", "title"])

    assert result == {"id": 1, "title": "Example"}


def test_project_many_applies_to_each_item():
    items = [ITEM, {"id": 2, "title": "Second"}]

    result = project_many(items, "compact", compact_fields=["id", "title"])

    assert result == [{"id": 1, "title": "Example"}, {"id": 2, "title": "Second"}]
