# longrange-scraper Sync 최적화 가이드

## 📋 목표

longrange-scraper 리포지토리의 Sync 워크플로우를 최적화하여 **불필요한 배포를 방지**합니다.

**효과:**
- 현재: 매시간 무조건 커밋 → 25번/일 (quota 24 + subsidies 1)
- 최적화 후: **변경 있을 때만 커밋** → 10-15번/일 (40-60% 감소!)

---

## 🔍 현재 구조

### 스크래핑 빈도 (실제):

```
longrange-scraper/.github/workflows/
├── scrape-quota.yml         # 매시간 실행 (30초 작업)
├── scrape-subsidies.yml     # 하루 1번 실행 (3분 작업)
└── sync-data.yml            # 스크래핑 완료 후 실행
```

**동작 방식:**
1. **Quota 스크래핑** (매시간):
   - 01:00, 02:00, ... 24:00 → 24번
   - 할당량 실시간 모니터링 (빠른 업데이트 필요)

2. **Subsidies 스크래핑** (하루 1번):
   - 매일 특정 시간 (예: 03:00) → 1번
   - 보조금 정보는 자주 안 바뀜

3. **Sync 워크플로우** (스크래핑 후):
   - Quota 스크래핑 완료 → Sync → koungs-day-web 커밋
   - Subsidies 스크래핑 완료 → Sync → koungs-day-web 커밋
   - **= 25번 커밋/일 → 25번 Vercel 배포**

### 문제점:

```yaml
# 현재 sync-data.yml (추정)
- name: Copy and commit
  run: |
    cp scraper/data/*.json web/public/data/
    git add public/data/
    git commit -m "chore: Auto-update scraper data"  # ← 항상 커밋!
    git push  # ← 매번 배포!
```

**문제:**
- Quota가 변경되지 않아도 **무조건 커밋**
- 심야/주말에 신청자 없어도 **계속 배포**
- **불필요한 Vercel 배포 발생** (10-15번 정도)

**예시:**
```
01시: quota 100건 → sync → 커밋 → 배포 ✅
02시: quota 100건 (변경 없음!) → sync → 커밋 → 배포 ❌ 불필요!
03시: quota 95건 (5건 소진) → sync → 커밋 → 배포 ✅
```

---

## ✅ 최적화 방법: 변경 감지 추가

### 핵심 아이디어:

**Git diff로 실제 변경사항을 확인** → 변경 있을 때만 커밋!

```yaml
# Before
git commit  # 항상 커밋

# After
if git diff --quiet; then
  echo "변경 없음 - 커밋 생략"  # ← 배포 절약!
else
  git commit  # 변경 있을 때만
fi
```

---

## 🔧 최적화된 Sync 워크플로우

`longrange-scraper/.github/workflows/sync-data-optimized.yml`:

