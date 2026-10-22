# 노들섬 뉴스스크랩 — Render 무료 시험 운영

## 승인된 구성

- 웹서비스 `nodeul-news`: 무료, 싱가포르, 웹 서버 안에서 수집 실행.
- PostgreSQL `nodeul-news-db`: 무료, 싱가포르, 버전 16.
- 브라우저 기본 인증: 사용자 이름 `admin`, 비밀번호는 Render의 `APP_PASSWORD`.
- 유료 서비스, 유료 AI 키, 별도 Cron Job은 이 구성에서 만들지 않습니다.
- 실제 Render 배포 설정의 기준은 루트의 `render.yaml`입니다. Blueprint로 연결하면 이후 동기화도 이 파일을 기준으로 합니다.

## 배포

1. 변경 내용을 GitHub `boramsama01-code/nodeul_news`의 `main`에 반영합니다.
2. Render의 New Blueprint에서 이 저장소를 선택합니다. 이미 생성된 `nodeul-news-db`를 이름으로 연결하는지 확인합니다. 같은 이름의 DB를 중복 생성하지 않습니다.
3. 비용이 Free이고 지역이 Singapore인지 확인 후 적용합니다. `DATABASE_URL`은 내부 연결로 자동 연결되며, `APP_PASSWORD`와 `CONFIG_ENCRYPTION_KEY`는 자동 생성됩니다.
4. 배포가 `live`인지 확인하고 `/api/healthz`가 200인지 확인합니다. 비로그인 상태에서 `/`, `/api/articles`, `/api/settings`는 401이어야 합니다.
5. Render 환경변수 화면에서 `APP_PASSWORD`를 확인하여 로그인합니다. 키 값을 GitHub, 대화, 로그에 붙이지 않습니다.
6. 네이버 API 키는 앱 설정에서 등록합니다. 기존 PC는 오프라인이므로 그 PC의 최신 DB 및 API 키는 이번 복구에 포함되지 않았습니다.

## 데이터 보존

- 기사와 수집 작업은 PostgreSQL에 저장합니다.
- `STATE_BACKEND=postgres`이면 API 설정은 AES-256-GCM으로 암호화해 DB에 저장합니다. `CONFIG_ENCRYPTION_KEY`는 데이터 암호화키이므로 분실하거나 임의 교체하면 기존 설정을 읽을 수 없습니다.
- 수집 완료 시점을 DB에 저장하여 재시작 때 겹치는 기간을 다시 검색합니다. 검색 결과 한도와 RSS 보관기간 때문에 모든 과거 누락을 복원할 수는 없습니다.
- 시작할 때 기존 데이터를 삭제하지 않는 `CREATE TABLE IF NOT EXISTS` 스키마 준비를 실행합니다.
- `IMPORT_ARCHIVE_ONCE=true`는 GitHub의 `nodeulnews_data.sql`을 **빈 DB에 최초 한 번만** 가져옵니다. 기존 기사나 가져오기 완료 표시가 있으면 건너뜁니다. 재배포가 사용자가 삭제한 기사를 복구하지 않습니다.
- 백업은 과거 저장본이며 최신 PC DB와 같다고 보장하지 않습니다. 이전 검증 기준 중복을 제외한 6,041개 기사 행입니다. 포털 간 중복이 있어 고유 뉴스 수와 다릅니다.

## 무료 요금제의 실제 한계

- 15분 동안 외부 접속이 없으면 웹서비스와 내부 수집기가 중지될 수 있습니다. 다음 접속으로 깨어날 때 약 1분이 걸릴 수 있습니다.
- 워크스페이스의 무료 웹서비스 실행시간 750시간은 다른 무료 앱과 공유합니다.
- 이번 DB 생성 시각: 2026-10-22 10:19:59 KST. 만료 시각: **2026-11-21 10:19:59 KST** (Render 응답 기준).
- 데이터베이스 만료 전에 엑셀 내보내기 또는 SQL 백업을 확보하고 운영 방식 전환 여부를 결정해야 합니다. 업그레이드는 자동 수행하지 않습니다.
- 무료 운영을 상시 자동 수집으로 표현하지 않습니다.

## 검증과 다음 단계

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`: 기존 15개와 배포 관련 3개, 총 18개.
- `pnpm build:standalone`
- `render blueprints validate render.yaml --workspace <workspace ID> --output json`: CLI 별도 로그인이 필요합니다. 공식 JSON Schema 검증과 플랫폼 검증은 구분합니다.
- 실제 배포 후 DB 연결, 아카이브 복원 행 수, 실수집 출처별 성공·실패, 모바일 화면을 확인해야 합니다.

## 참고한 구현과 문서

2026-10-22 GitHub API 확인: RSSHub 46,603 stars, FreshRSS 16,377 stars, Miniflux 9,812 stars. 세 저장소 모두 최근 하루 안에 업데이트가 있었습니다. 코드 전체를 복제하지 않고 기존 구현을 유지했습니다. Miniflux의 DB를 기준으로 하는 배치 수집·상태 관리 구조를 참고하여 클라우드의 임시 파일 의존을 제거했습니다.

- https://github.com/miniflux/v2/blob/main/internal/cli/scheduler.go
- https://github.com/DIYgod/RSSHub
- https://github.com/FreshRSS/FreshRSS
- https://render.com/docs/free
- https://render.com/docs/health-checks
- https://render.com/docs/blueprint-spec
- https://pnpm.io/settings/build
