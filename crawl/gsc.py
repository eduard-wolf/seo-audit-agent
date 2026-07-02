"""
crawl/gsc.py — Google Search Console enrichment touchpoint.

Runtime dependency: google-api-python-client (see requirements.txt).
The import is guarded with try/except so this file is importable — and the
module's graceful-skip logic works — even without the package installed.

Usage:
    python3 crawl/gsc.py --property "sc-domain:example.com" \\
                         --credentials /path/to/service-account.json

    Or in code:
        from crawl.gsc import fetch_gsc
        data = fetch_gsc("sc-domain:example.com", "/path/to/service-account.json")
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from typing import Any

# ── Lazy import of the Google API client ──────────────────────────────────────
# Runtime requirement: pip install google-api-python-client google-auth
# Without these, fetch_gsc() returns {'available': False, 'reason': ...}

try:
    from google.oauth2 import service_account as _sa
    from googleapiclient.discovery import build

    _GSC_AVAILABLE = True
except ImportError:
    _GSC_AVAILABLE = False


# ── Public interface ──────────────────────────────────────────────────────────

GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]
GSC_DIMENSIONS = ["query", "page"]
ROW_LIMIT = 1000

# Default report window, computed relative to today (never hardcoded).
# Search Console retains roughly the last 16 months of data and processes
# clicks/impressions with a ~2-3 day lag, so the default window ends a few
# days back and covers the most recent fully-available 28 days.
DEFAULT_WINDOW_DAYS = 28
DATA_LAG_DAYS = 3


def _default_window(today: datetime.date | None = None) -> tuple[str, str]:
    """
    Return (start_date, end_date) ISO strings for the default report window.

    Computed from ``datetime.date.today()`` (not a hardcoded calendar year):
    ``end`` trails today by ``DATA_LAG_DAYS`` to respect GSC's processing lag,
    and ``start`` is ``DEFAULT_WINDOW_DAYS`` earlier. ``today`` is injectable
    for deterministic testing.
    """
    today = today or datetime.date.today()
    end = today - datetime.timedelta(days=DATA_LAG_DAYS)
    start = end - datetime.timedelta(days=DEFAULT_WINDOW_DAYS)
    return start.isoformat(), end.isoformat()


def fetch_gsc(
    property_url: str,
    credentials_path: str,
    *,
    start_date: str | None = None,
    end_date: str | None = None,
    row_limit: int = ROW_LIMIT,
) -> dict[str, Any]:
    """
    Fetch top queries and page performance from Google Search Console.

    Parameters
    ----------
    property_url : str
        The GSC property identifier, e.g. "sc-domain:example.com" or
        "https://example.com/".
    credentials_path : str
        Path to a service-account JSON key file with Search Console access.
    start_date : str, optional
        ISO date for the start of the report window (YYYY-MM-DD). When omitted,
        a window relative to today is used (see ``_default_window``).
    end_date : str, optional
        ISO date for the end of the report window (YYYY-MM-DD). When omitted,
        a window relative to today is used (see ``_default_window``).
    row_limit : int
        Maximum rows to return per request (max 25 000 per GSC API call).

    Returns
    -------
    dict
        On success:
            {
                "available": True,
                "property": "<property_url>",
                "rows": [
                    {
                        "keys": ["query", "page"],
                        "clicks": int,
                        "impressions": int,
                        "ctr": float,
                        "position": float
                    },
                    ...
                ]
            }
        On graceful skip (missing package or credentials):
            {"available": False, "reason": "<human-readable reason>"}
    """
    # Check runtime dependency
    if not _GSC_AVAILABLE:
        return {
            "available": False,
            "reason": (
                "google-api-python-client / google-auth not installed. "
                "Run: pip install google-api-python-client google-auth"
            ),
        }

    # Check credentials file
    if not os.path.isfile(credentials_path):
        return {
            "available": False,
            "reason": f"Credentials file not found: {credentials_path!r}",
        }

    # Resolve the report window relative to today unless explicitly overridden.
    if start_date is None or end_date is None:
        default_start, default_end = _default_window()
        start_date = start_date or default_start
        end_date = end_date or default_end

    try:
        creds = _sa.Credentials.from_service_account_file(
            credentials_path, scopes=GSC_SCOPES
        )
        service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)

        request_body = {
            "startDate": start_date,
            "endDate": end_date,
            "dimensions": GSC_DIMENSIONS,
            "rowLimit": row_limit,
        }

        response = (
            service.searchanalytics()
            .query(siteUrl=property_url, body=request_body)
            .execute()
        )

        rows = response.get("rows", [])
        return {
            "available": True,
            "property": property_url,
            "rows": rows,
        }

    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "reason": f"GSC API error: {exc}",
        }


# ── CLI ───────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch Google Search Console performance data for a property.",
        epilog=(
            "Runtime requirements: google-api-python-client, google-auth\n"
            "Install with: pip install google-api-python-client google-auth"
        ),
    )
    parser.add_argument(
        "--property",
        required=True,
        metavar="PROPERTY_URL",
        help='GSC property URL, e.g. "sc-domain:example.com"',
    )
    parser.add_argument(
        "--credentials",
        required=True,
        metavar="PATH",
        help="Path to service-account JSON key file",
    )
    parser.add_argument(
        "--start-date",
        default=None,
        metavar="YYYY-MM-DD",
        help=(
            f"Report start date (default: {DEFAULT_WINDOW_DAYS + DATA_LAG_DAYS} "
            "days ago, relative to today)"
        ),
    )
    parser.add_argument(
        "--end-date",
        default=None,
        metavar="YYYY-MM-DD",
        help=(
            f"Report end date (default: {DATA_LAG_DAYS} days ago, to respect "
            "GSC's data lag)"
        ),
    )
    parser.add_argument(
        "--rows",
        type=int,
        default=ROW_LIMIT,
        metavar="N",
        help=f"Max rows to return (default: {ROW_LIMIT})",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)

    result = fetch_gsc(
        property_url=args.property,
        credentials_path=args.credentials,
        start_date=args.start_date,
        end_date=args.end_date,
        row_limit=args.rows,
    )

    print(json.dumps(result, indent=2))

    if not result["available"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