```yaml
name: Sync Data to koungs-day-web (Optimized)

on:
  workflow_run:
    # Quota, Subsidies 스크래퍼 완료 후 실행
    workflows: ["Scrape Quota", "Scrape Subsidies"]  # ← 실제 워크플로우 이름으로 수정
    types: [completed]

  # 수동 테스트용
  workflow_dispatch:

jobs:
  sync-data:
    runs-on: ubuntu-latest

    steps:
      # ========================================
      # 1. 스크래퍼 리포 체크아웃
      # ========================================
      - name: Checkout scraper repository
        uses: actions/checkout@v4
        with:
          path: scraper

      # ========================================
      # 2. 웹 리포 체크아웃
      # ========================================
      - name: Checkout koungs-day-web repository
        uses: actions/checkout@v4
        with:
          repository: koungsday/koungs-day-web
          token: ${{ secrets.PAT_TOKEN }}
          path: web

      # ========================================
      # 3. 데이터 파일 복사
      # ========================================
      - name: Copy scraped data to web repo
        run: |
          echo "📥 Copying scraped data..."

          # public/data 폴더 확인/생성
          mkdir -p web/public/data

          # quota.json, subsidies.json 복사 (실제 경로에 맞게 수정)
          cp scraper/data/quota.json web/public/data/ || echo "⚠️ quota.json not found"
          cp scraper/data/subsidies.json web/public/data/ || echo "⚠️ subsidies.json not found"

          # 또는 다른 경로라면:
          # cp scraper/output/quota.json web/public/data/
          # cp scraper/output/subsidies.json web/public/data/

          # 복사된 파일 확인
          echo "📁 Files in web/public/data/:"
          ls -lh web/public/data/

      # ========================================
      # 4. 변경사항 감지 (핵심!)
      # ========================================
      - name: Check if data actually changed
        id: check_changes
        working-directory: web
        run: |
          # Git diff로 실제 변경 확인
          if git diff --quiet public/data/quota.json public/data/subsidies.json; then
            # 변경 없음
            echo "changed=false" >> $GITHUB_OUTPUT
            echo "ℹ️ No data changes detected"
            echo "💡 Skipping commit to save Vercel deployment!"
          else
            # 변경 있음
            echo "changed=true" >> $GITHUB_OUTPUT
            echo "✅ Data changes detected:"

            # 어떤 파일이 변경되었는지 로그
            if ! git diff --quiet public/data/quota.json 2>/dev/null; then
              echo "  📝 quota.json changed"
              git diff --stat public/data/quota.json
            fi

            if ! git diff --quiet public/data/subsidies.json 2>/dev/null; then
              echo "  📝 subsidies.json changed"
              git diff --stat public/data/subsidies.json
            fi
          fi

      # ========================================
      # 5. 조건부 커밋 (변경 있을 때만!)
      # ========================================
      - name: Commit and push ONLY if data changed
        if: steps.check_changes.outputs.changed == 'true'
        working-directory: web
        run: |
          echo "📤 Committing changes to koungs-day-web..."

          git config user.name "GitHub Actions Bot"
          git config user.email "actions@github.com"

          # 변경된 파일만 add
          git add public/data/quota.json public/data/subsidies.json

          # 커밋 메시지 생성
          git commit -m "chore: Auto-update scraper data

          Updated at: $(date -u +'%Y-%m-%d %H:%M:%S UTC')

          Data sources:
            - Quota: 무공해차 누리집 (할당량)
            - Subsidies: 무공해차 누리집 (보조금)

          Synced from koungsday/longrange-scraper @ ${{ github.sha }}"

          # Push
          git push

          echo "✅ Data synced and deployed to Vercel"

      # ========================================
      # 6. 결과 로그
      # ========================================
      - name: Log sync result
        run: |
          echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
          if [ "${{ steps.check_changes.outputs.changed }}" == "true" ]; then
            echo "✅ Sync completed: Data changed and committed"
            echo "🚀 Vercel deployment triggered"
          else
            echo "⏭️  Sync skipped: No data changes"
            echo "💰 Saved 1 Vercel deployment!"
          fi
          echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

---

## 📝 적용 방법

### 1. 기존 sync 워크플로우 백업

```bash
# longrange-scraper 리포지토리에서
cd .github/workflows
cp sync-data.yml sync-data.yml.backup  # 백업 (혹시 모르니)
```

### 2. 워크플로우 이름 확인

```bash
# 실제 스크래퍼 워크플로우 이름 확인
ls .github/workflows/scrape*.yml

# 파일을 열어서 'name:' 항목 확인
cat .github/workflows/scrape-quota.yml | grep "^name:"
cat .github/workflows/scrape-subsidies.yml | grep "^name:"
```

예시:
```yaml
# scrape-quota.yml
name: "Scrape EV Quota"  # ← 이 이름을 사용

# scrape-subsidies.yml
name: "Scrape EV Subsidies"  # ← 이 이름을 사용
```

### 3. 새 워크플로우 생성

위의 **최적화된 Sync 워크플로우 코드**를 복사해서:
- `longrange-scraper/.github/workflows/sync-data-optimized.yml` 생성
- `workflows:` 부분을 실제 이름으로 수정:

```yaml
workflow_run:
  workflows: ["Scrape EV Quota", "Scrape EV Subsidies"]  # ← 실제 이름
