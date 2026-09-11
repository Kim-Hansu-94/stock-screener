"""KIND 자기주식 체결내역 해석 테스트.

네트워크는 타지 않는다 — 소스가 살아 있는지는 프로브가 Actions에서 확인하고,
여기서는 **실제로 받은 모양의 응답을 우리가 제대로 해석하는가**만 본다.

아래 `_ROW`는 2026-09-11에 `/api/trstk/traded`가 실제로 준 행을 그대로 줄인 것이다
(SK하이닉스 000660, 하루 650,000주 체결).
"""
from __future__ import annotations

from datetime import date

import pytest

from src import trstk


def _row(**over):
    base = {
        "tot_cnt": 17,
        "rep_isu_srt_cd": "000660",
        "com_abbrv": "SK하이닉스",
        "trd_dd": "20260904",
        "trstk_appl_qty": "650000",
        "trstk_trd_qty": "650000",
        "trstk_acqstdisp_tp_cd": "1",
    }
    base.update(over)
    return base


class _FakeSession:
    """페이지별 응답을 미리 정해 두고 돌려준다."""

    def __init__(self, pages):
        self.pages = pages
        self.calls: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(params or {})
        page = int((params or {}).get("pageNo", 1))
        return _FakeResponse(self.pages.get(page, []))

    def close(self):
        pass


class _FakeResponse:
    def __init__(self, rows, status_code=200, ok=True):
        self._rows = rows
        self.status_code = status_code
        self._ok = ok
        self.text = ""

    def json(self):
        return {
            "resultOk": self._ok,
            "resultCode": "S0000" if self._ok else "E0002",
            "message": None if self._ok else "파라미터 검증 실패",
            "dataList": self._rows,
            "dataListCount": len(self._rows),
        }


class TestFetchTrades:
    def test_체결행을_날짜_오름차순으로_정규화한다(self, monkeypatch):
        monkeypatch.setattr(trstk, "PAUSE_SECONDS", 0)
        session = _FakeSession({1: [_row(trd_dd="20260904"), _row(trd_dd="20260902")]})

        trades = trstk.fetch_trades("000660", "SK하이닉스", date(2026, 8, 20), date(2026, 9, 11), session=session)

        assert [t["date"] for t in trades] == ["2026-09-02", "2026-09-04"]
        assert trades[0]["traded_qty"] == 650_000
        assert trades[0]["applied_qty"] == 650_000
        assert trades[0]["ticker"] == "000660"

    def test_날짜는_대시_없는_형식으로_보낸다(self, monkeypatch):
        # 2026-09-11 실측으로 확정된 형식이다. 대시를 붙이면 조회가 어긋난다.
        monkeypatch.setattr(trstk, "PAUSE_SECONDS", 0)
        session = _FakeSession({1: [_row()]})

        trstk.fetch_trades("000660", "SK하이닉스", date(2026, 8, 20), date(2026, 9, 11), session=session)

        assert session.calls[0]["fromDate"] == "20260820"
        assert session.calls[0]["toDate"] == "20260911"
        assert session.calls[0]["repIsuSrtCd"] == "000660"

    def test_처분_신탁은_빼고_취득만_센다(self, monkeypatch):
        # 진행률은 "얼마나 샀나"이므로 처분(2)·신탁(0)을 더하면 값이 부풀거나 어긋난다.
        monkeypatch.setattr(trstk, "PAUSE_SECONDS", 0)
        session = _FakeSession(
            {
                1: [
                    _row(trd_dd="20260901", trstk_acqstdisp_tp_cd="1"),
                    _row(trd_dd="20260902", trstk_acqstdisp_tp_cd="2"),
                    _row(trd_dd="20260903", trstk_acqstdisp_tp_cd="0"),
                ]
            }
        )

        trades = trstk.fetch_trades("000660", "SK하이닉스", date(2026, 8, 20), date(2026, 9, 11), session=session)

        assert [t["date"] for t in trades] == ["2026-09-01"]

    def test_전체건수는_행_안에_있고_그걸로_페이지를_멈춘다(self, monkeypatch):
        # tot_cnt가 응답 본문이 아니라 **각 행 안에** 들어 있다. 이걸 놓치면
        # 빈 페이지를 받을 때까지 MAX_PAGES만큼 계속 두드리게 된다.
        monkeypatch.setattr(trstk, "PAUSE_SECONDS", 0)
        session = _FakeSession(
            {
                1: [_row(tot_cnt=3, trd_dd="20260901"), _row(tot_cnt=3, trd_dd="20260902")],
                2: [_row(tot_cnt=3, trd_dd="20260903")],
                3: [_row(tot_cnt=3, trd_dd="20260904")],
            }
        )

        trades = trstk.fetch_trades("000660", "SK하이닉스", date(2026, 8, 20), date(2026, 9, 11), session=session)

        assert len(trades) == 3
        assert [c["pageNo"] for c in session.calls] == [1, 2]

    def test_조건이_틀리면_사유가_드러나는_에러(self, monkeypatch):
        # 400 + "파라미터 검증 실패"는 주소가 아니라 조건이 틀렸다는 뜻이다.
        # 조용히 빈 목록을 주면 "자사주를 안 산 회사"와 구분이 안 된다.
        monkeypatch.setattr(trstk, "PAUSE_SECONDS", 0)

        class _Bad(_FakeSession):
            def get(self, url, params=None, headers=None, timeout=None):
                return _FakeResponse([], status_code=400, ok=False)

        with pytest.raises(trstk.TrstkError, match="파라미터 검증 실패"):
            trstk.fetch_trades("000660", "SK하이닉스", date(2026, 8, 20), date(2026, 9, 11), session=_Bad({}))


class TestSummarize:
    def test_누적_체결량과_진행률(self):
        trades = [
            {"date": "2026-09-01", "traded_qty": 650_000},
            {"date": "2026-09-02", "traded_qty": 650_000},
        ]
        out = trstk.summarize(trades, planned_qty=24_070_000)

        assert out["confirmed_qty"] == 1_300_000
        assert out["confirmed_days"] == 2
        assert out["confirmed_through"] == "2026-09-02"
        assert out["confirmed_progress_pct"] == pytest.approx(5.4, abs=0.1)

    def test_계획_수량을_모르면_진행률은_None(self):
        # 수량은 알아도 분모가 없으면 %를 만들 수 없다. 0으로 두면
        # "아직 안 샀다"로 읽히므로 반드시 None이어야 한다.
        out = trstk.summarize([{"date": "2026-09-01", "traded_qty": 650_000}], planned_qty=None)

        assert out["confirmed_qty"] == 650_000
        assert out["confirmed_progress_pct"] is None

    def test_계획이_줄어도_100퍼센트를_넘기지_않는다(self):
        # 정정 공시로 취득 예정 수량이 줄면 누적이 계획을 넘을 수 있다.
        out = trstk.summarize([{"date": "2026-09-01", "traded_qty": 200}], planned_qty=100)

        assert out["confirmed_progress_pct"] == 100.0

    def test_체결이_없으면_전부_None(self):
        out = trstk.summarize([], planned_qty=1000)

        assert out == {
            "confirmed_qty": None,
            "confirmed_progress_pct": None,
            "confirmed_days": None,
            "confirmed_through": None,
        }
