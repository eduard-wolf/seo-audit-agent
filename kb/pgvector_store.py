"""
kb/pgvector_store.py — pgvector-backed vector store for production use.

This module provides the same logical interface as kb/store.mjs (add, search)
but persists embeddings in a PostgreSQL database with the pgvector extension.

Runtime dependency (NOT required for the Node offline build):
    pip install "psycopg[binary]"      # psycopg3 preferred; psycopg2 also works

Embeddings are bound as pgvector text literals with a ``%s::vector`` cast, so
the pgvector Python adapter is NOT needed. The import is guarded with
try/except so this file stays importable without psycopg installed.

SQL setup (run once against your Postgres instance):
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS kb_chunks (
        id        TEXT PRIMARY KEY,
        vector    vector(256),
        source    TEXT,
        heading   TEXT,
        date      TEXT,
        content   TEXT
    );
    CREATE INDEX IF NOT EXISTS kb_chunks_vector_idx
        ON kb_chunks USING ivfflat (vector vector_cosine_ops)
        WITH (lists = 100);

pgvector distance operators:
    <->  Euclidean (L2) distance
    <=>  Cosine distance  ← used here (1 - cosine_similarity)
    <#>  Inner product (negative)

Usage:
    from kb.pgvector_store import PgVectorStore

    store = PgVectorStore(dsn="postgresql://user:pass@localhost/dbname")
    store.add(
        "doc-1#0",
        embedding_vector,
        {"source": "01-agg.md", "heading": "Overview", "date": "2024-09", "text": "..."},
    )
    results = store.search(query_vector, k=4)
    # → [{"id": ..., "score": ..., "meta": {"source": ..., "heading": ..., ...}}, ...]
"""

from __future__ import annotations

import os
from typing import Any

# ── Lazy imports of runtime dependencies ─────────────────────────────────────
# psycopg3 is preferred (see requirements.txt) but psycopg2 works identically:
# embeddings are bound as a pgvector text literal cast with ``%s::vector`` (see
# ``_format_vector``), so neither the pgvector Python adapter nor
# ``register_vector`` is required for correct INSERTs/queries.

try:
    import psycopg  # psycopg3 (preferred)

    _PGVECTOR_AVAILABLE = True
except ImportError:
    try:
        import psycopg2 as psycopg

        _PGVECTOR_AVAILABLE = True
    except ImportError:
        _PGVECTOR_AVAILABLE = False
        psycopg = None


def _format_vector(vector: list[float]) -> str:
    """
    Render an embedding as a pgvector text literal, e.g. ``"[0.1,0.2,0.3]"``.

    Bound to a ``%s::vector`` placeholder, this works identically under psycopg2
    and psycopg3 without relying on the pgvector Python type adapter — a raw
    ``list[float]`` would otherwise serialize as a Postgres array literal, which
    does NOT implicitly cast to ``vector`` and breaks the INSERT.
    """
    return "[" + ",".join(map(str, vector)) + "]"


# ── DDL ───────────────────────────────────────────────────────────────────────

_CREATE_EXTENSION = "CREATE EXTENSION IF NOT EXISTS vector;"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS kb_chunks (
    id      TEXT PRIMARY KEY,
    vector  vector(256),
    source  TEXT,
    heading TEXT,
    date    TEXT,
    content TEXT
);
"""

_CREATE_INDEX = """
CREATE INDEX IF NOT EXISTS kb_chunks_vector_idx
    ON kb_chunks USING ivfflat (vector vector_cosine_ops)
    WITH (lists = 100);
"""

_UPSERT = """
INSERT INTO kb_chunks (id, vector, source, heading, date, content)
VALUES (%s, %s::vector, %s, %s, %s, %s)
ON CONFLICT (id) DO UPDATE
    SET vector  = EXCLUDED.vector,
        source  = EXCLUDED.source,
        heading = EXCLUDED.heading,
        date    = EXCLUDED.date,
        content = EXCLUDED.content;
"""

# Cosine distance (<=>); ORDER BY ASC gives most similar first (distance → 0).
# score = 1 - cosine_distance to match the Node store's cosine similarity convention.
_SEARCH = """
SELECT id, source, heading, date, content,
       1 - (vector <=> %s::vector) AS score
FROM   kb_chunks
ORDER  BY vector <=> %s::vector
LIMIT  %s;
"""


# ── PgVectorStore class ───────────────────────────────────────────────────────


class PgVectorStore:
    """
    pgvector-backed vector store.

    Parameters
    ----------
    dsn : str
        PostgreSQL connection string, e.g.
        "postgresql://user:pass@localhost:5432/dbname"
        Falls back to the PGVECTOR_DSN environment variable if not provided.
    """

    def __init__(self, dsn: str | None = None) -> None:
        if not _PGVECTOR_AVAILABLE:
            raise ImportError(
                "psycopg (psycopg3) or psycopg2 and pgvector are required. "
                "Install with: pip install psycopg[binary] pgvector"
            )

        self._dsn = dsn or os.environ.get("PGVECTOR_DSN", "")
        if not self._dsn:
            raise ValueError(
                "No DSN provided. Pass dsn= or set the PGVECTOR_DSN environment variable."
            )

        self._conn = psycopg.connect(self._dsn)
        self._setup()

    def _setup(self) -> None:
        """Create extension, table, and index if they don't exist."""
        with self._conn.cursor() as cur:
            cur.execute(_CREATE_EXTENSION)
            cur.execute(_CREATE_TABLE)
            cur.execute(_CREATE_INDEX)
        self._conn.commit()

    def add(
        self,
        id: str,
        vector: list[float],
        meta: dict[str, Any] | None = None,
    ) -> None:
        """
        Upsert a document chunk.

        Parameters
        ----------
        id : str
            Unique chunk identifier (e.g. "01-agg.md#0").
        vector : list[float]
            256-dimensional embedding vector.
        meta : dict, optional
            Expected keys: source, heading, date, text.
        """
        meta = meta or {}
        with self._conn.cursor() as cur:
            cur.execute(
                _UPSERT,
                (
                    id,
                    _format_vector(vector),
                    meta.get("source", ""),
                    meta.get("heading", ""),
                    meta.get("date", ""),
                    meta.get("text", ""),
                ),
            )
        self._conn.commit()

    def search(
        self,
        vector: list[float],
        k: int = 4,
    ) -> list[dict[str, Any]]:
        """
        Find the k nearest chunks by cosine similarity.

        Parameters
        ----------
        vector : list[float]
            Query embedding (must be length 256).
        k : int
            Number of results to return.

        Returns
        -------
        list of dicts with keys: id, score, meta
        """
        query_vec = _format_vector(vector)
        with self._conn.cursor() as cur:
            cur.execute(_SEARCH, (query_vec, query_vec, k))
            rows = cur.fetchall()

        return [
            {
                "id": row[0],
                "score": float(row[5]),
                "meta": {
                    "source":  row[1],
                    "heading": row[2],
                    "date":    row[3],
                    "text":    row[4],
                },
            }
            for row in rows
        ]

    def close(self) -> None:
        """Close the database connection."""
        if self._conn:
            self._conn.close()

    def __enter__(self) -> PgVectorStore:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
