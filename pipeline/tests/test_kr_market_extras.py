"""수급·컨센서스 수집의 순수 로직 테스트.

네트워크는 타지 않는다 — 실제 소스가 살아 있는지는 프로브
(`python -m src.kr_market_extras_probe`)가 Actions에서 확인하고, 여기서는
"응답이 이런 모양으로 왔을 때 우리가 제대로 해석하는가"만 본다.
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

import pytest

from src import consensus, investor_flow
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


class TestBrokerTargets:
    """컨센서스 평균을 검산하는 '증권사별 목표가' 파싱.

    프로브가 멀쩡한 값에 계속 빨간불을 켜던 것을 2026-10-27에 이걸로 바꿨다 —
    현재가 대비 배수는 파싱이 맞았는지와 무관한 숫자라(주가가 빠지면 커진다)
    늘 빨간 프로브가 됐고, 그러면 아무도 안 보게 된다.
    """

    # 2026-10-27 실측 원문(태그를 벗긴 평문)을 그대로 쓴다.
    SAMPLE = (
        "제공처별 투자의견 및 목표주가, 변동률 목록 제공처 최종일자 목표가 직전목표가 "
        "변동률 (%) 투자의견 직전투자의견 "
        "대신 26/10/26 500,000 560,000 -10.71 Buy Buy "
        "미래에셋 26/10/19 400,000 400,000 0.00 매수 매수 "
        "유진투자 26/10/12 560,000 560,000 0.00 STRONG BUY STRONG BUY "
        "NH투자 26/10/12 530,000 530,000 0.00 Buy Buy"
    )

    def test_pulls_each_brokers_target(self):
        assert consensus.broker_targets_from_text(self.SAMPLE) == [
            500000.0,
            400000.0,
            560000.0,
            530000.0,
        ]

    def test_the_real_consensus_average_falls_inside_that_range(self):
        # 같은 날 삼성전자 평균 목표가가 492,500원이었다. 범위 안이므로 정상이다 —
        # 이게 바로 옛 배수 검사가 "비상식적"이라며 빨간불을 켰던 값이다.
        targets = consensus.broker_targets_from_text(self.SAMPLE)
        assert min(targets) <= 492500 <= max(targets)

    def test_reads_the_target_not_the_previous_target(self):
        # 날짜를 닻으로 삼는 이유. 직전목표가(560,000)까지 같이 긁으면 범위가
        # 넓어져 검산이 헐거워진다 — 대신증권 줄에서 500,000만 와야 한다.
        targets = consensus.broker_targets_from_text(self.SAMPLE)
        assert targets.count(560000.0) == 1  # 유진투자 것 하나뿐

    def test_says_nothing_rather_than_guessing_when_the_section_is_missing(self):
        # "검산 못 함"과 "검산 실패"는 다르다 — 호출부가 빈 목록을 보고 빨간불을
        # 켜지 않도록 예외가 아니라 빈 목록을 돌려준다.
        assert consensus.broker_targets_from_text("제공처 표가 없는 페이지") == []
