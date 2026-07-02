"""
Behavioral tests for crawl/gsc.py — graceful-skip paths, the relative default
window, CLI arg parsing, and a fully mocked fetch_gsc round-trip.

No network and no Google client library are required: the heavy client is
monkeypatched in, and credential files are simulated with tmp_path.
"""

from __future__ import annotations

import datetime
import json

import pytest

import gsc

# ── graceful-skip paths ───────────────────────────────────────────────────────


def test_missing_package_graceful_skip(monkeypatch):
    """With the Google client absent, fetch_gsc reports available=False."""
    monkeypatch.setattr(gsc, "_GSC_AVAILABLE", False)
    result = gsc.fetch_gsc("sc-domain:example.com", "/does/not/matter.json")
    assert result["available"] is False
    assert "not installed" in result["reason"]


def test_missing_credentials_skip(monkeypatch, tmp_path):
    """Package present but credentials file missing → available=False."""
    monkeypatch.setattr(gsc, "_GSC_AVAILABLE", True)
    missing = tmp_path / "nope.json"
    result = gsc.fetch_gsc("sc-domain:example.com", str(missing))
    assert result["available"] is False
    assert "not found" in result["reason"]


# ── relative default window ───────────────────────────────────────────────────


def test_default_window_is_relative_to_a_fixed_today():
    """end trails today by the data lag; start is the window length earlier."""
    today = datetime.date(2026, 6, 29)
    start, end = gsc._default_window(today=today)
    assert end == "2026-06-26"  # 29 - DATA_LAG_DAYS(3)
    assert start == "2026-05-29"  # 26 - DEFAULT_WINDOW_DAYS(28)
    # The old hardcoded 2024 calendar window must be gone.
    assert "2024" not in start
    assert "2024" not in end


def test_default_window_tracks_today_not_2024():
    """Computed from date.today(): current year, ordered, correct span."""
    start, end = gsc._default_window()
    today = datetime.date.today()
    assert start < end
    start_d = datetime.date.fromisoformat(start)
    end_d = datetime.date.fromisoformat(end)
    assert end_d == today - datetime.timedelta(days=gsc.DATA_LAG_DAYS)
    assert (end_d - start_d).days == gsc.DEFAULT_WINDOW_DAYS
    assert start_d.year >= 2025  # never the stale 2024 default


# ── CLI parsing ───────────────────────────────────────────────────────────────


def test_build_parser_defaults_dates_to_none():
    """Date defaults are None so fetch_gsc can compute the relative window."""
    parser = gsc._build_parser()
    args = parser.parse_args(
        ["--property", "sc-domain:example.com", "--credentials", "/c.json"]
    )
    assert args.property == "sc-domain:example.com"
    assert args.credentials == "/c.json"
    assert args.start_date is None
    assert args.end_date is None
    assert args.rows == gsc.ROW_LIMIT


def test_build_parser_accepts_overrides():
    parser = gsc._build_parser()
    args = parser.parse_args(
        [
            "--property", "https://example.com/",
            "--credentials", "/c.json",
            "--start-date", "2025-01-01",
            "--end-date", "2025-01-31",
            "--rows", "500",
        ]
    )
    assert args.start_date == "2025-01-01"
    assert args.end_date == "2025-01-31"
    assert args.rows == 500


def test_build_parser_requires_property_and_credentials():
    parser = gsc._build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])


# ── behavioral fetch_gsc with a mocked Google client ──────────────────────────


def _install_mock_client(monkeypatch, tmp_path, rows):
    """Wire up a mocked googleapiclient build() + service_account and a creds
    file. Returns the query MagicMock so tests can inspect the request body."""
    from unittest.mock import MagicMock

    creds_file = tmp_path / "creds.json"
    creds_file.write_text("{}")

    mock_sa = MagicMock()
    mock_sa.Credentials.from_service_account_file.return_value = MagicMock()

    service = MagicMock()
    query = service.searchanalytics.return_value.query
    query.return_value.execute.return_value = {"rows": rows}
    mock_build = MagicMock(return_value=service)

    monkeypatch.setattr(gsc, "_GSC_AVAILABLE", True)
    monkeypatch.setattr(gsc, "_sa", mock_sa, raising=False)
    monkeypatch.setattr(gsc, "build", mock_build, raising=False)
    return creds_file, query, mock_build


def test_fetch_gsc_shapes_response_rows(monkeypatch, tmp_path):
    rows = [
        {"keys": ["seo audit", "https://example.com/"],
         "clicks": 42, "impressions": 1000, "ctr": 0.042, "position": 3.7},
    ]
    creds_file, query, _ = _install_mock_client(monkeypatch, tmp_path, rows)

    result = gsc.fetch_gsc(
        "sc-domain:example.com",
        str(creds_file),
        start_date="2025-03-01",
        end_date="2025-03-28",
        row_limit=500,
    )

    assert result == {
        "available": True,
        "property": "sc-domain:example.com",
        "rows": rows,
    }

    # The request body must carry the explicit window, dimensions and limit.
    body = query.call_args.kwargs["body"]
    assert body["startDate"] == "2025-03-01"
    assert body["endDate"] == "2025-03-28"
    assert body["dimensions"] == gsc.GSC_DIMENSIONS
    assert body["rowLimit"] == 500
    assert query.call_args.kwargs["siteUrl"] == "sc-domain:example.com"


def test_fetch_gsc_uses_relative_default_window_when_dates_omitted(
    monkeypatch, tmp_path
):
    creds_file, query, _ = _install_mock_client(monkeypatch, tmp_path, [])
    gsc.fetch_gsc("sc-domain:example.com", str(creds_file))
    expected_start, expected_end = gsc._default_window()
    body = query.call_args.kwargs["body"]
    assert body["startDate"] == expected_start
    assert body["endDate"] == expected_end


def test_fetch_gsc_wraps_api_errors(monkeypatch, tmp_path):
    creds_file, query, _ = _install_mock_client(monkeypatch, tmp_path, [])
    query.return_value.execute.side_effect = RuntimeError("boom")
    result = gsc.fetch_gsc("sc-domain:example.com", str(creds_file))
    assert result["available"] is False
    assert "GSC API error" in result["reason"]


# ── main() CLI entrypoint ─────────────────────────────────────────────────────


def test_main_prints_json_and_exits_nonzero_on_skip(monkeypatch, capsys):
    monkeypatch.setattr(
        gsc, "fetch_gsc", lambda **kw: {"available": False, "reason": "x"}
    )
    with pytest.raises(SystemExit) as exc:
        gsc.main(["--property", "sc-domain:example.com", "--credentials", "/c.json"])
    assert exc.value.code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["available"] is False


def test_main_exits_zero_on_success(monkeypatch, capsys):
    monkeypatch.setattr(
        gsc, "fetch_gsc", lambda **kw: {"available": True, "property": "p", "rows": []}
    )
    gsc.main(["--property", "p", "--credentials", "/c.json"])  # no SystemExit
    payload = json.loads(capsys.readouterr().out)
    assert payload["available"] is True
