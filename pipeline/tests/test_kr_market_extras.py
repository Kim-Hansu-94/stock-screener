"""수급·컨센서스·자사주 수집의 순수 로직 테스트.

네트워크는 타지 않는다 — 실제 소스가 살아 있는지는 프로브
(`python -m src.kr_market_extras_probe`)가 Actions에서 확인하고, 여기서는
"응답이 이런 모양으로 왔을 때 우리가 제대로 해석하는가"만 본다.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from src import buyback, consensus, investor_flow
from src.naver_api import find_first, rows_from_json, to_number


class TestNaverApiHelpers:
    def test_rows_from_json_찾는다_가장_긴_딕셔너리_리스트(self):
        payload = {"meta": [{"a": 1}], "result": {"stockList": [{"b": 1}, {"b": 2}, {"b": 3}]}}
        assert len(rows_from_json(payload)) == 3

    def test_rows_from_json_리스트가_없으면_빈_목록(self):
        assert rows_from_json({"a": 1, "b": "x"}) == []

    def test_find_first_중첩된_어디에_있든_찾는다(self):
        payload = {"a": {"b": {"targetPrice": "95,000"}}}
        assert find_first(payload, ("targetPrice",)) == "95,000"

    def test_find_first_빈값은_건너뛴다(self):
        # 네이버는 값이 없을 때 '-'나 빈 문자열을 준다. 그걸 값으로 받으면
        # "목표가 -" 같은 게 저장된다.
        payload = {"targetPrice": "-", "inner": {"targetPrice": 95000}}
        assert find_first(payload, ("targetPrice",)) == 95000

    @pytest.mark.parametrize(
        "raw,expected",
        [("1,234", 1234.0), ("+1,234", 1234.0), ("12.3%", 12.3), ("-", None), ("", None), (None, None)],
    )
    def test_to_number(self, raw, expected):
        assert to_number(raw) == expected


class TestInvestorFlow:
    def test_build_rows_금액은_수량_곱하기_종가(self, monkeypatch):
        today = date.today().isoformat()
        monkeypatch.setattr(
            investor_flow,
            "fetch_investor_flow",
            lambda ticker: (
                [{"date": today, "close": 70000.0, "foreign_net_qty": 100.0, "institution_net_qty": -50.0}],
                "테스트",
            ),
        )
        rows = investor_flow.build_rows("005930", "삼성전자")
        assert len(rows) == 1
        assert rows[0]["foreign_net_amount"] == 7_000_000
        assert rows[0]["institution_net_amount"] == -3_500_000
        assert rows[0]["source"] == "테스트"

    def test_build_rows_기간_밖은_버린다(self, monkeypatch):
        old = (date.today() - timedelta(days=120)).isoformat()
        recent = date.today().isoformat()
        monkeypatch.setattr(
            investor_flow,
            "fetch_investor_flow",
            lambda ticker: (
                [
                    {"date": old, "close": 1.0, "foreign_net_qty": 1.0, "institution_net_qty": 1.0},
                    {"date": recent, "close": 1.0, "foreign_net_qty": 1.0, "institution_net_qty": 1.0},
                ],
                "테스트",
            ),
        )
        rows = investor_flow.build_rows("005930", "삼성전자", days=60)
        assert [r["date"] for r in rows] == [recent]

    def test_build_rows_같은_날짜가_두_번_와도_한_번만(self, monkeypatch):
        # 페이지 경계에서 겹쳐 들어오는 경우. 행 수 로그가 부풀면 진단이 흐려진다.
        today = date.today().isoformat()
        row = {"date": today, "close": 1.0, "foreign_net_qty": 1.0, "institution_net_qty": 1.0}
        monkeypatch.setattr(investor_flow, "fetch_investor_flow", lambda t: ([row, dict(row)], "테스트"))
        assert len(investor_flow.build_rows("005930", "삼성전자")) == 1

    def test_수량이_없으면_금액도_None(self, monkeypatch):
        today = date.today().isoformat()
        monkeypatch.setattr(
            investor_flow,
            "fetch_investor_flow",
            lambda t: ([{"date": today, "close": 100.0, "foreign_net_qty": None, "institution_net_qty": 5.0}], "테스트"),
        )
        row = investor_flow.build_rows("005930", "삼성전자")[0]
        assert row["foreign_net_amount"] is None
        assert row["institution_net_amount"] == 500


class TestConsensus:
    def test_build_row_상승여력을_종가_대비로_낸다(self, monkeypatch):
        monkeypatch.setattr(
            consensus,
            "fetch_consensus",
            lambda t: ({"target_price": 110000.0, "opinion": "매수", "report_count": 12.0, "consensus_eps": 5000.0}, "테스트"),
        )
        row = consensus.build_row("005930", "삼성전자", "2026-09-10", 100000.0)
        assert row["upside_pct"] == pytest.approx(10.0)
        assert row["report_count"] == 12  # 정수로 저장

    def test_build_row_종가가_없으면_상승여력은_비운다(self, monkeypatch):
        monkeypatch.setattr(
            consensus,
            "fetch_consensus",
            lambda t: ({"target_price": 110000.0, "opinion": None, "report_count": None, "consensus_eps": None}, "테스트"),
        )
        row = consensus.build_row("005930", "삼성전자", "2026-09-10", None)
        assert row["upside_pct"] is None
        assert row["target_price"] == 110000.0


class TestBuyback:
    def test_기간_진행률은_시작과_끝_사이의_위치(self, monkeypatch):
        start = date.today() - timedelta(days=30)
        end = date.today() + timedelta(days=30)
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(
            buyback,
            "_detail",
            lambda c, k, e: [{"aq_pl_tot_amount": "1,000", "aq_pd_bgd": start.strftime("%Y%m%d"), "aq_pd_edd": end.strftime("%Y%m%d")}],
        )
        monkeypatch.setattr(
            buyback,
            "_disclosure_list",
            lambda c, k: [{"report_nm": "자기주식 취득 결정", "rcept_dt": "20260801", "rcept_no": "123"}],
        )
        row = buyback.build_row("005930", "삼성전자", "0012345")
        assert row is not None
        assert row["period_progress_pct"] == pytest.approx(50.0, abs=2)
        # 취득 금액이 공시에 없으면 금액 기준 진행률은 비운다 — 기간 기준으로
        # 대신 채우면 화면에서 근거를 구분할 수 없게 된다.
        assert row["amount_progress_pct"] is None
        assert row["latest_report_url"].endswith("rcpNo=123")

    def test_금액_진행률은_취득액_나누기_예정액(self, monkeypatch):
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(
            buyback,
            "_detail",
            lambda c, k, e: [{"aq_pl_tot_amount": "1000", "aq_amount_ac": "250"}],
        )
        monkeypatch.setattr(buyback, "_disclosure_list", lambda c, k: [])
        row = buyback.build_row("005930", "삼성전자", "0012345")
        assert row["amount_progress_pct"] == pytest.approx(25.0)

    def test_처분_공시는_매입과_구분한다(self, monkeypatch):
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(buyback, "_detail", lambda c, k, e: [])
        monkeypatch.setattr(
            buyback,
            "_disclosure_list",
            lambda c, k: [{"report_nm": "자기주식 처분 결정", "rcept_dt": "20260801", "rcept_no": "9"}],
        )
        row = buyback.build_row("005930", "삼성전자", "0012345")
        assert row["is_disposal"] is True

    def test_공시가_없으면_None(self, monkeypatch):
        # 예외가 아니라 None이어야 한다 — "자사주를 안 사는 회사"(대부분)와
        # "못 받았다"(진단 필요)를 구분하기 위해서다.
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(buyback, "_detail", lambda c, k, e: [])
        monkeypatch.setattr(buyback, "_disclosure_list", lambda c, k: [])
        assert buyback.build_row("005930", "삼성전자", "0012345") is None

    def test_키가_없으면_예외(self, monkeypatch):
        monkeypatch.setattr(buyback, "_api_key", lambda: None)
        with pytest.raises(RuntimeError, match="DART_API_KEY"):
            buyback.build_row("005930", "삼성전자", "0012345")
