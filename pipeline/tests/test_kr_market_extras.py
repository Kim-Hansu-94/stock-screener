"""수급·컨센서스·자사주 수집의 순수 로직 테스트.

네트워크는 타지 않는다 — 실제 소스가 살아 있는지는 프로브
(`python -m src.kr_market_extras_probe`)가 Actions에서 확인하고, 여기서는
"응답이 이런 모양으로 왔을 때 우리가 제대로 해석하는가"만 본다.
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

import pytest

from src import broker_flow, buyback, consensus, investor_flow
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
    def test_실제_WISEreport_표에서_값을_뽑는다(self):
        # 2026-09-10 프로브가 찍어 준 삼성전자 실제 응답 구조 그대로다.
        table = pd.DataFrame(
            [
                ["4.05", "투자의견", "목표주가(원)", "EPS(원)", "PER(배)", "추정기관수"],
                ["4.05", "4.05", "488409", "48239", "5.59", "22"],
            ]
        )
        found = consensus._consensus_from_table(table)
        assert found["target_price"] == 488409
        assert found["opinion_score"] == pytest.approx(4.05)
        assert found["consensus_eps"] == 48239
        assert found["report_count"] == 22

    def test_열_순서가_바뀌어도_헤더_이름으로_찾는다(self):
        table = pd.DataFrame(
            [
                ["추정기관수", "목표주가(원)", "투자의견"],
                ["22", "488409", "4.05"],
            ]
        )
        found = consensus._consensus_from_table(table)
        assert found["target_price"] == 488409
        assert found["opinion_score"] == pytest.approx(4.05)

    def test_투자의견이_없는_표는_컨센서스_표가_아니다(self):
        # '목표주가'라는 글자는 페이지 곳곳에 나온다. 그것만 보고 집으면
        # 엉뚱한 표의 숫자를 읽는다.
        table = pd.DataFrame([["목표주가", "EPS(원)"], ["488409", "48239"]])
        assert consensus._consensus_from_table(table) is None

    def test_목표주가가_비상식적이면_그_표가_아니라고_본다(self):
        table = pd.DataFrame([["투자의견", "목표주가(원)"], ["4.05", "3"]])
        assert consensus._consensus_from_table(table) is None

    @pytest.mark.parametrize(
        "score,expected",
        [(4.8, "적극매수"), (4.05, "매수"), (3.0, "중립"), (2.0, "비중축소"), (1.0, "매도")],
    )
    def test_투자의견_점수를_한글로_옮긴다(self, score, expected):
        # 네이버는 숫자만 보여 주지만, 사이트에서는 무슨 뜻인지 바로 읽혀야 한다.
        label = consensus.opinion_label(score)
        assert label.startswith(expected)
        assert f"{score:.2f}" in label  # 점수도 같이 남긴다

    def test_투자의견이_없으면_None(self):
        assert consensus.opinion_label(None) is None

    def test_build_row_상승여력을_종가_대비로_낸다(self, monkeypatch):
        monkeypatch.setattr(
            consensus,
            "fetch_consensus",
            lambda t: ({"target_price": 110000.0, "opinion": "매수 4.05", "report_count": 12.0, "consensus_eps": 5000.0}, "테스트"),
        )
        row = consensus.build_row("005930", "삼성전자", "2026-09-10", 100000.0)
        assert row["upside_pct"] == pytest.approx(10.0)
        assert row["report_count"] == 12  # 정수로 저장
        assert row["opinion"] == "매수 4.05"

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
    """필드명은 2026-09-10 프로브가 찍어 준 실제 DART 응답에서 가져왔다."""

    def _patch(self, monkeypatch, detail_rows, disclosures=()):
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(buyback, "_detail", lambda c, k, endpoint: detail_rows.get(endpoint, []))
        monkeypatch.setattr(buyback, "_disclosure_list", lambda c, k: list(disclosures))

    def test_기간_진행률은_시작과_끝_사이의_위치(self, monkeypatch):
        start = date.today() - timedelta(days=30)
        end = date.today() + timedelta(days=30)
        self._patch(
            monkeypatch,
            {
                "tsstkAqDecsn": [
                    {
                        "aq_dd": "2026년 03월 19일",
                        "aqpln_prc_ostk": "7,174,300,000,000",
                        "aqpln_prc_estk": "-",
                        "aqexpd_bgd": start.strftime("%Y년 %m월 %d일"),
                        "aqexpd_edd": end.strftime("%Y년 %m월 %d일"),
                    }
                ]
            },
            [{"report_nm": "주요사항보고서(자기주식취득결정)", "rcept_dt": "20260319", "rcept_no": "123"}],
        )
        row = buyback.build_row("005930", "삼성전자", "0012345")
        assert row is not None
        assert row["period_progress_pct"] == pytest.approx(50.0, abs=2)
        assert row["planned_amount"] == 7_174_300_000_000
        assert row["is_disposal"] is False
        assert row["latest_report_url"].endswith("rcpNo=123")

    def test_한글_날짜를_읽는다(self, monkeypatch):
        # DART 주요사항보고서는 "2026년 03월 19일"로 준다. 이걸 못 읽으면
        # 기간 진행률이 통째로 빈다(첫 프로브에서 실제로 그랬다).
        assert buyback._parse_date("2026년 03월 19일") == date(2026, 3, 19)
        assert buyback._parse_date("20260821") == date(2026, 8, 21)
        assert buyback._parse_date("-") is None

    def test_보통주와_기타주식_금액을_더한다(self, monkeypatch):
        self._patch(
            monkeypatch,
            {"tsstkAqDecsn": [{"aq_dd": "2026년 01월 02일", "aqpln_prc_ostk": "1,000", "aqpln_prc_estk": "500"}]},
        )
        row = buyback.build_row("005930", "삼성전자", "0012345")
        assert row["planned_amount"] == 1500

    def test_취득과_처분_중_더_최근_결의를_고른다(self, monkeypatch):
        # 엔드포인트 순서대로 첫 응답을 쓰면, 처분이 더 최근인 회사도 오래된 취득
        # 공시로 표시된다(SK하이닉스 실사례). 방향이 정반대라 그냥 틀린 값이 된다.
        self._patch(
            monkeypatch,
            {
                "tsstkAqDecsn": [{"aq_dd": "2026년 01월 10일", "aqpln_prc_ostk": "100"}],
                "tsstkDpDecsn": [{"dp_dd": "2026년 04월 22일", "dppln_prc_ostk": "900"}],
            },
        )
        row = buyback.build_row("000660", "SK하이닉스", "0012345")
        assert row["is_disposal"] is True
        assert row["planned_amount"] == 900
        assert row["detail_source"] == "자기주식 처분 결정"

    def test_취득_완료_금액은_이_API에_없으므로_비운다(self, monkeypatch):
        # 주요사항보고서는 "얼마를 사겠다"는 계획 공시다. 기간 진행률을 금액
        # 진행률인 척 채우면 화면에서 근거를 구분할 수 없게 된다.
        self._patch(
            monkeypatch,
            {"tsstkAqDecsn": [{"aq_dd": "2026년 01월 02일", "aqpln_prc_ostk": "1,000"}]},
        )
        row = buyback.build_row("005930", "삼성전자", "0012345")
        assert row["amount_progress_pct"] is None
        assert row["acquired_amount"] is None

    def test_공시가_없으면_None(self, monkeypatch):
        # 예외가 아니라 None이어야 한다 — "자사주를 안 사는 회사"(대부분)와
        # "못 받았다"(진단 필요)를 구분하기 위해서다.
        self._patch(monkeypatch, {})
        assert buyback.build_row("005930", "삼성전자", "0012345") is None

    def test_키가_없으면_예외(self, monkeypatch):
        monkeypatch.setattr(buyback, "_api_key", lambda: None)
        with pytest.raises(RuntimeError, match="DART_API_KEY"):
            buyback.build_row("005930", "삼성전자", "0012345")


class TestBrokerFlow:
    """거래원 파싱 — 2026-09-10 프로브가 찍어 준 실제 표 구조를 그대로 쓴다.

    네이버 main 페이지의 매수 수량 컬럼은 **'거개량'으로 오타가 나 있다**.
    그래서 값은 컬럼 이름이 아니라 열 위치로 읽는다.
    """

    def _html(self, columns, rows):
        table = pd.DataFrame(rows, columns=columns)
        return "매도상위 매수상위" + table.to_html(index=False)

    def test_실제_표에서_창구별_매수_매도를_뽑는다(self):
        html = self._html(
            ["매도상위", "거래량", "매수상위", "거개량"],
            [
                ["삼성증권", "705670", "SK증권", "623600"],
                ["한국투자증권", "587213", "삼성증권", "476058"],
            ],
        )
        brokers = broker_flow.parse_brokers(html)
        assert brokers["SK증권"]["buy_qty"] == 623600
        assert brokers["SK증권"]["net_qty"] == 623600  # 매도상위엔 없다
        # 삼성증권은 양쪽에 다 있다 — 순매수는 매수 − 매도다
        assert brokers["삼성증권"]["net_qty"] == 476058 - 705670

    def test_거래원_표가_없으면_예외(self):
        with pytest.raises(RuntimeError):
            broker_flow.parse_brokers("<html><body>종목 정보</body></html>")

    @pytest.mark.parametrize(
        "disclosed,observed,expected",
        [
            ("SK증권", "SK증권", True),
            ("에스케이증권", "SK증권", False),  # 표기가 아예 다르면 못 맞춘다
            ("SK 증권", "SK증권", True),  # 공백은 무시
            ("주식회사 SK증권", "SK증권", True),
            (None, "SK증권", False),
            ("SK증권", None, False),
        ],
    )
    def test_증권사_이름_매칭(self, disclosed, observed, expected):
        assert broker_flow.brokers_match(disclosed, observed) is expected

    def test_추정_진행률은_기간_시작_이후_순매수만_센다(self):
        rows = [
            # 프로그램 시작 전 거래 — 이 프로그램과 무관하다
            {"date": "2026-08-01", "broker": "SK증권", "net_qty": 1000, "net_amount": 1_000_000},
            {"date": "2026-08-25", "broker": "SK증권", "net_qty": 100, "net_amount": 200_000},
            {"date": "2026-08-26", "broker": "SK증권", "net_qty": 150, "net_amount": 300_000},
            # 다른 증권사는 세지 않는다
            {"date": "2026-08-26", "broker": "삼성증권", "net_qty": 999, "net_amount": 9_000_000},
        ]
        result = broker_flow.estimate_buyback_progress(rows, "SK증권", "2026-08-20", 1_000_000)
        assert result["estimated_amount"] == 500_000
        assert result["estimated_progress_pct"] == pytest.approx(50.0)
        assert result["observed_days"] == 2

    def test_순매도인_날은_음수로_더한다(self):
        # 매수분만 세면 실제보다 부풀려진다.
        rows = [
            {"date": "2026-08-25", "broker": "SK증권", "net_qty": 100, "net_amount": 1_000_000},
            {"date": "2026-08-26", "broker": "SK증권", "net_qty": -40, "net_amount": -400_000},
        ]
        result = broker_flow.estimate_buyback_progress(rows, "SK증권", None, 10_000_000)
        assert result["estimated_amount"] == 600_000

    def test_예정금액이_없으면_진행률은_비운다(self):
        rows = [{"date": "2026-08-25", "broker": "SK증권", "net_qty": 1, "net_amount": 100}]
        result = broker_flow.estimate_buyback_progress(rows, "SK증권", None, None)
        assert result["estimated_progress_pct"] is None
        assert result["estimated_amount"] == 100

    def test_진행률은_100을_넘지_않는다(self):
        # 창구 매수에 자사주가 아닌 주문이 섞이면 예정 금액을 넘길 수 있다.
        rows = [{"date": "2026-08-25", "broker": "SK증권", "net_qty": 1, "net_amount": 5_000}]
        result = broker_flow.estimate_buyback_progress(rows, "SK증권", None, 1_000)
        assert result["estimated_progress_pct"] == 100.0


class TestBuybackBroker:
    def test_위탁투자중개업자를_공시에서_읽는다(self, monkeypatch):
        # 이 값이 거래원 데이터와 자사주 프로그램을 잇는 열쇠다.
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(
            buyback,
            "_detail",
            lambda c, k, e: [{"aq_dd": "2026년 08월 19일", "aqpln_prc_ostk": "1000", "cs_iv_bk": "SK증권"}]
            if e == "tsstkAqDecsn"
            else [],
        )
        monkeypatch.setattr(buyback, "_disclosure_list", lambda c, k: [])
        row = buyback.build_row("000660", "SK하이닉스", "0012345")
        assert row["broker"] == "SK증권"

    def test_위탁증권사가_없으면_None(self, monkeypatch):
        monkeypatch.setattr(buyback, "_api_key", lambda: "key")
        monkeypatch.setattr(
            buyback,
            "_detail",
            lambda c, k, e: [{"aq_dd": "2026년 08월 19일", "aqpln_prc_ostk": "1000", "cs_iv_bk": "-"}]
            if e == "tsstkAqDecsn"
            else [],
        )
        monkeypatch.setattr(buyback, "_disclosure_list", lambda c, k: [])
        row = buyback.build_row("000660", "SK하이닉스", "0012345")
        assert row["broker"] is None
