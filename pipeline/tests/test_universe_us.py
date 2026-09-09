import pandas as pd
import requests
from unittest.mock import MagicMock, patch

from pipeline.src.universe_us import (
    _backfill_missing_sectors,
    _fetch_ishares_iwv,
    _fetch_naver_world,
    _YFINANCE_SECTOR_TO_GICS,
    fetch_russell3000,
    get_us_universe,
)

FAKE_SP500 = pd.DataFrame({
    "Symbol": ["AAPL", "MSFT", "BRK.B", "BF.B", "BRKB"],
    "Name": ["Apple", "Microsoft", "Berkshire B", "Brown-Forman B", "Berkshire B dup"],
    "Sector": ["Information Technology", "Information Technology", "Financials", "Consumer Staples", "Financials"],
    "Industry": ["Tech Hardware", "Software", "Insurance", "Spirits", "Insurance"],
})

FAKE_NASDAQ100_HTML = """
<html><body>
<table><tr><th>Other</th></tr><tr><td>irrelevant</td></tr></table>
<table>
<tr><th>Symbol</th><th>Company Name</th><th>Market Cap</th></tr>
<tr><td>AAPL</td><td>Apple</td><td>3T</td></tr>
<tr><td>PDD</td><td>PDD Holdings</td><td>200B</td></tr>
</table>
</body></html>
"""


@patch("pipeline.src.universe_us.yf.Ticker")
@patch("pipeline.src.universe_us.requests.get")
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_combines_sp500_and_nasdaq100_without_duplicates(mock_listing, mock_get, mock_yf_ticker):
    mock_get.return_value.text = FAKE_NASDAQ100_HTML
    # Consumer Cyclical은 yfinance식 이름 — GICS(Consumer Discretionary)로 정규화돼야 한다
    mock_yf_ticker.return_value.info = {"sector": "Consumer Cyclical"}

    result = get_us_universe().set_index("ticker")

    assert result.loc["AAPL", "index_membership"] == "S&P500"  # SP500 entry kept (first), not overwritten
    assert result.loc["AAPL", "sector"] == "Information Technology"
    assert result.loc["MSFT", "index_membership"] == "S&P500"
    assert result.loc["PDD", "index_membership"] == "NASDAQ100"
    # PDD는 S&P500에 없어 원래 sector가 비어 있지만, NASDAQ100 전용 종목은
    # yfinance로 보완된다(_backfill_missing_sectors) — GICS 이름으로 정규화된 값이어야 한다.
    assert result.loc["PDD", "sector"] == "Consumer Discretionary"
    mock_yf_ticker.assert_called_once_with("PDD")
    # dot-separated class share tickers are normalized to Yahoo Finance hyphen format
    assert "BRK-B" in result.index
    assert "BRK.B" not in result.index
    assert "BF-B" in result.index
    assert "BF.B" not in result.index
    # no-separator variant (BRKB) also normalized, then deduped with BRK-B
    assert "BRKB" not in result.index


FAKE_SP400_HTML = """
<html><body>
<table>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td>MID</td><td>MidCap Co</td><td>Industrials</td></tr>
</table>
</body></html>
"""

FAKE_SP600_HTML = """
<html><body>
<table>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td>SML</td><td>SmallCap Co</td><td>Financials</td></tr>
</table>
</body></html>
"""


def _routed_get(url, **kwargs):
    resp = MagicMock()
    if "nasdaq-100-stocks" in url:
        resp.text = FAKE_NASDAQ100_HTML
    elif "S%26P_400" in url:
        resp.text = FAKE_SP400_HTML
    elif "S%26P_600" in url:
        resp.text = FAKE_SP600_HTML
    elif "vanguard" in url:
        resp.json.return_value = {
            "size": 2,
            "fund": {"entity": [
                {"ticker": "RUS", "longName": "Russell Only Co"},
                {"ticker": "MID", "longName": "MidCap dup"},
            ]},
        }
    else:  # KIS 마스터 파일 등 — 실패해도 파이프라인은 정상 동작해야 한다
        raise requests.RequestException("unavailable in test")
    return resp


