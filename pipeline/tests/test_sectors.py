import pandas as pd

from pipeline.src.sectors import leading_sectors


def _build_fixture() -> pd.DataFrame:
    dates = pd.date_range("2024-01-01", periods=6)
    rows = []
    # Sector A: 거래액 높음 + 가격 상승(양의 모멘텀) -> 주도섹터 후보
    for i, d in enumerate(dates):
        rows.append({"ticker": "A1", "sector": "A", "date": d, "close": 100 + i, "volume": 1_000_000})
        rows.append({"ticker": "A2", "sector": "A", "date": d, "close": 50 + i * 0.5, "volume": 800_000})
    # Sector B: 거래액 높음 but 가격 하락(음의 모멘텀) -> 제외되어야 함
    for i, d in enumerate(dates):
        rows.append({"ticker": "B1", "sector": "B", "date": d, "close": 200 - i * 3, "volume": 1_200_000})
    # Sector C: 거래액 낮음 + 가격 상승 -> 후보지만 순위는 A보다 낮음
    for i, d in enumerate(dates):
        rows.append({"ticker": "C1", "sector": "C", "date": d, "close": 30 + i * 0.2, "volume": 100_000})
    return pd.DataFrame(rows)


def test_excludes_sector_with_negative_momentum():
    df = _build_fixture()
    result = leading_sectors(df, top_n=3)
    assert result == ["A", "C"]


def test_respects_top_n():
    df = _build_fixture()
    result = leading_sectors(df, top_n=1)
    assert result == ["A"]


def test_drops_rows_with_missing_sector():
    df = _build_fixture()
    extra = pd.DataFrame([
        {"ticker": "X1", "sector": None, "date": d, "close": 1000, "volume": 5_000_000}
        for d in pd.date_range("2024-01-01", periods=6)
    ])
    df = pd.concat([df, extra], ignore_index=True)
    result = leading_sectors(df, top_n=3)
    assert "X1" not in result
    assert result == ["A", "C"]
