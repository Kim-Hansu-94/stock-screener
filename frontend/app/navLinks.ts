// 상단 탭 목록 — NavLinks가 렌더에 쓴다.
// 예전엔 SwipeNavigation(좌우 스와이프로 다음/이전 탭 계산)도 이 순서를 함께 봐서
// 데이터를 한 곳에 모아 뒀는데, 스와이프는 2026-10-01에 뺐다(사용자: "은근 불편하네").
// 지금은 읽는 곳이 하나지만 탭 목록은 그대로 여기 둔다 — layout이 아니라 이 파일을
// 보면 탭 구성이 한눈에 들어온다.
export const LINKS = [
  { href: '/', label: '490590 매수체크' },
  { href: '/realestate', label: '부동산' },
  { href: '/pullback', label: '눌림목 종목' },
  { href: '/discover', label: '종목 발굴' },
  { href: '/positions', label: '보유 종목 점검' },
  { href: '/history', label: '스크리너 성적' },
]