# 픽스처는 Russell 종목이 2개뿐이라 실제 하한(1,000개)에 걸린다. 이 테스트가 보는 건
# "지수 라벨이 제대로 붙는가"이므로 하한만 낮춰 둔다.
@patch("pipeline.src.universe_us._MIN_RUSSELL_TICKERS", 1)
@patch("pipeline.src.universe_us.yf.Ticker")
@patch("pipeline.src.universe_us.requests.get", side_effect=_routed_get)
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_always_includes_sp400_and_sp600_alongside_russell3000(mock_listing, mock_get, mock_yf_ticker):
    mock_yf_ticker.return_value.info = {}  # PDD(NASDAQ100 전용)의 업종 보완 시도 — 이 테스트는 결과 무관, 네트워크 접근만 막음
    result = get_us_universe().set_index("ticker")

    # S&P400/S&P600은 VTHR(Russell 3000) 성공 여부와 무관하게 항상 포함
    assert result.loc["MID", "index_membership"] == "S&P400"
    assert result.loc["SML", "index_membership"] == "S&P600"
    # VTHR 단독 종목은 Russell3000으로 남는다
    assert result.loc["RUS", "index_membership"] == "Russell3000"
    # 중복 시 S&P 지수 라벨이 Russell3000보다 우선한다
    assert result.loc["AAPL", "index_membership"] == "S&P500"


# ── NASDAQ100 전용 종목 업종 보완 (_backfill_missing_sectors) ──────────────
# NASDAQ100 데이터 소스(stockanalysis.com)엔 sector가 아예 없어, S&P500에도
# 속하지 않은 종목은 sector가 비어 화면의 업종 필터·재무건전성 업종별 기준이
# '미분류'로 빠진다. 개수가 적어(보통 10개 안팎) yfinance로 개별 보완한다.

def _universe(rows):
    return pd.DataFrame(rows)


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_only_targets_nasdaq100_only_tickers_with_missing_sector(mock_yf_ticker):
    mock_yf_ticker.return_value.info = {"sector": "Technology"}
    universe = _universe([
        {"ticker": "AAPL", "sector": "Information Technology", "index_membership": "S&P500"},
        {"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"},
        # 다른 지수의 결측 sector는(현재 발생 안 하지만) 대상이 아니다 — NASDAQ100만 보완 범위
        {"ticker": "OTH", "sector": None, "index_membership": "S&P400"},
    ])

    result = _backfill_missing_sectors(universe).set_index("ticker")

    assert result.loc["PDD", "sector"] == "Technology"
    assert pd.isna(result.loc["OTH", "sector"])  # NASDAQ100이 아니므로 손대지 않음
    mock_yf_ticker.assert_called_once_with("PDD")


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_normalizes_yfinance_sector_names_to_gics(mock_yf_ticker):
    """yfinance는 GICS와 다른 이름을 쓰는 업종이 4개 있다(Consumer Cyclical/Defensive,
    Financial Services, Basic Materials). S&P500(FDR)이 채우는 sector는 GICS 이름을
    쓰고 broadSector()도 GICS 이름을 기준으로 매칭하므로, 정규화 없이 그대로 저장하면
    같은 컬럼 안에 두 이름 체계가 섞여 이 업종의 NASDAQ100 전용 종목이 broadSector()
    에서 '기타'로 잘못 빠진다.
    """
    for yfinance_name, gics_name in _YFINANCE_SECTOR_TO_GICS.items():
        mock_yf_ticker.return_value.info = {"sector": yfinance_name}
        universe = _universe([{"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"}])

        result = _backfill_missing_sectors(universe).set_index("ticker")

        assert result.loc["PDD", "sector"] == gics_name, f"{yfinance_name} → {gics_name} 정규화 실패"


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_leaves_sector_null_when_yfinance_fails(mock_yf_ticker):
    mock_yf_ticker.side_effect = RuntimeError("rate limited")
    universe = _universe([
        {"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"},
    ])

    result = _backfill_missing_sectors(universe).set_index("ticker")

    assert pd.isna(result.loc["PDD", "sector"])  # 실패해도 죽지 않고 미분류로 남음


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_leaves_sector_null_when_yfinance_has_no_sector_key(mock_yf_ticker):
    mock_yf_ticker.return_value.info = {}  # info는 왔지만 sector 필드 자체가 없음
    universe = _universe([
        {"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"},
    ])

    result = _backfill_missing_sectors(universe).set_index("ticker")

    assert pd.isna(result.loc["PDD", "sector"])


def test_backfill_is_a_noop_when_nothing_is_missing():
    universe = _universe([
        {"ticker": "AAPL", "sector": "Information Technology", "index_membership": "S&P500"},
    ])

    result = _backfill_missing_sectors(universe)

    assert result.loc[0, "sector"] == "Information Technology"


