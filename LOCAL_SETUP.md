# 로컬 PC 개발 환경 세팅 가이드 (Windows + VS Code)

김한수의 보물지도 웹사이트를 **내 PC에서 직접 수정하고 미리보기**로 확인하기 위한 세팅 안내입니다.
위에서부터 순서대로 한 번만 따라 하면 됩니다. 두 번째부터는 [매번 작업 시작할 때](#7-매번-작업-시작할-때) 부분만 보면 돼요.

> 이 프로젝트 구조
> - `frontend/` — 실제 웹사이트 화면 (Next.js / Node.js)
> - `pipeline/` — 주식 데이터를 모으는 파이썬 프로그램 (Python)
> - `supabase/` — 데이터베이스 설정
>
> **웹사이트 화면만 수정할 거면 `frontend/`만 세팅하면 됩니다.** (1~7단계)
> 데이터 수집기까지 만질 거면 [8. 파이프라인(Python) 세팅](#8-파이프라인python-세팅)도 하세요.

---

## 1. 필수 프로그램 설치

아래 3개를 설치합니다. 이미 있으면 건너뛰어도 됩니다.

### ① Git (코드 다운로드/업로드용)
- https://git-scm.com/download/win 에서 다운로드 → 설치
- 설치 옵션은 전부 **기본값(Next)** 으로 두면 됩니다.
- 확인: 설치 후 터미널(PowerShell)에서 `git --version` 입력 → 버전이 나오면 성공

### ② Node.js 22 LTS (웹사이트 실행용)
- https://nodejs.org 에서 **LTS 버전** 다운로드 → 설치 (기본값으로 진행)
- 확인: `node -v` 했을 때 `v22.x.x` 처럼 나오면 성공

### ③ VS Code (코드 편집기)
- https://code.visualstudio.com 에서 다운로드 → 설치
- 설치 중 **"Code(으)로 열기" 관련 체크박스**가 나오면 전부 체크하면 편합니다.

> 파이프라인(Python)까지 할 거면 [Python 3.11](https://www.python.org/downloads/)도 설치하세요.
> 설치할 때 **"Add python.exe to PATH"** 체크박스를 꼭 켜세요.

---

## 2. 코드 내려받기 (한 번만)

1. 코드를 저장할 폴더를 정합니다. 예: `문서(Documents)` 폴더
2. VS Code를 켜고 상단 메뉴 **터미널(Terminal) → 새 터미널(New Terminal)** 을 엽니다.
3. 아래 명령을 한 줄씩 입력합니다. (`cd` 뒤 경로는 원하는 위치로 바꿔도 됩니다)

```powershell
cd $HOME\Documents
git clone https://github.com/Kim-Hansu-94/stock-screener.git
cd stock-screener
```

> `git clone` 할 때 GitHub 로그인 창이 뜨면 본인 GitHub 계정으로 로그인하면 됩니다.

---

## 3. VS Code에서 프로젝트 열기

- VS Code 메뉴 **파일(File) → 폴더 열기(Open Folder)** → 방금 만들어진 `stock-screener` 폴더 선택
- 또는 터미널에서: `code .`

프로젝트가 열리면, 오른쪽 아래에 **"권장 확장 프로그램 설치"** 안내가 뜰 수 있어요. **설치(Install)** 를 누르면 이 프로젝트에 맞는 도구들이 자동으로 깔립니다.
(안 떠도 괜찮아요. 왼쪽 확장 아이콘에서 `ESLint`, `Prettier`, `Python`을 검색해 설치하면 됩니다.)

---

## 4. 비밀 키 파일 만들기 (중요)

웹사이트가 데이터베이스에 접속하려면 **비밀 키**가 필요합니다.
이 키는 보안상 코드에 올리지 않으므로, 내 PC에만 직접 만들어 둡니다.

1. VS Code 왼쪽 파일 목록에서 `frontend` 폴더를 우클릭 → **새 파일(New File)**
2. 파일 이름을 정확히 **`.env.local`** 로 입력 (앞의 점 포함)
3. 아래 내용을 붙여넣고, `=` 뒤에 실제 값을 채웁니다:

```
SUPABASE_URL=여기에_실제_주소
SUPABASE_SERVICE_KEY=여기에_실제_키
KIS_APP_KEY=여기에_실제_키
KIS_APP_SECRET=여기에_실제_키
```

> **실제 값은 어디서 구하나요?**
> - 기존에 클라우드(Codespaces/웹) 세팅에서 쓰던 값과 동일합니다.
> - Supabase 값: [Supabase 대시보드](https://supabase.com/dashboard) → 프로젝트 → Settings → API 에서 `Project URL`과 `service_role` 키
> - KIS 값: 한국투자증권 오픈API에서 발급받은 키 (웹사이트 화면만 볼 거면 KIS 두 줄은 비워둬도 대부분 동작합니다)
>
> 이 값들을 잘 모르겠으면 저(클로드)에게 "환경변수 값 어디서 찾아?" 라고 물어보세요.

4. 저장(Ctrl+S). 이 파일은 `.gitignore`에 등록돼 있어 **실수로 GitHub에 올라가지 않으니** 안심하세요.

---

## 5. 웹사이트 부품 설치 (한 번만)

터미널에서 아래를 실행합니다. (인터넷 상황에 따라 몇 분 걸릴 수 있어요)

```powershell
cd frontend
npm install
```

---

## 6. 웹사이트 실행해서 미리보기

```powershell
npm run dev
```

- 잠시 뒤 터미널에 `http://localhost:3000` 같은 주소가 나옵니다.
- Ctrl 누른 채로 그 주소를 클릭하거나, 브라우저 주소창에 `http://localhost:3000` 입력 → **내 PC에서 웹사이트가 뜹니다.**
- 이제 `frontend/app/` 안의 코드를 수정하고 저장하면 **화면이 자동으로 새로고침**됩니다.
- 그만 볼 때는 터미널에서 **Ctrl + C** 를 누르면 종료됩니다.

---

## 7. 매번 작업 시작할 때 (두 번째부터는 여기만)

VS Code에서 프로젝트를 열고 터미널에서:

```powershell
git pull                # 최신 코드 받기 (다른 곳에서 수정한 내용 반영)
cd frontend
npm run dev             # 미리보기 서버 켜기
```

수정을 마친 뒤 **저장(업로드)** 하려면 새 터미널을 하나 더 열어서:

```powershell
cd $HOME\Documents\stock-screener
git add .
git commit -m "수정 내용 간단 설명"
git push
```

> `git push` 하면 GitHub에 올라가고, 연결된 배포가 있으면 실제 사이트에도 반영됩니다.
> 커밋 메시지에는 무엇을 바꿨는지 짧게 한국어로 적으면 됩니다.

---

## 8. 파이프라인(Python) 세팅 — 데이터 수집기까지 만질 경우에만

```powershell
cd $HOME\Documents\stock-screener\pipeline
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

- `frontend/.env.local`과 같은 방식으로 `pipeline` 폴더 안에 **`.env`** 파일을 만들고
  `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`(및 필요 시 KIS 키)를 채웁니다.
- 실행: `.\run_pipeline.ps1` 또는 `run_pipeline.bat`

> PowerShell에서 `Activate.ps1` 실행 시 보안 오류가 나면, 관리자 권한 PowerShell에서
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 한 번 실행 후 다시 시도하세요.

---

## 자주 겪는 문제

| 증상 | 해결 |
|---|---|
| `npm : 용어가 아닙니다` | Node.js가 안 깔렸거나 VS Code를 껐다 켜야 함 → Node 설치 후 VS Code 재시작 |
| `git : 용어가 아닙니다` | Git 설치 후 VS Code 재시작 |
| 화면이 뜨는데 데이터가 안 보임 | `frontend/.env.local`의 키 값이 비었거나 틀림 → 4단계 다시 확인 |
| 포트 3000이 이미 사용 중 | 이전 `npm run dev`가 살아있는 것 → 그 터미널에서 Ctrl+C |
| `npm install`이 실패 | 인터넷 확인 후 `npm install` 재시도, 그래도 안 되면 `frontend/node_modules` 폴더 삭제 후 재시도 |

막히면 언제든 클로드(웹/Codespaces)에게 에러 메시지를 그대로 붙여넣고 물어보세요.
