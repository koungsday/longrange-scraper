/**
 * 변경 감지 — "이번 런에서 어느 지역이 바뀌었나" 를 계산한다.
 *
 * ★scraper-quota.js 에서 떼어낸 이유: 회귀 테스트가 **실제 배포 코드**를 부르게 하려고.
 *   본체는 puppeteer 등 무거운 의존성을 물어 테스트 프로세스에서 require 할 수 없다.
 *   사본을 테스트에 복사해 두면 코드가 갈라져도 테스트는 계속 통과한다 — 그게 최악이다.
 * ★이 파일은 **의존성이 없어야 한다.** 순수 함수만 둔다.
 */

/**
 * quota.json → 지역별 시그니처 Map<지역명, string>.
 * 한 지역의 모든 행(차종별)을 사용자가 보는 전체 필드(할당·등록·출고·잔여·선정·비고)로 서명.
 * 행 순서 무관하게 정렬 후 결합 → 순서만 바뀐 건 '변경'으로 오탐하지 않음.
 */
function regionSignatures(quotaJson) {
  const sigs = new Map();
  const rows = (quotaJson && quotaJson.data && quotaJson.data[0] && quotaJson.data[0].quotaData) || [];
  const byRegion = new Map();
  for (const r of rows) {
    const name = r.region;
    if (!name) continue;
    /* ★키에 sido 를 넣는다. 이름만 쓰면 **동명 지역이 하나로 뭉개진다** —
       실측: quota.json 지역명 160개 vs 코드 161개, 고성군(강원 4282 / 경남 4882)이 겹친다.
       그러면 nameToCode 도 last-wins 라 한 코드가 changed-codes 에 **영영 안 들어가고**,
       그 지역은 웹훅 사각지대가 되어 24h TTL 로만 갱신된다.
       바로 아래 regionNotes() 는 이미 같은 처방을 쓰고 그 이유까지 주석에 적어 뒀는데
       (동명 지역 분리) 여기에만 안 왔다. */
    const key = `${r.sido || ''}\t${name}`;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(JSON.stringify([
      r.vehicleType,
      r.quota_total, r.quota_priority, r.quota_corporate, r.quota_taxi, r.quota_general,
      r.registered_total, r.registered_priority, r.registered_corporate, r.registered_taxi, r.registered_general,
      r.delivered_total, r.delivered_priority, r.delivered_corporate, r.delivered_taxi, r.delivered_general,
      r.remaining_total, r.remaining_priority, r.remaining_corporate, r.remaining_taxi, r.remaining_general,
      // 선정대수·선정잔여 — 화면 판정(예산 소진 / 접수중)이 이 둘로 갈린다.
      // 빠져 있으면 판정이 뒤집혀도 재검증이 돌지 않아 옛 상태가 그대로 남는다.
      r.selected_total, r.selectedRemaining_total,
      r.note
    ]));
  }
  for (const [key, arr] of byRegion) {
    arr.sort();
    sigs.set(key, arr.join('|'));
  }
  return sigs;
}

/**
 * 이전 quota.json 대비 변경된 지역만 산출 → vw-k 온디맨드 재검증 대상 코드.
 * - 이전에 없던 지역(신규)·시그니처가 달라진 지역만 changed.
 * - nameToCode(donut)로 지역명→코드. 매핑 실패(코드 0/공백)는 제외(fallback revalidate가 커버).
 * - 이전값 없음(최초 실행)이면 전 지역 changed(1회성, 정상).
 */
function computeChangedCodes(oldQuota, newQuota, keyToCode) {
  const oldSigs = regionSignatures(oldQuota);
  const newSigs = regionSignatures(newQuota);
  const changedKeys = [];
  for (const [key, sig] of newSigs) {
    if (oldSigs.get(key) !== sig) changedKeys.push(key);
  }
  const codes = [];
  const seen = new Set();
  for (const key of changedKeys) {
    const code = String(keyToCode[key] || '').replace(/[^0-9]/g, '');
    if (!code) continue;
    if (!seen.has(code)) { seen.add(code); codes.push(code); }
  }
  /* 로그·알림은 사람이 읽으므로 시도 접두를 떼고 지역명만 남긴다 */
  return { codes, changedNames: changedKeys.map((k) => k.split('\t').pop()) };
}

/**
 * 부가 파일(공고 계열) 4종에서 **지역별로 내용이 달라진 코드**를 뽑는다.
 * ★왜 필요한가 — computeChangedCodes 는 quota.json 의 숫자 행만 서명한다.
 *   status·deadline·note 는 다른 엑셀 시트(「요약」)에서 오고, 공고문 첨부는 아예
 *   **별도 워크플로**가 만든다. 그래서 공고가 바뀌어도 codes 에 안 들어간다.
 *   실측(160쌍): 지역 콘텐츠가 바뀐 133건 중 48건(36%)을 놓쳤고, 공고 계열만 보면
 *   49건 중 48건(98%)을 놓쳤다. 지금 그게 안 터지는 건 웹훅이 notice-data 를 통째로
 *   지워 161개를 다 새로 그리기 때문이다 — 그 폭탄을 걷어내려면 여기가 먼저 맞아야 한다.
 * ★수집 실패본은 무시한다. available:false 나 빈 regions 를 비교에 넣으면
 *   전 지역이 '변경' 으로 잡혀 161개 재검증 폭탄이 된다.
 */
function auxChangedCodes(prevAux, nowAux) {
  const out = new Set();
  const pick = (j, f) => {
    if (!j || j.available === false) return null;
    if (f === 'notice-schedule') {
      /* items 키가 `${code}|${kind}` 다 — 코드로 묶는다 */
      const m = {};
      for (const [k, v] of Object.entries(j.items || {})) {
        const c = String(k).split('|')[0];
        if (c) (m[c] ||= []).push(v);
      }
      for (const c of Object.keys(m)) m[c].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      return Object.keys(m).length ? m : null;
    }
    const r = j.regions;
    return r && Object.keys(r).length ? r : null;
  };
  for (const f of Object.keys(nowAux)) {
    const a = pick(nowAux[f], f), b = pick(prevAux[f], f);
    if (!a || !b) continue;   /* 한쪽이 없거나 실패본 → 판정 보류 */
    for (const code of Object.keys(a)) {
      if (JSON.stringify(a[code]) !== JSON.stringify(b[code])) out.add(String(code).replace(/[^0-9]/g, ''));
    }
  }
  out.delete('');
  return [...out];
}

module.exports = { regionSignatures, computeChangedCodes, auxChangedCodes };
