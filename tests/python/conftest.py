"""
Shared pytest setup for the Python adapter tests.

`crawl/gsc.py` and `kb/pgvector_store.py` are standalone scripts (no package
structure), so we put their directories on sys.path to import them by module
name without requiring an installable package.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]

for _subdir in ("crawl", "kb"):
    _path = str(_ROOT / _subdir)
    if _path not in sys.path:
        sys.path.insert(0, _path)
