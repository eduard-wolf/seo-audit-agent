"""
Behavioral tests for kb/pgvector_store.py — dependency/DSN guards, the explicit
``%s::vector`` binding (fix for the broken psycopg2 fallback), and mocked
add()/search()/upsert round-trips.

No real PostgreSQL connection is opened: psycopg is replaced with a MagicMock
whose connect() yields a mock connection/cursor.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

import pgvector_store

# ── construction guards ───────────────────────────────────────────────────────


def test_init_raises_importerror_without_deps(monkeypatch):
    monkeypatch.setattr(pgvector_store, "_PGVECTOR_AVAILABLE", False)
    with pytest.raises(ImportError, match="psycopg"):
        pgvector_store.PgVectorStore(dsn="postgresql://u:p@h/db")


def test_init_raises_valueerror_without_dsn(monkeypatch):
    monkeypatch.setattr(pgvector_store, "_PGVECTOR_AVAILABLE", True)
    monkeypatch.delenv("PGVECTOR_DSN", raising=False)
    with pytest.raises(ValueError, match="No DSN"):
        pgvector_store.PgVectorStore(dsn=None)


def test_init_reads_dsn_from_environment(monkeypatch):
    conn, _ = _mock_psycopg(monkeypatch)
    monkeypatch.setenv("PGVECTOR_DSN", "postgresql://env/db")
    store = pgvector_store.PgVectorStore()
    assert store._dsn == "postgresql://env/db"
    pgvector_store.psycopg.connect.assert_called_once_with("postgresql://env/db")


# ── vector formatting (the chosen psycopg2-safe binding) ──────────────────────


def test_format_vector_renders_pgvector_literal():
    assert pgvector_store._format_vector([0.1, 0.2, 0.3]) == "[0.1,0.2,0.3]"
    assert pgvector_store._format_vector([]) == "[]"


def test_upsert_sql_has_on_conflict_and_vector_cast():
    assert "ON CONFLICT (id) DO UPDATE" in pgvector_store._UPSERT
    assert "EXCLUDED.vector" in pgvector_store._UPSERT
    # The vector placeholder must be cast so a text literal binds correctly.
    assert "%s::vector" in pgvector_store._UPSERT


# ── behavioral add()/search() with mocked psycopg ─────────────────────────────


def _mock_psycopg(monkeypatch):
    """Replace pgvector_store.psycopg with a mock; return (conn, cursor)."""
    cur = MagicMock(name="cursor")
    conn = MagicMock(name="connection")
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False

    fake_psycopg = MagicMock(name="psycopg")
    fake_psycopg.connect.return_value = conn

    monkeypatch.setattr(pgvector_store, "_PGVECTOR_AVAILABLE", True)
    monkeypatch.setattr(pgvector_store, "psycopg", fake_psycopg)
    return conn, cur


def test_setup_runs_ddl_on_construction(monkeypatch):
    conn, cur = _mock_psycopg(monkeypatch)
    pgvector_store.PgVectorStore(dsn="postgresql://u:p@h/db")
    executed = [c.args[0] for c in cur.execute.call_args_list]
    assert pgvector_store._CREATE_EXTENSION in executed
    assert pgvector_store._CREATE_TABLE in executed
    assert pgvector_store._CREATE_INDEX in executed
    conn.commit.assert_called()


def test_add_upserts_with_vector_literal(monkeypatch):
    conn, cur = _mock_psycopg(monkeypatch)
    store = pgvector_store.PgVectorStore(dsn="postgresql://u:p@h/db")
    cur.reset_mock()
    conn.reset_mock()

    store.add(
        "01-agg.md#0",
        [1.0, 2.0, 3.0],
        {"source": "01-agg.md", "heading": "Overview", "date": "2024-09", "text": "T"},
    )

    cur.execute.assert_called_once_with(
        pgvector_store._UPSERT,
        ("01-agg.md#0", "[1.0,2.0,3.0]", "01-agg.md", "Overview", "2024-09", "T"),
    )
    conn.commit.assert_called_once()


def test_add_defaults_missing_meta_to_empty_strings(monkeypatch):
    _, cur = _mock_psycopg(monkeypatch)
    store = pgvector_store.PgVectorStore(dsn="postgresql://u:p@h/db")
    cur.reset_mock()
    store.add("id#1", [0.5])
    params = cur.execute.call_args.args[1]
    assert params == ("id#1", "[0.5]", "", "", "", "")


def test_search_binds_vector_twice_and_shapes_rows(monkeypatch):
    conn, cur = _mock_psycopg(monkeypatch)
    cur.fetchall.return_value = [
        ("01-agg.md#0", "01-agg.md", "Overview", "2024-09", "body text", 0.875),
    ]
    store = pgvector_store.PgVectorStore(dsn="postgresql://u:p@h/db")
    cur.reset_mock()
    cur.fetchall.return_value = [
        ("01-agg.md#0", "01-agg.md", "Overview", "2024-09", "body text", 0.875),
    ]

    results = store.search([0.1, 0.2], k=3)

    cur.execute.assert_called_once_with(
        pgvector_store._SEARCH, ("[0.1,0.2]", "[0.1,0.2]", 3)
    )
    assert "%s::vector" in pgvector_store._SEARCH
    assert results == [
        {
            "id": "01-agg.md#0",
            "score": 0.875,
            "meta": {
                "source": "01-agg.md",
                "heading": "Overview",
                "date": "2024-09",
                "text": "body text",
            },
        }
    ]


def test_close_and_context_manager(monkeypatch):
    conn, _ = _mock_psycopg(monkeypatch)
    with pgvector_store.PgVectorStore(dsn="postgresql://u:p@h/db") as store:
        assert store is not None
    conn.close.assert_called_once()
