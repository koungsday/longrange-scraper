# koungs-day-web 레포 변경 요청 프롬프트

> 이 프롬프트를 koungs-day-web 레포의 AI에게 전달하세요.

---

## 배경

`longrange-scraper` 레포에서 파이프라인을 개선했습니다 (Phase 3).

**변경 전**: 스크래핑 → scraper repo 커밋 → **web repo에 데이터 push** → Vercel 재배포 (3분 지연)
**변경 후**: 스크래핑 → scraper repo 커밋 → **GitHub Pages에서 직접 서빙** (즉시 반영)

더 이상 scraper가 web repo에 데이터를 push하지 않습니다.
데이터는 GitHub Pages에서 직접 제공됩니다.

## 새 데이터 URL

**Base URL**: `https://koungsday.github.io/longrange-scraper`

| 데이터 | 새 URL |
|--------|--------|
| 할당량 | `https://koungsday.github.io/longrange-scraper/quota.json` |
| 연도 목록 | `https://koungsday.github.io/longrange-scraper/years.json` |
| 보조금 (2026) | `https://koungsday.github.io/longrange-scraper/2026/subsidies.json` |
| 차량 (2026) | `https://koungsday.github.io/longrange-scraper/2026/vehicles.json` |
| 보조금 (2025) | `https://koungsday.github.io/longrange-scraper/2025/subsidies.json` |
| 차량 (2025) | `https://koungsday.github.io/longrange-scraper/2025/vehicles.json` |

## 해야 할 작업

### 1. 데이터 fetch URL 변경

프론트엔드에서 데이터를 가져오는 모든 곳의 URL을 변경해주세요:

- **변경 전**: `/data/quota.json`, `/data/years.json`, `/data/2026/subsidies.json` 등 (로컬 경로)
- **변경 후**: `https://koungsday.github.io/longrange-scraper/quota.json` 등 (GitHub Pages 외부 URL)

데이터 base URL을 환경변수나 상수로 관리하면 좋습니다:
```typescript
// 예시
const DATA_BASE_URL = process.env.NEXT_PUBLIC_DATA_URL || 'https://koungsday.github.io/longrange-scraper';
```

### 2. `public/data/` 정리

더 이상 scraper가 이 폴더에 push하지 않으므로:
- `public/data/` 폴더를 삭제해도 됩니다
- 또는 fallback/캐시 용도로 남겨두되, fetch는 GitHub Pages에서 하도록

### 3. `update-all-data.yml` 검토

이 워크플로우에서 데이터 URL을 참조하는 부분이 있다면 변경 필요:
- Redis 스냅샷 저장 시 데이터 fetch URL이 로컬 경로(`/data/...`)인지 확인
- 로컬 경로라면 GitHub Pages URL로 변경

### 4. CORS 확인

GitHub Pages는 public repo에 대해 CORS를 기본 허용하지만, 혹시 문제가 생기면:
- Next.js의 `next.config.js`에 이미지/리소스 도메인 설정이 필요할 수 있음
- fetch 요청이 정상적으로 작동하는지 확인

## 참고

- scraper repo: `koungsday/longrange-scraper`
- 설계 문서: `longrange-scraper/PIPELINE-REDESIGN.md` (Phase 3 참조)
- GitHub Pages는 scraper repo의 Settings → Pages에서 "GitHub Actions" 소스로 활성화 필요
