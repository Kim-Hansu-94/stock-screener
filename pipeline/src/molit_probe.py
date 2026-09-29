"""국토부 API(apis.data.go.kr) 연결이 왜 가끔 안 되는지 가리는 진단.

부동산 수집이 `Connection to apis.data.go.kr timed out (connect timeout=20)`으로
격주에 한 번꼴로 실패한다(2026-09-14, 09-29). 읽기 시간 초과(Read timeout)가 아니라
**연결 시간 초과**라서 요청이 서버에 닿기도 전에 막힌 것이다. 원인 후보:

  1) DNS가 여러 서버 주소를 돌려주는데 그중 죽은 주소가 섞여 있다
  2) 이 실행 서버의 공인 IP가 국토부 쪽 방화벽에서 막히거나 느려진다(해외 IP 제한 등)
  3) 국토부 서버가 그 시각에 불안정하다

이 진단은 API 키를 쓰지 않는다(TCP 연결만 재므로 호출 한도를 소모하지 않는다).
성패를 판정하지 않고 **주소별로 몇 번 중 몇 번 붙었는지**를 그대로 찍는다.
잘 되는 국내 사이트(DART·네이버)를 같이 재서 '이 서버에서 한국으로 나가는 길 전체'가
문제인지 '국토부만' 문제인지 갈린다.
"""

from __future__ import annotations

import socket
import ssl
import sys
import time
import urllib.request

_TARGET = "apis.data.go.kr"
_CONTROLS = ["opendart.fss.or.kr", "m.stock.naver.com"]
_TRIES = 5
_CONNECT_TIMEOUT = 10.0


def _public_ip() -> str:
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                return r.read().decode().strip()
        except Exception as e:  # noqa: BLE001 - 진단이라 사유를 그대로 찍는다
            last = f"{type(e).__name__}: {e}"
    return f"확인 실패 ({last})"


def _resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})


def _try_connect(ip: str, host: str) -> tuple[bool, float, str]:
    """TCP 연결 + TLS 핸드셰이크까지. (성공 여부, 걸린 초, 실패 사유)"""
    start = time.monotonic()
    try:
        with socket.create_connection((ip, 443), timeout=_CONNECT_TIMEOUT) as sock:
            ctx = ssl.create_default_context()
            with ctx.wrap_socket(sock, server_hostname=host):
                pass
        return True, time.monotonic() - start, ""
    except Exception as e:  # noqa: BLE001
        return False, time.monotonic() - start, f"{type(e).__name__}: {e}"


def _probe_host(host: str) -> bool:
    """모든 주소에서 모든 시도가 붙었으면 True."""
    print(f"\n=== {host} ===", flush=True)
    try:
        ips = _resolve(host)
    except Exception as e:  # noqa: BLE001
        print(f"  DNS 조회 실패: {type(e).__name__}: {e}", flush=True)
        return False
    print(f"  DNS가 돌려준 주소 {len(ips)}개: {ips}", flush=True)
    all_ok = True
    for ip in ips:
        results = [_try_connect(ip, host) for _ in range(_TRIES)]
        ok = [r for r in results if r[0]]
        line = f"  {ip}: {len(ok)}/{_TRIES}회 성공"
        if ok:
            line += f" (평균 {sum(r[1] for r in ok) / len(ok):.2f}초)"
        print(line, flush=True)
        fails = [r for r in results if not r[0]]
        if fails:
            all_ok = False
            print(f"    실패 사유 예: {fails[0][2]}", flush=True)
    return all_ok


def main() -> None:
    print(f"이 실행 서버의 공인 IP: {_public_ip()}", flush=True)
    target_ok = _probe_host(_TARGET)
    for host in _CONTROLS:
        _probe_host(host)
    if not target_ok:
        # 실패를 놓치지 않게 빨간 X로 남긴다 — 목적이 '언제, 어떤 IP에서 실패하나'를 잡는 것이다.
        # 대조 사이트(DART·네이버)의 성패는 종료 코드에 반영하지 않는다(참고용).
        print("::error::국토부(apis.data.go.kr) 연결 실패 — 위 공인 IP와 시각을 기록할 것")
        sys.exit(1)


if __name__ == "__main__":
    main()
