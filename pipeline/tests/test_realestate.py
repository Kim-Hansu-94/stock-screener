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


def _fake_get(url, params=None, headers=None, timeout=None):
    class Resp:
        ok = True
        status_code = 200
        text = TRADE if "Trade" in url else RENT

    return Resp()


@pytest.fixture(autouse=True)
def _reset_endpoint_cache():
    """어느 엔드포인트가 통했는지는 실행 단위 캐시라, 테스트 사이에 새어 나가면 안 된다."""
    realestate._WORKING.clear()
    yield
    realestate._WORKING.clear()


def _all_row(rows: list[dict]) -> dict:
    return next(r for r in rows if r["area_band"] == realestate.ALL_BAND)


def _band_row(rows: list[dict], band: str) -> dict:
    return next(r for r in rows if r["area_band"] == band)


def test_canceled_deals_are_excluded(monkeypatch):
    """해제된 계약(cdealType='O')을 빼지 않으면 없던 거래가 시세로 잡힌다."""
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    agg = realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8)

    assert [price for price, _ in agg.deals] == [100000.0, 200000.0]  # 90만은 해제분
    assert _all_row(agg.to_rows())["deal_count"] == 2


def test_jeonse_and_monthly_rent_are_separated(monkeypatch):
    """갭·전세가율은 전세만 써야 한다 — 월세 보증금이 섞이면 전세가 급락한 것처럼 보인다."""
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    row = _all_row(realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8).to_rows())

    assert row["jeonse_count"] == 2
    assert row["monthly_rent_count"] == 1
    assert row["deposit_avg"] == 60000.0


def test_price_per_area_uses_per_deal_unit_price(monkeypatch):
    """총액평균 ÷ 면적평균으로 내면 큰 평수가 분모를 키워 단가가 낮게 나온다."""
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    row = _all_row(realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8).to_rows())

    expected = round((100000 / 84.9 + 200000 / 59.9) / 2, 1)
    assert row["price_per_area_avg"] == expected

    naive = round(150000 / ((84.9 + 59.9) / 2), 1)
    assert row["price_per_area_avg"] != naive


def test_gap_and_ratio(monkeypatch):
    monkeypatch.setattr(realestate.requests, "get", _fake_get)
    row = _all_row(realestate.collect_region_month("KEY", "11680", "서울 강남구", 2026, 8).to_rows())

    assert row["price_avg"] == 150000.0
    assert row["gap_avg"] == 90000.0
    assert row["jeonse_ratio"] == pytest.approx(0.4)


def test_api_error_in_body_is_raised_not_swallowed(monkeypatch):
    """키 미승인·트래픽 초과는 HTTP 200 + resultCode로 온다. 빈 결과로 넘기면 안 된다."""

    def error_get(url, params=None, headers=None, timeout=None):
        class Resp:
            ok = True
            status_code = 200
            text = (
                "<response><header><resultCode>30</resultCode>"
                "<resultMsg>SERVICE KEY IS NOT REGISTERED ERROR</resultMsg></header></response>"
            )

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
        agg.deals.append((100000.0, 84.9))
        return agg

    monkeypatch.setattr(realestate, "collect_region_month", mixed)
    rows, diag = realestate.collect(
        {"11680": "강남", "99999": "없는구", "88888": "터진구"}, [(2026, 8)], service_key="KEY"
    )

    assert len(rows) == 2  # 강남만, ALL + 60~85
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

    def capture(url, params=None, headers=None, timeout=None):
        sent.append(params["serviceKey"])

        class Resp:
            ok = True
            status_code = 200
            text = TRADE if "Trade" in url else RENT

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


# ── 403 대응 ─────────────────────────────────────────────────────────────
# 첫 백필이 2,772건 전부 403으로 실패하며 30분을 헛돌았다. 원인 후보가
# "신청 안 한 엔드포인트"와 "키 미반영" 둘인데, 상태 코드만으로는 구분이 안 된다.

def test_falls_back_to_the_other_trade_endpoint_on_403():
    """상세(Dev)만 부르면 기본형만 신청한 계정에서 전부 403이 난다."""
    tried = []

    def get(url, params=None, headers=None, timeout=None):
        tried.append(url)

        class Resp:
            ok = "TradeDev" not in url
            status_code = 200 if ok else 403
            text = TRADE if ok else "요청하신 서비스는 이용할 수 없습니다"

        return Resp()

    realestate._WORKING.clear()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(realestate.requests, "get", get)
        items = realestate._fetch("매매", realestate._TRADE_URLS, "KEY", "11110", "202608")

    assert len(items) == 3
    assert any("TradeDev" in u for u in tried), "상세를 먼저 시도해야 한다"
    assert realestate._WORKING["매매"].endswith("getRTMSDataSvcAptTrade")


