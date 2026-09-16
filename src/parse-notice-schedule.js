/**
 * 환경부 Excel 「공고별_일정」 시트 → 공고 차수 목록 + 변경 감지.
 *
 * ★★이게 추경 개시 신호다.
 *   공고 차수가 새로 뜨거나 접수 일정이 바뀌면 곧 추경 접수가 시작된다는 뜻이고,
 *   그건 물량이 새로 풀린다는 뜻이다. **감지 자체가 상품**이므로 지연을 줄여야 한다.
 *
 * ★왜 첨부 파일이 아니라 이 시트인가
 *   같은 10분 지연인데 **추가 요청이 0**이다 — 이미 10분마다 받는 Excel 안에 있다.
 *   첨부 링크를 10분마다 확인하면 하루 55,728회 HEAD 를 보내야 하고, 그러면
 *   quota 런(10분 주기, cancel-in-progress)이 시간에 쫓겨 취소될 위험도 생긴다.
 *   값도 이쪽이 더 구체적이다: 차수명 · 게시일 · 접수시작 · 접수마감.
 */

const KEYS = ['관리번호', '시도', '지역구분', '공고종류', '공고명', '게시일', '접수시작', '접수마감'];

const norm = (s) => (s || '').replace(/\s/g, '');

/**
 * @param {Record<string,string[][]>} sheets readSheets() 결과
 * @returns {{available:boolean, timestamp:string, count:number, missing:string[], items:object}}
 */
function parseNoticeSchedule(sheets) {
  const timestamp = new Date().toISOString();
  const s = sheets && sheets['공고별_일정'];
  if (!Array.isArray(s) || s.length < 2) {
    return { available: false, timestamp, count: 0, missing: ["'공고별_일정' 시트가 없거나 비어 있음"], items: {} };
  }
  const h = s[0];
  const at = (n) => h.findIndex((x) => norm(x) === norm(n));
  const idx = {};
  const missing = [];
  for (const k of KEYS) {
    const i = at(k);
    if (i < 0) missing.push(`'${k}' 열 없음`);
    else idx[k] = i;
  }
  // 관리번호·공고종류가 없으면 항목을 식별할 수 없다 — 그때만 포기한다.
  if (idx['관리번호'] === undefined || idx['공고종류'] === undefined) {
    return { available: false, timestamp, count: 0, missing, items: {} };
  }

  const items = {};
  for (const r of s.slice(1)) {
    const id = String(r[idx['관리번호']] || '');
    const code = id.split('-')[1];
    const kind = String(r[idx['공고종류']] || '').trim();
    if (!code || !kind) continue;
    items[`${code}|${kind}`] = {
      code, kind,
      sido: idx['시도'] !== undefined ? String(r[idx['시도']] || '').trim() : '',
      region: idx['지역구분'] !== undefined ? String(r[idx['지역구분']] || '').trim() : '',
      name: idx['공고명'] !== undefined ? String(r[idx['공고명']] || '').trim() : '',
      posted: idx['게시일'] !== undefined ? String(r[idx['게시일']] || '').trim() : '',
      start: idx['접수시작'] !== undefined ? String(r[idx['접수시작']] || '').trim() : '',
      end: idx['접수마감'] !== undefined ? String(r[idx['접수마감']] || '').trim() : '',
    };
  }
  return { available: true, timestamp, count: Object.keys(items).length, missing, items };
}

/** 사람이 읽는 항목 이름. */
const label = (v) => `${v.region || v.sido || v.code} ${v.kind}`;

/**
 * 이전과 비교해 **알릴 가치가 있는 변화**만 뽑는다.
 * @returns {{added:[], changed:[], removed:[], total:number}}
 */
function diffSchedule(prev, next) {
  const out = { added: [], changed: [], removed: [], total: 0 };
  if (!prev || !prev.items || !next || !next.items) return out;
  const P = prev.items, N = next.items;

  for (const [k, v] of Object.entries(N)) {
    const o = P[k];
    if (!o) { out.added.push({ key: k, ...v }); continue; }
    const fields = ['posted', 'start', 'end', 'name'].filter((f) => String(o[f] ?? '') !== String(v[f] ?? ''));
    if (fields.length) out.changed.push({ key: k, ...v, fields, before: Object.fromEntries(fields.map((f) => [f, o[f]])) });
  }
  // ★사라진 것도 알린다 — 공고가 내려갔다는 것도 신호다(마감·정정 등).
  for (const k of Object.keys(P)) if (!N[k]) out.removed.push({ key: k, ...P[k] });

  out.total = out.added.length + out.changed.length + out.removed.length;
  return out;
}

/** 카톡 한 통에 들어갈 문장. 길어지면 잘라 쓴다. */
function formatAlert(diff, max = 12) {
  const lines = [];
  if (diff.added.length) {
    lines.push(`🆕 새 공고 ${diff.added.length}건`);
    for (const a of diff.added.slice(0, max)) {
      lines.push(`· ${label(a)}${a.start ? ` — 접수 ${a.start}` : ''}${a.end ? ` ~ ${a.end}` : ''}`);
    }
    if (diff.added.length > max) lines.push(`  …외 ${diff.added.length - max}건`);
  }
  if (diff.changed.length) {
    const FN = { posted: '게시일', start: '접수시작', end: '접수마감', name: '공고명' };
    lines.push(`${lines.length ? '\n' : ''}🔄 일정 변경 ${diff.changed.length}건`);
    for (const c of diff.changed.slice(0, max)) {
      const bits = c.fields.map((f) => `${FN[f] || f} ${c.before[f] || '(없음)'} → ${c[f] || '(없음)'}`);
      lines.push(`· ${label(c)} — ${bits.join(', ')}`);
    }
    if (diff.changed.length > max) lines.push(`  …외 ${diff.changed.length - max}건`);
  }
  if (diff.removed.length) {
    lines.push(`${lines.length ? '\n' : ''}🗑 내려간 공고 ${diff.removed.length}건`);
    for (const r of diff.removed.slice(0, max)) lines.push(`· ${label(r)}`);
  }
  return lines.join('\n');
}

module.exports = { parseNoticeSchedule, diffSchedule, formatAlert, label };