```

### 4. 데이터 경로 수정

스크래핑된 데이터 파일 경로를 확인:

```bash
# longrange-scraper에서
find . -name "quota.json" -o -name "subsidies.json"
```

예를 들어:
- `./data/quota.json` → `cp scraper/data/quota.json ...`
- `./output/quota.json` → `cp scraper/output/quota.json ...`

### 5. 기존 워크플로우 비활성화 (삭제 X)

안전하게 이름만 변경:

```bash
# 기존 sync-data.yml을 비활성화 (나중에 되돌릴 수 있음)
mv sync-data.yml sync-data.yml.disabled
```

### 6. 커밋 & 푸시

```bash
git add .github/workflows/
git commit -m "feat: Sync 워크플로우 최적화 - 변경 감지 추가

- sync-data-optimized.yml 신규 생성
- Git diff로 실제 변경사항 확인
- 변경 있을 때만 koungs-day-web에 커밋

예상 효과:
- 기존: 25번 커밋/일 (무조건)
- 최적화: 10-15번 커밋/일 (변경 시에만)
- Vercel 배포 40-60% 감소"

git push
```

---

## 🧪 테스트

### 1. 수동 실행 테스트

GitHub에서:
1. `longrange-scraper` 리포 → **Actions** 탭
2. **"Sync Data to koungs-day-web (Optimized)"** 클릭
3. **"Run workflow"** 버튼 클릭
4. 브랜치 선택 (main) → **"Run workflow"** 확인

### 2. 로그 확인

Actions 로그에서:
- ✅ "No data changes detected" → 커밋 생략됨
- ✅ "Data changes detected" → 커밋 생성됨
- ✅ "Saved 1 Vercel deployment!" 메시지 확인

### 3. koungs-day-web 확인

1. **커밋 확인:**
   - https://github.com/koungsday/koungs-day-web/commits/main
   - 변경 없을 때는 커밋 안 생김 ✅

2. **Vercel 배포 확인:**
   - https://vercel.com/koung-s/koungs-day-web/deployments
   - 배포 횟수 감소 확인

---

## 📊 효과 분석

### 배포 횟수 변화:

#### Before (최적화 전):
```
Quota 스크래핑: 24번/일
  → 매번 sync → 24번 커밋 (변경 여부 무관)

Subsidies 스크래핑: 1번/일
  → sync → 1번 커밋

총: 25번 koungs-day-web 커밋 = 25번 Vercel 배포
```

#### After (최적화 후):
```
Quota 스크래핑: 24번/일
  → sync 실행 24번
  → 변경 감지: 10-15번만 실제 변경
  → 커밋: 10-15번 (60% 만)

Subsidies 스크래핑: 1번/일
  → sync → 1번 커밋 (거의 항상 변경 있음)

총: 10-16번 koungs-day-web 커밋 = 10-16번 Vercel 배포
```

**절감:** 25번 → 10-15번 (40-60% 감소!) 🎉

### 전체 배포 횟수 (koungs-day-web + longrange):

```
✅ koungs-day-web 통합 완료: 24번/일
✅ longrange sync 최적화: 10-15번/일
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
총: 34-39번/일

Vercel 무료 플랜 100번 제한 대비: 61-66번 여유! ✅✅
```

---

## 💡 왜 변경이 적을까?

### Quota 데이터 변경 패턴:

**변경 많은 시간 (10-15시간):**
- 평일 오전 9시-오후 6시: 신청 집중
- 할당량 빠르게 소진

**변경 없는 시간 (9-14시간):**
- 심야/새벽 (00:00-07:00): 신청자 거의 없음
- 주말: 관공서 휴무
- 공휴일: 업무 중단

**결과:** 24번 스크래핑 중 **10-15번만 실제 변경**

---

## ⚠️ 주의사항

### 1. 워크플로우 이름 정확히 확인

```yaml
# sync-data-optimized.yml에서
workflow_run:
  workflows: ["정확한 이름"]  # ← 대소문자, 공백 정확히!