def test_http_error_message_includes_the_response_body():
    """403 본문에 실제 사유가 들어 있다. 상태 코드만 남기면 원인을 못 좁힌다."""

    def get(url, params=None, headers=None, timeout=None):
        class Resp:
            ok = False
            status_code = 403
            text = "요청하신 서비스는 이용할 수 없습니다. 활용신청을 확인하세요."

        return Resp()

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(realestate.requests, "get", get)
        with pytest.raises(RuntimeError, match="활용신청"):
            realestate._fetch_one(realestate._TRADE_URLS[0], "KEY", "11110", "202608")


def test_collect_aborts_early_when_every_call_fails(monkeypatch):
    """키·신청 문제면 전 지역이 같은 이유로 깨진다 — 30분 헛돌지 말고 멈춘다."""
    calls = []

    def always_fail(key, code, name, year, month):
        calls.append(code)
        raise RuntimeError("HTTP 403")

    monkeypatch.setattr(realestate, "collect_region_month", always_fail)
    regions = {f"{i:05d}": f"지역{i}" for i in range(100)}
    months = [(2026, m) for m in range(1, 13)]

    rows, diag = realestate.collect(regions, months, service_key="KEY")

    assert rows == []
    assert diag["aborted"], "조기 중단 표시가 없다"
    assert len(calls) <= realestate._ABORT_AFTER, f"{len(calls)}번이나 계속 시도했다"


# ── 중간 저장 ────────────────────────────────────────────────────────────
# 36개월 백필(5,544건 호출)이 60분 타임아웃에 걸려 취소됐는데, 끝에서 한 번에
# 저장하는 구조라 한 시간치가 통째로 날아갔다. 지역 단위로 흘려보내야 한다.

def test_rows_are_handed_over_per_region_not_only_at_the_end(monkeypatch):
    handed: list[list[dict]] = []

    def fake(key, code, name, year, month):
        agg = realestate.RegionMonth(code, name, date(year, month, 1))
        agg.deals.append((100000.0, 84.9))
        return agg

    monkeypatch.setattr(realestate, "collect_region_month", fake)
    regions = {"11110": "종로", "11140": "중구", "11170": "용산"}

    rows, _ = realestate.collect(
        regions, [(2026, 8), (2026, 7)], service_key="KEY", on_rows=handed.append
    )

    assert len(handed) == 3, "지역마다 한 번씩 넘겨야 한다 (끝에서 한 번이 아니라)"
    # 지역별 2개월 × (ALL + 60~85 구간) = 4행
    assert all(len(batch) == 4 for batch in handed), "지역별 2개월분이 함께 넘어가야 한다"
    assert len(rows) == 12, "누적 결과도 그대로 돌려줘야 한다"


def test_collect_still_works_without_a_callback(monkeypatch):
    """on_rows는 선택이다 — 안 주면 예전처럼 끝에서 모아 돌려준다."""

    def fake(key, code, name, year, month):
        agg = realestate.RegionMonth(code, name, date(year, month, 1))
        agg.deals.append((100000.0, 84.9))
        return agg

    monkeypatch.setattr(realestate, "collect_region_month", fake)
    rows, _ = realestate.collect({"11110": "종로"}, [(2026, 8)], service_key="KEY")
    assert len(rows) == 2  # ALL + 60~85


# ── 면적 구간 ────────────────────────────────────────────────────────────
# 소형과 대형은 사이클이 어긋나게 움직인다(상승 초기엔 중소형이 먼저 뛴다).
# 한데 묶어 평균 내면 두 흐름이 상쇄돼 "움직임 없음"으로 보인다.

@pytest.mark.parametrize(
    ("area", "expected"),
    [
        (59.9, "~60"),
        (60.0, "~60"),      # 경계는 이하 포함
        (60.1, "60~85"),
        (84.9, "60~85"),
        (85.0, "60~85"),
        (85.1, "85~135"),
        (135.0, "85~135"),
        (200.0, "135~"),
    ],
)
def test_band_boundaries(area, expected):
    assert realestate.band_of(area) == expected


