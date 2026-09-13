# Replit 반영 안내

1. 현재 Replit 프로젝트를 열고 Git 변경사항이 있으면 먼저 저장합니다. 기존 변경사항을 강제로 버리지 마세요.
2. GitHub main의 수정본을 가져옵니다. 충돌이 있으면 해결한 뒤 진행합니다.
3. Replit Secrets에서 DATABASE_URL, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET을 확인합니다. 기존 .replit 파일에 공개되었던 네이버 키는 재발급한 뒤 Secrets에 저장하세요. 비밀 값을 파일이나 GitHub에 커밋하지 마세요.
4. pnpm install --frozen-lockfile, pnpm typecheck, pnpm test, pnpm build:standalone을 실행합니다. 데이터베이스를 초기화하거나 삭제할 필요가 없습니다.
5. Run으로 미리보기에서 /api/healthz와 데이터 수집 화면의 실행 이력을 확인한 뒤 기존 앱을 다시 게시합니다.

관리형 API 아티팩트와 일반 배포 경로 모두 RUN_SCHEDULER=true를 설정합니다. 일반 배포에서는 scripts/start-replit.mjs가 API와 빌드된 화면을 함께 제공합니다. Replit의 기존 배포 유형(Autoscale)은 변경하지 않았습니다. 서버가 절전·종료되면 백그라운드 수집도 멈추므로 이 설정만으로 24시간 실행을 보장하지 않습니다. 요금제 변경이나 유료 서비스 신청은 포함되지 않습니다.

기존 DB의 articles와 crawl_jobs 스키마를 사용하며 자동 스키마 삭제·교체는 하지 않습니다. 수집 코드 변경과 DB 이전은 별개의 작업입니다. 현재 로컬 PC용 실행본의 데이터베이스를 Replit DB에 자동 덮어쓰지 않습니다.

공개된 키는 현재 파일에서 제거해도 이전 Git 기록에는 남습니다. 키 재발급이 필요하며, 기록을 강제로 다시 쓰는 작업은 수행하지 않습니다.
