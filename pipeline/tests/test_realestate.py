from datetime import date

import pytest

from pipeline.src import realestate
from pipeline.src.lawd_codes import CAPITAL_AREA


def _trade_xml(items: str) -> str:
    return f"<response><header><resultCode>00</resultCode></header><body><items>{items}</items></body></response>"


TRADE = _trade_xml(
    """
    <item><dealAmount>100,000</dealAmount><excluUseAr>84.9</excluUseAr></item>
    <item><dealAmount>200,000</dealAmount><excluUseAr>59.9</excluUseAr></item>
    <item><dealAmount>900,000</dealAmount><excluUseAr>200.0</excluUseAr><cdealType>O</cdealType></item>
    """
)

RENT = _trade_xml(
    """
    <item><deposit>50,000</deposit><monthlyRent>0</monthlyRent></item>
    <item><deposit>70,000</deposit><monthlyRent>0</monthlyRent></item>
    <item><deposit>10,000</deposit><monthlyRent>150</monthlyRent></item>
    """
)


def _fake_get(url, params, timeout):
    class Resp:
        text = TRADE if "Trade" in url else RENT

        def raise_for_status(self):
            pass

    return Resp()


def test_canceled_deals_are_excluded(monkeypatch):
    """해제된 계약(cdealType='O')을 빼지 않으면 없던 거래가 시세로 잡힌다."""
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    agg = realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8)

    assert agg.deal_prices == [100000.0, 200000.0]  # 90만은 해제분이라 제외
    assert agg.to_row()["deal_count"] == 2


def test_jeonse_and_monthly_rent_are_separated(monkeypatch):
    """갭·전세가율은 전세만 써야 한다 — 월세 보증금이 섞이면 전세가 급락한 것처럼 보인다."""
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    row = realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8).to_row()

    assert row["jeonse_count"] == 2
    assert row["monthly_rent_count"] == 1
    assert row["deposit_avg"] == 60000.0


def test_price_per_area_uses_per_deal_unit_price(monkeypatch):
    """총액평균 ÷ 면적평균으로 내면 큰 평수가 분모를 키워 단가가 낮게 나온다."""
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    row = realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8).to_row()

    expected = round((100000 / 84.9 + 200000 / 59.9) / 2, 1)
    assert row["price_per_area_avg"] == expected

    naive = round(150000 / ((84.9 + 59.9) / 2), 1)
    assert row["price_per_area_avg"] != naive


def test_gap_and_ratio(monkeypatch):
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    row = realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8).to_row()

    assert row["price_avg"] == 150000.0
    assert row["gap_avg"] == 90000.0
    assert row["jeonse_ratio"] == pytest.approx(0.4)


def test_api_error_in_body_is_raised_not_swallowed(monkeypatch):
    """키 미승인·트래픽 초과는 HTTP 200 + resultCode로 온다. 빈 결과로 넘기면 안 된다."""

    def error_get(url, params, timeout):
        class Resp:
            text = (
                "<response><header><resultCode>30</resultCode>"
                "<resultMsg>SERVICE KEY IS NOT REGISTERED ERROR</resultMsg></header></response>"
            )

            def raise_for_status(self):
                pass

        return Resp()

    monkeypatch.setattr(realestate.requests, "get", error_get)
    with pytest.raises(RuntimeError, match="30"):
        realestate.collect_region_month("BAD", "11680", "서울 강남구", 2026, 8)


def test_collect_reports_empty_regions_separately_from_errors(monkeypatch):
    """코드가 틀려 0건인 지역과 호출 실패는 대응이 달라 따로 세야 한다."""

    def mixed(key, code, name, year, month):
        if code == "99999":
            return realestate.RegionMonth(code, name, date(year, month, 1))
        if code == "88888":
            raise RuntimeError("타임아웃")
        agg = realestate.RegionMonth(code, name, date(year, month, 1))
        agg.deal_prices.append(100000.0)
        agg.deal_areas.append(84.9)
        return agg

    monkeypatch.setattr(realestate, "collect_region_month", mixed)
    rows, diag = realestate.collect(
        {"11680": "강남", "99999": "없는구", "88888": "터진구"}, [(2026, 8)], service_key="KEY"
    )

    assert len(rows) == 1
    assert diag["empty"] == ["없는구(99999)"]
    assert len(diag["error"]) == 1
    assert "터진구" in diag["error"][0]


def test_missing_key_skips_quietly(capsys):
    """키가 없어도 터지지 않고 건너뛴다 — DART 미설정 때와 같은 취급."""
    rows, diag = realestate.collect(CAPITAL_AREA, [(2026, 8)], service_key=None)
    assert rows == []
    assert "MOLIT_API_KEY" in capsys.readouterr().out


# ── 인증키 형태 ──────────────────────────────────────────────────────────
# data.go.kr은 같은 키를 Encoding/Decoding 두 형태로 주는데 화면에 따라 한쪽만
# 보인다. 어느 쪽을 넣어도 되게 해두지 않으면, 인증 실패 메시지가
# "SERVICE KEY IS NOT REGISTERED"로 떠서 키를 재발급받는 헛수고를 하게 된다.

def test_encoded_service_key_is_unquoted():
    assert realestate.normalize_service_key("abc%2BdefG%2Fhij%3D") == "abc+defG/hij="


def test_raw_service_key_is_left_alone():
    assert realestate.normalize_service_key("abc+defG/hij=") == "abc+defG/hij="


def test_both_key_forms_reach_the_api_identically(monkeypatch):
    sent = []

    def capture(url, params, timeout):
        sent.append(params["serviceKey"])

        class Resp:
            text = TRADE if "Trade" in url else RENT

            def raise_for_status(self):
                pass

        return Resp()

    monkeypatch.setattr(realestate.requests, "get", capture)
    realestate.collect_region_month("abc%2Bdef", "11680", "서울 강남구", 2026, 8)
    realestate.collect_region_month("abc+def", "11680", "서울 강남구", 2026, 8)

    assert set(sent) == {"abc+def"}


# ── 엔트리포인트 ─────────────────────────────────────────────────────────
# 첫 두 실행이 "키 미설정"으로 조용히 건너뛰고 초록불로 끝났다. 원인은
# realestate_main이 load_dotenv()를 안 불러 pipeline/.env를 못 읽은 것이었다.

def test_recent_months_walks_back_across_the_year_boundary():
    from pipeline.src.realestate_main import recent_months

    assert recent_months(date(2026, 2, 15), 4) == [(2026, 2), (2026, 1), (2025, 12), (2025, 11)]


def test_entrypoint_loads_dotenv_before_reading_the_key(monkeypatch):
    """워크플로는 키를 pipeline/.env에 쓴다. 여기서 읽지 않으면 환경변수가 비어 있다."""
    from pipeline.src import realestate_main

    loaded = []
    monkeypatch.setattr(realestate_main, "load_dotenv", lambda: loaded.append(True))
    monkeypatch.setattr(realestate_main.os, "getenv", lambda name: None)
    monkeypatch.setattr("sys.argv", ["realestate_main", "--months", "1"])

    with pytest.raises(SystemExit) as exc:
        realestate_main.main()

    assert loaded == [True], "load_dotenv를 부르지 않았다"
    assert exc.value.code == 1, "키가 없는데 정상 종료하면 초록불로 끝나 '다 됐다'로 보인다"