# ── Russell 3000 소스 (2026-09-09) ─────────────────────────────────────────
# Vanguard VTHR API가 차단 페이지를 HTTP 200 + HTML로 돌려주기 시작해 몇 주 동안
# 조용히 실패하고 있었다(로그엔 "Expecting value: line 1 column 1"만 남았다).
# iShares IWV CSV를 1순위로 두고, 실패 사유가 로그에 드러나게 했다.

FAKE_IWV_CSV = """iShares Russell 3000 ETF
Fund Holdings as of,"Sep 08, 2026"
Inception Date,"May 22, 2000"

Ticker,Name,Sector,Asset Class,Weight (%),Price
AAPL,APPLE INC,Information Technology,Equity,5.62,240.11
XYZ,SMALL CAP CO,Communication,Equity,0.01,12.30
BRK.B,BERKSHIRE HATHAWAY INC CLASS B,Financials,Equity,1.42,470.00
XTSLA,BLK CSH FND TREASURY SL AGENCY,Cash and/or Derivatives,Cash,0.10,1.00
-,USD CASH,-,Cash,0.02,1.00
"""


def _csv_response(text: str):
    resp = MagicMock()
    resp.text = text
    resp.raise_for_status.return_value = None
    return resp


@patch("pipeline.src.universe_us.requests.get")
def test_ishares_csv_skips_preamble_and_keeps_only_equities(mock_get):
    mock_get.return_value = _csv_response(FAKE_IWV_CSV)

    df = _fetch_ishares_iwv()

    # 머리말 3줄을 건너뛰고 Ticker 헤더부터 읽어야 한다(머리말 줄 수는 고정이 아니다).
    assert list(df["ticker"]) == ["AAPL", "XYZ", "BRK.B"]
    # 현금·파생 행은 빠진다 — 티커가 아니라서 시세 조회 때 전부 실패한다.
    assert "XTSLA" not in list(df["ticker"])


@patch("pipeline.src.universe_us.requests.get")
def test_ishares_csv_keeps_only_known_gics_sector_names(mock_get):
    mock_get.return_value = _csv_response(FAKE_IWV_CSV)

    df = _fetch_ishares_iwv().set_index("ticker")

    assert df.loc["AAPL", "sector"] == "Information Technology"
    # 'Communication'은 GICS 표준 이름('Communication Services')이 아니다. 그대로 두면
    # broadSector()가 '기타'로 잘못 분류하므로 비워서 yfinance 보완에 맡긴다.
    assert pd.isna(df.loc["XYZ", "sector"])


@patch("pipeline.src.universe_us.requests.get")
def test_ishares_failure_message_shows_why_not_just_a_parse_error(mock_get):
    # 봇 차단 페이지는 HTTP 200 + HTML로 온다 — 사유가 로그에 드러나야 한다.
    mock_get.return_value = _csv_response("<html><body>Access Denied</body></html>")

    try:
        _fetch_ishares_iwv()
    except RuntimeError as exc:
        assert "Access Denied" in str(exc)
    else:
        raise AssertionError("차단 페이지인데 에러가 나지 않았다")


def _russell_rows(n: int, prefix: str) -> pd.DataFrame:
    return pd.DataFrame({
        "ticker": [f"{prefix}{i}" for i in range(n)],
        "name": ["x"] * n,
        "sector": [None] * n,
    })


def test_russell_falls_back_to_next_source_when_first_one_fails():
    sources = [
        ("깨진 소스", MagicMock(side_effect=RuntimeError("차단됨"))),
        ("살아있는 소스", lambda: _russell_rows(2000, "B")),
    ]
    with patch("pipeline.src.universe_us._RUSSELL_SOURCES", sources):
        df, source = fetch_russell3000()

    assert source == "살아있는 소스"
    assert len(df) == 2000


def test_russell_rejects_a_source_that_returns_far_too_few_tickers():
    # 형식이 바뀌어 몇 줄만 파싱된 경우. 반쪽짜리를 쓰느니 다음 소스로 넘어간다.
    sources = [
        ("반쪽 파싱", lambda: _russell_rows(30, "A")),
        ("정상 소스", lambda: _russell_rows(2500, "B")),
    ]
    with patch("pipeline.src.universe_us._RUSSELL_SOURCES", sources):
        df, source = fetch_russell3000()

    assert source == "정상 소스"
    assert len(df) == 2500