```

잘못된 이름 → Sync가 실행 안 됨!

### 2. 데이터 경로 확인

```yaml
# 실제 경로로 수정 필요
cp scraper/data/quota.json web/public/data/
cp scraper/output/quota.json web/public/data/  # 또는 output?
```

경로 틀리면 → 파일 복사 실패!

### 3. PAT_TOKEN 권한 확인

```bash
# longrange-scraper Settings → Secrets → PAT_TOKEN
# 권한: repo (전체) 필요
```

권한 없으면 → Push 실패!

### 4. 기존 sync 완전히 비활성화

```bash
# 두 워크플로우가 동시 실행되면 충돌!
mv sync-data.yml sync-data.yml.disabled
```

---

## 🎯 선택적 추가 최적화

### 옵션 1: 배치 처리 (더 큰 감소)

여러 번 스크래핑 후 한 번만 sync:

```yaml
# Quota 스크래핑은 매시간, Sync는 3시간마다
name: Scheduled Sync

on:
  schedule:
    - cron: '0 */3 * * *'  # 3시간마다 sync

jobs:
  sync:
    # 최신 quota.json, subsidies.json을 확인해서 sync
```

**효과:** 10-15번 → 5-8번 (하지만 최신성 떨어짐)

### 옵션 2: 스마트 스케줄

피크 시간만 자주 sync:

```yaml
schedule:
  # 평일 9-18시: 매시간 sync
  - cron: '0 9-18 * * 1-5'

  # 나머지: 3시간마다
  - cron: '0 */3 * * *'
```

---

## 📞 문제 해결

### Q: "No data changes detected"만 계속 나옴

**원인:** 데이터 경로가 잘못됨 → 파일 복사 안 됨

**해결:**
```bash
# 로그에서 "Files in web/public/data/:" 부분 확인
# quota.json, subsidies.json이 보이는지 체크
```

### Q: Sync가 실행 안 됨

**원인:** `workflow_run`의 워크플로우 이름 오류

**해결:**
```bash
# 스크래퍼 워크플로우 이름 정확히 확인
cat .github/workflows/scrape-quota.yml | grep "^name:"
```

### Q: Push 실패 (Permission denied)

**원인:** PAT_TOKEN 권한 부족

**해결:**
1. GitHub Settings → Developer settings → Personal access tokens
2. `repo` 전체 권한 확인
3. 토큰 재생성 → longrange-scraper Secrets 업데이트

### Q: 여전히 25번 배포됨

**원인:** 기존 sync-data.yml이 아직 활성화됨

**해결:**
```bash
# 기존 워크플로우 완전히 비활성화
mv .github/workflows/sync-data.yml sync-data.yml.disabled
git add -A && git commit -m "disable old sync" && git push
```

---

## ✅ 완료 체크리스트

- [ ] 스크래퍼 워크플로우 이름 확인
- [ ] 데이터 파일 경로 확인 (data/ or output/)
- [ ] PAT_TOKEN 설정 확인
- [ ] sync-data-optimized.yml 생성 및 경로 수정
- [ ] 기존 sync-data.yml 비활성화
- [ ] 커밋 & 푸시
- [ ] 수동 테스트 실행 (Run workflow)
- [ ] "No changes - skipped commit" 메시지 확인
- [ ] koungs-day-web 커밋 횟수 감소 확인
- [ ] Vercel 배포 횟수 모니터링 (며칠)

---

## 📈 모니터링

### 1주일 후 확인:

```bash
# koungs-day-web 커밋 통계
# 최근 7일간 "Auto-update scraper data" 커밋 개수
git log --since="7 days ago" --grep="scraper data" --oneline | wc -l

# 예상: 70-105개 (하루 10-15개 × 7일)
```

**25 × 7 = 175개보다 적으면 성공!** ✅

---

## 🎉 최종 정리

### Before:
```
총 배포: 49번/일
  - koungs-day-web: 24번
  - longrange sync: 25번
```

### After:
```
총 배포: 34-39번/일 (약 30% 감소!)
  - koungs-day-web: 24번
  - longrange sync: 10-15번 (최적화!)

Vercel 100번 제한 대비: 61-66번 여유
개발 작업 30번 + 자동 39번 = 69번 (여유 31번!)
```

**✅ Vercel Hobby 플랜으로 충분히 안정적으로 운영 가능!**

---

**작성자:** Claude
**작성일:** 2025-11-24
**버전:** 2.0 (Sync 최적화 버전)
