"""Unit tests for thetadata_dump.py helpers (no ThetaData account needed). Run: python -m pytest scripts/"""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import thetadata_dump as td  # noqa: E402


def test_out_path_layout():
    assert str(td.out_path("/a", "SPXW", "0dte", dt.date(2025, 3, 12))) == "/a/SPXW/0dte/2025/2025-03-12.parquet"
    assert str(td.out_path("/a", "SPXW", "chain", dt.date(2025, 3, 12))) == "/a/SPXW/chain/2025/2025-03-12.parquet"


def test_weekdays_skip_weekends():
    days = td.weekdays(dt.date(2025, 3, 7), dt.date(2025, 3, 11))
    assert [d.isoformat() for d in days] == ["2025-03-07", "2025-03-10", "2025-03-11"]


def test_retry_returns_none_on_no_data():
    class NoData(Exception):
        pass

    def boom():
        raise NoData()

    assert td.retry(boom, "x", NoData) is None


def test_retry_raises_no_access_on_permission_denied():
    def denied():
        raise RuntimeError("PERMISSION_DENIED: subscription")

    try:
        td.retry(denied, "x", KeyError)
    except td.NoAccess:
        return
    raise AssertionError("expected NoAccess")