def test_area_unknown_falls_out_of_bands_but_stays_in_total():
    """면적을 못 받은 거래를 임의 구간에 넣으면 그 구간 통계가 오염된다."""
    assert realestate.band_of(0) is None

    agg = realestate.RegionMonth("11680", "서울 강남구", date(2026, 8, 1))
    agg.deals.append((100000.0, 0.0))   # 면적 불명
    agg.deals.append((200000.0, 84.9))

    rows = agg.to_rows()
    assert _all_row(rows)["deal_count"] == 2, "전체에는 둘 다 들어가야 한다"
    assert _band_row(rows, "60~85")["deal_count"] == 1, "구간에는 면적 아는 것만"
    assert [r["area_band"] for r in rows] == ["ALL", "60~85"], "빈 구간 행은 만들지 않는다"


def test_bands_split_price_and_jeonse_independently():
    """평형별 갭을 보려면 매매·전세가 같은 구간 기준으로 나뉘어야 한다."""
    agg = realestate.RegionMonth("11680", "서울 강남구", date(2026, 8, 1))
    agg.deals += [(80000.0, 55.0), (150000.0, 84.0), (160000.0, 84.0)]
    agg.jeonse += [(40000.0, 55.0), (90000.0, 84.0)]
    agg.monthly_rents.append(55.0)

    rows = agg.to_rows()
    small = _band_row(rows, "~60")
    mid = _band_row(rows, "60~85")

    assert small["deal_count"] == 1 and small["price_avg"] == 80000.0
    assert small["gap_avg"] == 40000.0
    assert small["monthly_rent_count"] == 1

    assert mid["deal_count"] == 2 and mid["price_avg"] == 155000.0
    assert mid["gap_avg"] == 65000.0
    assert mid["monthly_rent_count"] == 0

    # 전체는 여전히 구 단위 합계 — 기본 화면이 이 한 줄을 쓴다
    assert _all_row(rows)["deal_count"] == 3


def test_entrypoint_builds_the_db_from_env(monkeypatch):
    """ScreenerDB는 client를 받는다 — 인자 없이 만들면 TypeError로 즉시 죽는다.

    실제로 그렇게 배포돼서 백필이 31초 만에 실패했다(run 32578679424).
    collect까지 도달하는지를 확인하는 스모크 테스트.
    """
    from unittest.mock import MagicMock

    from pipeline.src import realestate_main

    built: list[int] = []

    def fake_from_env():
        built.append(1)
        return MagicMock()

    monkeypatch.setattr(realestate_main, "load_dotenv", lambda: None)
    monkeypatch.setenv("MOLIT_API_KEY", "KEY")
    monkeypatch.setattr(realestate_main.ScreenerDB, "from_env", staticmethod(fake_from_env))
    monkeypatch.setattr(realestate_main, "collect", lambda *a, **k: ([{"region_code": "11110"}], {}))
    monkeypatch.setattr("sys.argv", ["realestate_main", "--months", "1"])

    realestate_main.main()

    assert built == [1], "ScreenerDB.from_env()로 만들어야 한다"


# ── 타임아웃 재시도 ──────────────────────────────────────────────────────
# 5,544건 백필에서 26건이 Read timeout으로 빠졌다. 놓친 달은 주간 실행이
# 최근 3개월만 훑으므로 자동으로 메워지지 않는다.

def test_timeout_is_retried_once(monkeypatch):
    attempts = []

    def flaky(url, params=None, headers=None, timeout=None):
        attempts.append(url)
        if len(attempts) == 1:
            raise realestate.requests.Timeout("read timed out")

        class Resp:
            ok = True
            status_code = 200
            text = TRADE

        return Resp()

    monkeypatch.setattr(realestate.requests, "get", flaky)
    items = realestate._fetch_one(realestate._TRADE_URLS[0], "KEY", "11110", "202608")

    assert len(attempts) == 2, "타임아웃이면 한 번 더 시도해야 한다"
    assert len(items) == 3


def test_timeout_twice_gives_up(monkeypatch):
    """무한 재시도하면 API가 느린 날 실행이 끝나지 않는다."""

    def always_timeout(url, params=None, headers=None, timeout=None):
        raise realestate.requests.Timeout("read timed out")

    monkeypatch.setattr(realestate.requests, "get", always_timeout)
    with pytest.raises(realestate.requests.Timeout):
        realestate._fetch_one(realestate._TRADE_URLS[0], "KEY", "11110", "202608")