def test_russell_error_lists_every_source_reason_when_all_fail():
    sources = [
        ("소스1", MagicMock(side_effect=RuntimeError("HTML 차단 페이지"))),
        ("소스2", MagicMock(side_effect=RuntimeError("타임아웃"))),
    ]
    with patch("pipeline.src.universe_us._RUSSELL_SOURCES", sources):
        try:
            fetch_russell3000()
        except RuntimeError as exc:
            assert "소스1" in str(exc) and "HTML 차단 페이지" in str(exc)
            assert "소스2" in str(exc) and "타임아웃" in str(exc)
        else:
            raise AssertionError("전부 실패했는데 에러가 나지 않았다")


# ── 네이버 해외주식 시총순 (2026-09-09 확정 소스) ──────────────────────────
# ETF 제공사(iShares·Vanguard)와 stockanalysis가 전부 막혀서, 시총 순으로
# 내려주는 네이버 증권 API가 유일하게 Russell 3000을 근사할 수 있는 소스다.

def _naver_json(rows: list[dict]):
    resp = MagicMock()
    resp.json.return_value = {"stocks": rows}
    resp.raise_for_status.return_value = None
    return resp


@patch("pipeline.src.universe_us.requests.get")
def test_naver_world_sorts_by_market_value_across_exchanges(mock_get):
    by_exchange = {
        "NASDAQ": [{"symbolCode": "NVDA", "stockName": "엔비디아", "marketValue": "5,000"}],
        "NYSE": [{"symbolCode": "BRK-B", "stockName": "버크셔", "marketValue": "1,000"}],
        "AMEX": [{"symbolCode": "IMO", "stockName": "임페리얼오일", "marketValue": "30"}],
    }

    def routed(url, **kwargs):
        exchange = url.rstrip("/").split("/")[-2]
        page = kwargs.get("params", {}).get("page", 1)
        # 2페이지부터는 빈 응답 — 실제 API도 마지막 페이지 뒤엔 빈 배열을 준다.
        return _naver_json(by_exchange.get(exchange, []) if page == 1 else [])

    mock_get.side_effect = routed
    df = _fetch_naver_world()

    # 거래소가 달라도 하나로 합쳐 시총 내림차순이어야 한다.
    assert list(df["ticker"]) == ["NVDA", "BRK-B", "IMO"]
    assert list(df["name"])[0] == "엔비디아"


@patch("pipeline.src.universe_us.requests.get")
def test_naver_world_reports_unknown_ticker_key(mock_get):
    # 응답 스키마가 바뀌어 티커 키가 사라지면, 조용히 빈 결과를 주는 대신
    # 어떤 키가 왔는지 알려줘야 한다(다음에 무엇을 고칠지 바로 보이도록).
    mock_get.side_effect = lambda url, **kw: _naver_json(
        [{"code": "NVDA", "nm": "엔비디아"}] * 20 if "NASDAQ" in url else []
    )

    try:
        _fetch_naver_world()
    except RuntimeError as exc:
        assert "티커 키를 찾을 수 없음" in str(exc) and "code" in str(exc)
    else:
        raise AssertionError("키를 못 찾았는데 에러가 나지 않았다")


@patch("pipeline.src.universe_us.requests.get")
def test_naver_world_drops_preferred_and_special_class_tickers(mock_get):
    # 네이버 목록엔 우선주('MS PRP')·특수 클래스('MKC V')가 섞여 오는데 야후엔 그
    # 표기가 없어 시세를 못 받는다. 상위 3,000개를 자르기 전에 빼야 그만큼 진짜
    # 종목이 안으로 들어온다.
    rows = [
        {"symbolCode": "MS PRP", "stockName": "모건스탠리 우선주", "marketValue": "9,000"},
        {"symbolCode": "MKC V", "stockName": "맥코믹 V", "marketValue": "8,000"},
        {"symbolCode": "NVDA", "stockName": "엔비디아", "marketValue": "5,000"},
        {"symbolCode": "BRK-B", "stockName": "버크셔 B", "marketValue": "1,000"},
    ]
    mock_get.side_effect = lambda url, **kw: _naver_json(rows if "NASDAQ" in url else [])

    df = _fetch_naver_world()

    assert list(df["ticker"]) == ["NVDA", "BRK-B"]
