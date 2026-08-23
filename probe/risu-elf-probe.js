//@name risu-elf-probe
//@display-name Risu Elf 능력 프로브
//@api 3.0
//@version 0.2.0
//@arg backend_url string 프로브 백엔드 URL (기본: http://127.0.0.1:6020)
//@arg backend_token string 프로브 백엔드 토큰 (probe_server.py 콘솔에 출력됨)

// ============================================================================
// Risu Elf Phase 0 — 호스트 능력 실측
//
// 이 플러그인은 버리는 코드다. 계획서가 소스 독해로 세운 주장들을 실제 RisuAI에서
// 확인하는 것이 유일한 목적이다. 확인 대상은 계획서 §1의 제약 표와 §9 Phase 0 목록.
//
// 짝이 되는 백엔드: probe/probe_server.py (표준 라이브러리만 씀)
//     python probe_server.py --port 6020
// ============================================================================

(async () => {
  'use strict';

  const PROBE_VERSION = "0.2.0";
  const DEFAULT_URL = 'http://127.0.0.1:6020';

  // ---------------------------------------------------------------- 설정

  async function arg(name) {
    try {
      const v = await Risuai.getArgument(name);
      return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
    } catch { return ''; }
  }

  async function readConfig() {
    const url = (await arg('backend_url')) || DEFAULT_URL;
    const token = await arg('backend_token');
    return { url: url.replace(/\/+$/, ''), token };
  }

  // ---------------------------------------------------------------- 결과 모델

  // 각 검사는 {id, title, why} 로 선언하고 결과는 여기 쌓인다.
  // verdict: 'pass' | 'fail' | 'warn' | 'skip'
  const results = new Map();

  function record(id, verdict, summary, detail) {
    results.set(id, { verdict, summary, detail: detail == null ? '' : String(detail) });
    renderRow(id);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function short(obj, n) {
    let s;
    try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); }
    catch { s = String(obj); }
    if (s == null) s = '';
    return s.length > (n || 400) ? s.slice(0, n || 400) + ' …' : s;
  }

  // ---------------------------------------------------------------- 전송

  // 플러그인 iframe은 CSP connect-src 'none' 이라 fetch 가 막힌다는 것이 계획의 전제다.
  // 그 전제 자체도 아래 T-02 에서 검사하고, 나머지 통신은 전부 nativeFetch 로 한다.
  async function nfetch(url, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    // fetchNative 는 POST/PUT 에 body 가 없으면 던진다.
    if ((o.method === 'POST' || o.method === 'PUT') && o.body === undefined) o.body = '';
    return await Risuai.nativeFetch(url, o);
  }

  function authHeaders(token) {
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  // 본문은 딱 한 번만 읽는다. res.json() 을 먼저 시도하고 실패 시 res.text() 로
  // 폴백하면, json() 이 이미 본문을 소비한 뒤라 "Body has already been read" 라는
  // 진짜 원인과 무관한 오류가 나온다 (1MB 응답에서 실제로 겪음).
  async function readJson(res) {
    if (!res || typeof res.text !== 'function') return null;
    let t;
    try { t = await res.text(); }
    catch (e) { return { _err: e && e.message }; }
    try { return JSON.parse(t); }
    catch { return { _raw: String(t).slice(0, 500) }; }
  }

  // ================================================================== 검사들

  // ---- T-01 런타임 정보 ------------------------------------------------
  async function tRuntime() {
    try {
      const info = await Risuai.getRuntimeInfo();
      const platform = info && info.platform;
      // node = PocketRisu/Risuai-NodeOnly, tauri = 데스크톱 앱, web = 브라우저 mainline
      record('runtime', 'pass',
        `platform=${platform} · saveMethod=${info && info.saveMethod} · api=${info && info.apiVersion}`,
        short(info));
      return info;
    } catch (e) {
      record('runtime', 'fail', 'getRuntimeInfo 실패', e && e.message);
      return null;
    }
  }

  // ---- T-02 iframe 안에서 직접 fetch 가 막히는가 ------------------------
  async function tDirectFetch(cfg) {
    // 계획 §1 제약 #3: connect-src 'none' 이면 여기서 반드시 막혀야 한다.
    // 만약 통과한다면 CSP 가 실제로는 안 물고 있다는 뜻이고, 그러면 설계 선택지가 넓어진다.
    if (typeof fetch !== 'function') {
      record('directfetch', 'pass', 'fetch 가 아예 정의돼 있지 않음 (차단)', '');
      return;
    }
    try {
      const res = await fetch(cfg.url + '/health', { method: 'GET' });
      const body = await res.text();
      record('directfetch', 'warn',
        `직접 fetch 가 통과했다 (HTTP ${res.status}) — CSP connect-src 가 물지 않는다`,
        short(body, 200));
    } catch (e) {
      record('directfetch', 'pass', '직접 fetch 차단됨 (예상대로)', e && e.message);
    }
  }

  // ---- T-03 eval / new Function -----------------------------------------
  async function tEval() {
    let evalOk = false, fnOk = false, detail = [];
    try { evalOk = eval('1+1') === 2; } catch (e) { detail.push('eval: ' + (e && e.message)); }
    try { fnOk = new Function('return 1+1')() === 2; } catch (e) { detail.push('Function: ' + (e && e.message)); }
    if (evalOk && fnOk) {
      record('eval', 'warn', 'eval / new Function 둘 다 동작 — CSP script-src 가 물지 않는다', '');
    } else if (!evalOk && !fnOk) {
      record('eval', 'pass', 'eval / new Function 둘 다 차단 (번들에 eval 쓰면 안 됨)', detail.join(' | '));
    } else {
      record('eval', 'warn', `eval=${evalOk} newFunction=${fnOk} (엇갈림)`, detail.join(' | '));
    }
  }

  // ---- T-04 data: URI 이미지가 뜨는가 -----------------------------------
  async function tDataImage() {
    // 계획 §1 제약 #4: mainline 은 img-src 가 없어 default-src 'none' 에 걸리고,
    // PocketRisu 는 img-src * data: blob: 를 허용한다. UI 설계를 가르는 분기점.
    const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    const ok = await new Promise((resolve) => {
      const img = new Image();
      const done = (v) => resolve(v);
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = px;
      setTimeout(() => done(false), 2500);
    });
    if (ok) record('dataimg', 'pass', 'data: URI 이미지 렌더됨 (img-src 허용)', '');
    else record('dataimg', 'warn', 'data: URI 이미지 차단됨 — UI 를 이미지 없이 설계해야 함', '');
  }

  // ---- T-05 백엔드 도달: 무토큰 /health 프로브 ---------------------------
  async function tHealth(cfg, route) {
    // 계획 §7.1 의 핵심 장치. 토큰을 붙이기 *전에* 시그니처로 직접 연결을 확인한다.
    const label = route ? 'local_network' : 'auto';
    const id = route ? 'health_local' : 'health_auto';
    try {
      const opts = { method: 'GET' };
      if (route) opts.networkRoute = 'local_network';
      const res = await nfetch(cfg.url + '/health', opts);
      const data = await readJson(res);
      const signed = data && data.service === 'risu-elf-probe';
      if (!signed) {
        record(id, 'fail', `[${label}] 응답이 왔지만 우리 시그니처가 아님 — 릴레이에 가로채였을 수 있음`, short(data));
        return null;
      }
      const relay = (data.relay_markers || []).join(',') || 'none';
      record(id, 'pass',
        `[${label}] 도달 · client_ip=${data.client_ip} loopback=${data.loopback} relay=${relay} auth=${data.saw_authorization}`,
        short(data));
      return data;
    } catch (e) {
      record(id, route ? 'fail' : 'warn', `[${label}] 도달 실패`, e && e.message);
      return null;
    }
  }

  // ---- T-06 토큰 게이트 --------------------------------------------------
  async function tToken(cfg) {
    // 토큰이 설정돼 있지 않아도 거부 경로는 검사할 수 있다. v0.1.0 은 통째로 건너뛰어
    // 게이트가 서는지조차 못 봤다 — 절반이라도 재는 편이 낫다.
    let noTok = null, withTok = null;
    try {
      const r = await nfetch(cfg.url + '/token-check', { method: 'GET', networkRoute: 'local_network' });
      noTok = r.status;
    } catch (e) { noTok = 'err:' + (e && e.message); }

    if (!cfg.token) {
      if (noTok === 401) {
        record('token', 'warn',
          '무토큰 401 확인 (거부 경로 정상). 유토큰 경로는 backend_token 을 채워야 검사됨', '');
      } else {
        record('token', 'fail', `무토큰 요청이 ${noTok} — 401 이어야 함`, '');
      }
      return;
    }

    try {
      const r = await nfetch(cfg.url + '/token-check', {
        method: 'GET', networkRoute: 'local_network', headers: authHeaders(cfg.token),
      });
      withTok = r.status;
    } catch (e) { withTok = 'err:' + (e && e.message); }

    if (noTok === 401 && withTok === 200) {
      record('token', 'pass', '무토큰 401 / 유토큰 200 — 게이트 정상', '');
    } else {
      record('token', 'fail', `무토큰=${noTok} 유토큰=${withTok} (기대: 401 / 200)`, '');
    }
  }

  // ---- T-07 스트리밍이 실제로 흐르는가 -----------------------------------
  //
  // v0.1.0 은 local_network+GET+ndjson 한 가지만 재고 "버퍼링됨"만 알아냈다.
  // 그것만으로는 어느 계층이 범인인지 모른다. 그래서 두 가지를 바꿨다.
  //
  //  ① nativeFetch 가 *언제 resolve 되는지*를 따로 잰다. 이게 결정적 판별식이다.
  //       headers_ms ≈ 전체 소요  → 본문이 다 모일 때까지 기다렸다 = 브리지 위쪽(프록시/서버)에서 버퍼
  //       headers_ms ≈ 0, 청크는 한꺼번에 → 헤더는 빨리 왔는데 본문이 뭉쳤다 = 브리지 쪽
  //  ② 경로를 네 가지로 쪼갠다. PocketRisu 는 interceptor==='openai_streaming' + POST 일 때만
  //     WS proxy-job 경로를 타고(globalApi.svelte.ts:2080-2097), 나머지는 /proxy2 로 간다.
  //     content-type 도 가른다 — 압축 필터가 text/event-stream 을 명시적으로 면제한다
  //     (server.cjs:731-742).
  async function streamOnce(cfg, opts) {
    const n = 6, ms = 250;
    const qs = `n=${n}&ms=${ms}&ct=${opts.ct || 'ndjson'}`;
    const req = {
      method: opts.method || 'GET',
      headers: authHeaders(cfg.token),
    };
    if (opts.route) req.networkRoute = 'local_network';
    if (opts.interceptor) req.interceptor = opts.interceptor;
    if (req.method === 'POST') req.body = '{}';

    const t0 = Date.now();
    const res = await nfetch(`${cfg.url}/stream?${qs}`, req);
    const headersMs = Date.now() - t0;

    if (!res || !res.body || typeof res.body.getReader !== 'function') {
      return { error: 'res.body.getReader 없음 (body=' + (res && typeof res.body) + ')', headersMs };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const arrivals = [];
    let buf = '', count = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        count++;
        arrivals.push(Date.now() - t0);
      }
    }
    const totalMs = Date.now() - t0;
    const expected = (n - 1) * ms;
    const span = arrivals.length ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
    let ctype = '';
    try { ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || ''; } catch { /* ignore */ }
    return { n, count, span, expected, headersMs, totalMs, arrivals, ctype };
  }

  async function tStreamVariant(cfg, id, label, opts) {
    try {
      const r = await streamOnce(cfg, opts);
      if (r.error) { record(id, 'fail', `[${label}] ${r.error}`, ''); return; }
      const detail =
        `headers_ms=${r.headersMs} total_ms=${r.totalMs} 서버지연=${r.expected}ms ` +
        `content-type=${r.ctype}\n도착시각(ms): ${r.arrivals.join(', ')}`;
      if (r.count !== r.n) {
        record(id, 'fail', `[${label}] ${r.count}/${r.n} 줄만 도착`, detail);
      } else if (r.span > r.expected * 0.5) {
        record(id, 'pass', `[${label}] 점진 도착 · 첫→끝 ${r.span}ms`, detail);
      } else if (r.headersMs > r.expected * 0.5) {
        // 헤더 자체가 늦게 왔다 = 본문이 다 모일 때까지 기다린 것 = 브리지 위쪽이 범인.
        record(id, 'warn',
          `[${label}] 버퍼링 — 헤더가 ${r.headersMs}ms 뒤에 옴 (프록시/서버 계층에서 뭉침)`, detail);
      } else {
        record(id, 'warn',
          `[${label}] 버퍼링 — 헤더는 ${r.headersMs}ms 에 왔는데 본문이 한꺼번에 (브리지 계층에서 뭉침)`, detail);
      }
    } catch (e) {
      record(id, 'fail', `[${label}] 요청 실패`, e && e.message);
    }
  }

  async function tStream(cfg) {
    await tStreamVariant(cfg, 'stream_local', 'local_network·GET·ndjson', { route: true });
    await tStreamVariant(cfg, 'stream_auto', 'auto·GET·ndjson', { route: false });
    await tStreamVariant(cfg, 'stream_sse', 'local_network·GET·sse', { route: true, ct: 'sse' });
    await tStreamVariant(cfg, 'stream_ws', 'local_network·POST·openai_streaming', {
      route: true, method: 'POST', interceptor: 'openai_streaming',
    });
  }

  // ---- T-08 큰 페이로드 왕복 ---------------------------------------------
  async function tBigPayload(cfg) {
    // 챗 하나가 수 MB 다. RPC 브리지와 /proxy2 가 그걸 견디는지 양방향으로 본다.
    const upKb = 512;
    const payload = JSON.stringify({ pad: 'y'.repeat(upKb * 1024) });
    let upOk = '', downOk = '';
    try {
      const res = await nfetch(cfg.url + '/echo', {
        method: 'POST', networkRoute: 'local_network',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg.token)),
        body: payload,
      });
      const data = await readJson(res);
      upOk = (data && data.body_len >= upKb * 1024) ? `업로드 ${upKb}KB OK` : `업로드 이상 (수신 ${data && data.body_len}B)`;
    } catch (e) { upOk = '업로드 실패: ' + (e && e.message); }

    try {
      const res = await nfetch(cfg.url + '/big?kb=1024', {
        method: 'GET', networkRoute: 'local_network', headers: authHeaders(cfg.token),
      });
      const data = await readJson(res);
      downOk = (data && data.data && data.data.length >= 1024 * 1024) ? '다운로드 1MB OK' : '다운로드 이상';
    } catch (e) { downOk = '다운로드 실패: ' + (e && e.message); }

    const ok = upOk.indexOf('OK') >= 0 && downOk.indexOf('OK') >= 0;
    record('bigpayload', ok ? 'pass' : 'fail', `${upOk} · ${downOk}`, '');
  }

  // ---- T-09 Blob 다운로드 ------------------------------------------------
  async function tDownload() {
    // sandbox 에 allow-downloads 가 있으므로 되어야 한다 (계획 §1 제약 #2).
    // 자동 판정이 불가능한 검사다 — 파일이 실제로 받아졌는지는 사람만 안다.
    try {
      const blob = new Blob(['risu-elf probe download test\n한글 인코딩 확인\n'], {
        type: 'text/plain;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'risu-elf-probe.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      record('download', 'warn', '다운로드를 시도했다 — 브라우저에 risu-elf-probe.txt 가 받아졌는지 눈으로 확인할 것', '');
    } catch (e) {
      record('download', 'fail', 'Blob 다운로드 실패', e && e.message);
    }
  }

  // ---- T-10 pluginStorage ------------------------------------------------
  async function tStorage() {
    const key = 'risuelf_probe_' + Date.now();
    const val = { n: 1, s: '한글', arr: [1, 2, 3] };
    try {
      await Risuai.pluginStorage.setItem(key, val);
      const got = await Risuai.pluginStorage.getItem(key);
      const same = got && got.n === 1 && got.s === '한글' && Array.isArray(got.arr) && got.arr.length === 3;
      await Risuai.pluginStorage.removeItem(key);
      record('storage', same ? 'pass' : 'fail',
        same ? '구조화 값이 그대로 왕복 (JSON 직렬화 불필요)' : '왕복 값이 다름',
        short(got));
    } catch (e) {
      record('storage', 'fail', 'pluginStorage 실패', e && e.message);
    }
  }

  // ---- 챗 슬롯 확보 (T-11~T-14 공통) --------------------------------------
  //
  // v0.1.0 은 여기서 "Cannot read properties of undefined (reading 'chatPage')" 를
  // 그대로 FAIL 로 보고했는데, 그건 버그가 아니라 **캐릭터가 선택돼 있지 않은 상태**다.
  // getCurrentChatIndex() 는 db.characters[selectedCharID].chatPage 를 읽으므로
  // 선택이 없으면 null 을 주는 게 아니라 **던진다**. 실전 플러그인도 이걸 감싸야 한다.
  async function chatSlot() {
    let ci = null;
    try { ci = await Risuai.getCurrentCharacterIndex(); }
    catch (e) { return { err: 'noselect', msg: e && e.message }; }
    if (ci == null || ci < 0) return { err: 'noselect', msg: `characterIndex=${ci}` };
    try {
      const chi = await Risuai.getCurrentChatIndex();
      if (chi == null || chi < 0) return { err: 'noselect', msg: `chatIndex=${chi}` };
      return { ci, chi };
    } catch (e) {
      return { err: 'noselect', msg: e && e.message };
    }
  }

  const NO_SELECT = 'RisuAI에서 봇을 열어 챗 화면에 들어간 뒤 다시 실행할 것 ' +
    '(캐릭터 미선택 시 getCurrentChatIndex 가 chatPage 를 읽다 던진다)';

  // ---- T-11 챗 읽기 ------------------------------------------------------
  let lastChatCtx = null;

  async function tReadChat() {
    try {
      const slot = await chatSlot();
      if (slot.err) {
        record('readchat', 'skip', '캐릭터가 선택돼 있지 않음 — ' + NO_SELECT, slot.msg);
        return;
      }
      const { ci, chi } = slot;
      const chat = await Risuai.getChatFromIndex(ci, chi);
      if (!chat || !Array.isArray(chat.message)) {
        record('readchat', 'fail', 'chat.message 배열이 없음', short(chat, 200));
        return;
      }
      lastChatCtx = { ci, chi, chatId: chat.id, len: chat.message.length };
      const withMemo = chat.message.filter((m) => m && m.chatId).length;
      const keys = Object.keys(chat).join(', ');
      // 계획 §1 제약 #9: chatId 가 하이파 chatMemos 의 키다. 얼마나 채워져 있는지가 중요.
      const hypa = chat.hypaV3Data ? 'hypaV3' : (chat.hypaV2Data ? 'hypaV2' : (chat.supaMemoryData ? 'supaMemory' : '없음'));
      record('readchat', 'pass',
        `char=${ci} chat=${chi} · 턴 ${chat.message.length}개 · chatId 보유 ${withMemo}/${chat.message.length} · 메모리=${hypa}`,
        'Chat 키: ' + keys);
    } catch (e) {
      record('readchat', 'fail', 'getChatFromIndex 실패', e && e.message);
    }
  }

  // ---- T-12 챗 쓰기 (비파괴) ---------------------------------------------
  async function tWriteChatNonDestructive() {
    // 메시지를 건드리지 않고 커스텀 속성만 심었다 지운다.
    // LIA_Persona_Linker 가 bindedPersona 로 하는 것과 같은 경로이며,
    // 계획 §5.3 의 쓰기 경로를 사용자 데이터 손상 없이 검증한다.
    try {
      const slot = await chatSlot();
      if (slot.err) {
        record('writechat', 'skip', '캐릭터가 선택돼 있지 않음 — ' + NO_SELECT, slot.msg);
        return;
      }
      const { ci, chi } = slot;
      const before = await Risuai.getChatFromIndex(ci, chi);
      if (!before) { record('writechat', 'fail', '챗을 못 읽어 쓰기 검사 불가', ''); return; }

      const marker = 'probe-' + Date.now();
      const stamped = Object.assign({}, before, { realOocProbe: marker });
      await Risuai.setChatToIndex(ci, chi, stamped);

      const after = await Risuai.getChatFromIndex(ci, chi);
      const persisted = after && after.realOocProbe === marker;
      const msgsIntact = after && Array.isArray(after.message) &&
        after.message.length === before.message.length;

      // 흔적을 지운다. 남겨두면 사용자 저장 파일이 오염된다.
      const cleaned = Object.assign({}, after || stamped);
      delete cleaned.realOocProbe;
      await Risuai.setChatToIndex(ci, chi, cleaned);
      const final = await Risuai.getChatFromIndex(ci, chi);
      const cleanedOk = final && final.realOocProbe === undefined;

      if (persisted && msgsIntact && cleanedOk) {
        record('writechat', 'pass',
          '커스텀 속성 쓰기→재읽기→삭제 왕복 성공 · 메시지 무손상 · 흔적 제거됨', '');
      } else {
        record('writechat', 'fail',
          `persisted=${persisted} msgsIntact=${msgsIntact} cleaned=${cleanedOk}`, '');
      }
    } catch (e) {
      record('writechat', 'fail', 'setChatToIndex 실패', e && e.message);
    }
  }

  // ---- T-13 setChatToIndex 가 존재하지 않는 인덱스에 쓰는가 ---------------
  async function tAppendGuard() {
    // 계획 §1 제약 #7 의 확인. 없는 인덱스에 쓰면 조용히 무시되어야 한다
    // (그래서 챗 추가는 setCharacterToIndex 로 가야 한다).
    try {
      const slot = await chatSlot();
      if (slot.err) {
        record('appendguard', 'skip', '캐릭터가 선택돼 있지 않음 — ' + NO_SELECT, slot.msg);
        return;
      }
      const ci = slot.ci;
      const char = await Risuai.getCharacterFromIndex(ci);
      if (!char || !Array.isArray(char.chats)) {
        record('appendguard', 'fail', '캐릭터/chats 를 못 읽음', '');
        return;
      }
      const beyond = char.chats.length; // 존재하지 않는 인덱스
      await Risuai.setChatToIndex(ci, beyond, { message: [], note: '', name: 'probe-should-not-exist', localLore: [] });
      const after = await Risuai.getCharacterFromIndex(ci);
      const grew = after && after.chats.length !== char.chats.length;
      if (!grew) {
        record('appendguard', 'pass',
          `없는 인덱스(${beyond})에 쓰기는 무시됨 — 챗 추가는 setCharacterToIndex 로 가야 함 (계획대로)`, '');
      } else {
        record('appendguard', 'warn',
          `없는 인덱스에 썼더니 챗이 늘었다 (${char.chats.length} → ${after.chats.length}) — 계획 §1 #7 정정 필요`,
          '늘어난 챗을 RisuAI 에서 지울 것');
      }
    } catch (e) {
      // throw 도 정상 동작이다 — 어느 쪽이든 "추가는 안 된다"가 확인된다.
      record('appendguard', 'pass', '없는 인덱스 쓰기가 예외로 거부됨', e && e.message);
    }
  }

  // ---- T-14 캐릭터 읽기 (챗 목록·카드 원본) --------------------------------
  async function tReadCharacter() {
    try {
      const slot = await chatSlot();
      if (slot.err) {
        record('readchar', 'skip', '캐릭터가 선택돼 있지 않음 — ' + NO_SELECT, slot.msg);
        return;
      }
      const ci = slot.ci;
      const t0 = Date.now();
      const char = await Risuai.getCharacterFromIndex(ci);
      const dt = Date.now() - t0;
      if (!char) { record('readchar', 'fail', 'getCharacterFromIndex 가 null', ''); return; }
      const chats = Array.isArray(char.chats) ? char.chats.length : 0;
      const totalTurns = (char.chats || []).reduce((a, c) => a + ((c && c.message) ? c.message.length : 0), 0);
      const lore = Array.isArray(char.globalLore) ? char.globalLore.length : 0;
      const greetings = Array.isArray(char.alternateGreetings) ? char.alternateGreetings.length : 0;
      // 이 호출이 얼마나 무거운지가 UI 설계(챗 선택 탭)를 좌우한다.
      record('readchar', 'pass',
        `${char.name} · 챗 ${chats}개 / 총 ${totalTurns}턴 · 로어 ${lore} · 인사말 ${greetings + 1} · ${dt}ms`,
        `type=${char.type} chaId=${char.chaId} desc=${(char.desc || '').length}자 firstMessage=${(char.firstMessage || '').length}자`);
    } catch (e) {
      record('readchar', 'fail', 'getCharacterFromIndex 실패', e && e.message);
    }
  }

  // ================================================================== UI

  const TESTS = [
    ['runtime', 'T-01 런타임 정보', 'platform 이 node(PocketRisu)/web/tauri 중 무엇인지 — 라우팅 분기의 기준'],
    ['directfetch', 'T-02 직접 fetch 차단', 'CSP connect-src 가 실제로 무는지 (계획 §1 #3)'],
    ['eval', 'T-03 eval / new Function', '번들러가 eval 을 쓰면 안 되는지'],
    ['dataimg', 'T-04 data: URI 이미지', 'UI 를 이미지 없이 짜야 하는지 (계획 §1 #4)'],
    ['health_auto', 'T-05a /health (auto 라우트)', 'networkRoute 없이도 닿는가'],
    ['health_local', 'T-05b /health (local_network)', 'PocketRisu /proxy2 릴레이 경로 (계획 §1 #6)'],
    ['token', 'T-06 토큰 게이트', '무토큰 401 / 유토큰 200 (계획 §7.1)'],
    ['stream_local', 'T-07a 스트리밍 local_network', '/proxy2 릴레이 경로 — v0.1.0 에서 버퍼링으로 나온 조합'],
    ['stream_auto', 'T-07b 스트리밍 auto', 'networkRoute 없이 — 릴레이가 범인인지 가른다'],
    ['stream_sse', 'T-07c 스트리밍 SSE', 'text/event-stream 은 압축 필터가 면제한다 (server.cjs:731)'],
    ['stream_ws', 'T-07d 스트리밍 WS proxy-job', 'POST + interceptor:openai_streaming 일 때만 타는 경로'],
    ['bigpayload', 'T-08 큰 페이로드', '수백 KB~MB 가 브리지와 프록시를 통과하는가'],
    ['download', 'T-09 Blob 다운로드', '내보내기 경로 (계획 §1 #2) — 눈으로 확인'],
    ['storage', 'T-10 pluginStorage', '설정 보관소 왕복'],
    ['readchat', 'T-11 챗 읽기', 'message[] · chatId 보유율 · 하이파 유무 (계획 §1 #9)'],
    ['writechat', 'T-12 챗 쓰기 (비파괴)', 'setChatToIndex 왕복 — 메시지는 안 건드림 (계획 §5.3)'],
    ['appendguard', 'T-13 없는 인덱스 쓰기', '챗 추가가 정말 막히는가 (계획 §1 #7)'],
    ['readchar', 'T-14 캐릭터 읽기', '챗 목록·카드 원본과 그 비용 (챗 선택 탭 설계 근거)'],
  ];

  const BADGE = {
    pass: ['#10b981', 'PASS'],
    fail: ['#ef4444', 'FAIL'],
    warn: ['#f59e0b', 'WARN'],
    skip: ['#6b7280', 'SKIP'],
    none: ['#374151', '···'],
  };

  function renderRow(id) {
    const el = document.getElementById('row-' + id);
    if (!el) return;
    const r = results.get(id);
    const [color, label] = BADGE[(r && r.verdict) || 'none'];
    el.querySelector('.badge').style.background = color;
    el.querySelector('.badge').textContent = label;
    el.querySelector('.summary').textContent = (r && r.summary) || '';
    const d = el.querySelector('.detail');
    if (r && r.detail) { d.textContent = r.detail; d.style.display = 'block'; }
    else { d.style.display = 'none'; }
  }

  function buildUI(cfg) {
    const rows = TESTS.map(([id, title, why]) => `
      <div class="row" id="row-${id}">
        <span class="badge">···</span>
        <div class="body">
          <div class="title">${esc(title)}</div>
          <div class="why">${esc(why)}</div>
          <div class="summary"></div>
          <pre class="detail"></pre>
        </div>
      </div>`).join('');

    document.body.innerHTML = `
<style>
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.6 Consolas,'Malgun Gothic',monospace;
         background:#0d0f14; color:#d6dae1; }
  .wrap { display:flex; flex-direction:column; height:100vh; }
  header { display:flex; align-items:center; gap:12px; padding:12px 16px;
           border-bottom:1px solid #232833; flex-shrink:0; flex-wrap:wrap; }
  h1 { margin:0; font-size:15px; font-weight:700; color:#e8ebf0; }
  .dim { color:#7c8595; font-weight:400; font-size:12px; }
  .spacer { flex:1; }
  button { font:inherit; padding:7px 14px; border-radius:7px; cursor:pointer;
           border:1px solid #2c3340; background:#171b23; color:#d6dae1; }
  button:hover { background:#1f2530; }
  button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
  button.primary:hover { background:#1d4fd7; }
  button:disabled { opacity:.5; cursor:default; }
  main { flex:1; overflow-y:auto; padding:12px 16px 40px; }
  .row { display:flex; gap:10px; padding:10px 0; border-bottom:1px solid #1a1f28; }
  .badge { flex-shrink:0; width:52px; height:22px; line-height:22px; text-align:center;
           border-radius:5px; font-size:11px; font-weight:700; color:#fff; background:#374151; }
  .body { flex:1; min-width:0; }
  .title { font-weight:700; color:#e8ebf0; }
  .why { color:#6b7280; font-size:12px; }
  .summary { margin-top:3px; color:#9fd0ff; word-break:break-word; }
  .detail { display:none; margin:6px 0 0; padding:8px; background:#11151c;
            border:1px solid #1e242e; border-radius:6px; color:#8b95a6;
            font-size:11px; white-space:pre-wrap; word-break:break-all;
            max-height:180px; overflow:auto; }
  .note { margin:10px 0 0; padding:10px 12px; background:#151a22;
          border-left:3px solid #f59e0b; border-radius:4px; color:#c8ced8; font-size:12px; }
</style>
<div class="wrap">
  <header>
    <h1>Risu Elf 능력 프로브 <span class="dim">v${PROBE_VERSION}</span></h1>
    <span class="dim">${esc(cfg.url)} ${cfg.token ? '· 토큰 설정됨' : '· 토큰 없음'}</span>
    <span class="spacer"></span>
    <button class="primary" id="run">전체 실행</button>
    <button id="copy">결과 복사</button>
    <button id="close">닫기</button>
  </header>
  <main>
    ${rows}
    <div class="note">
      T-12 는 메시지를 건드리지 않는다 — 챗 객체에 표식을 심었다가 즉시 지운다.
      T-09 다운로드는 자동 판정이 불가능하니 파일이 실제로 받아졌는지 눈으로 확인할 것.
      백엔드 검사(T-05~T-08)는 test-server 에서 <code>python probe_server.py --port 6020</code> 가
      떠 있어야 한다.
    </div>
  </main>
</div>`;

    document.getElementById('close').addEventListener('click', async () => {
      try { await Risuai.hideContainer(); } catch { /* ignore */ }
    });
    document.getElementById('copy').addEventListener('click', () => {
      const text = report(cfg);
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      const b = document.getElementById('copy');
      b.textContent = '복사됨';
      setTimeout(() => { b.textContent = '결과 복사'; }, 1500);
    });
    document.getElementById('run').addEventListener('click', runAll);
    TESTS.forEach(([id]) => renderRow(id));
  }

  function report(cfg) {
    const lines = [
      `Risu Elf 프로브 v${PROBE_VERSION}`,
      `backend: ${cfg.url}`,
      `시각: ${new Date().toISOString()}`,
      '',
    ];
    for (const [id, title] of TESTS) {
      const r = results.get(id);
      const v = r ? r.verdict.toUpperCase() : '----';
      lines.push(`[${v}] ${title}`);
      if (r && r.summary) lines.push('       ' + r.summary);
      if (r && r.detail) lines.push('       · ' + r.detail.replace(/\n/g, '\n       · '));
    }
    return lines.join('\n');
  }

  let running = false;
  async function runAll() {
    if (running) return;
    running = true;
    const btn = document.getElementById('run');
    if (btn) { btn.disabled = true; btn.textContent = '실행 중…'; }
    results.clear();
    TESTS.forEach(([id]) => renderRow(id));

    const cfg = await readConfig();
    try {
      await tRuntime();
      await tDirectFetch(cfg);
      await tEval();
      await tDataImage();
      await tHealth(cfg, false);
      const ok = await tHealth(cfg, true);
      if (ok) {
        await tToken(cfg);
        await tStream(cfg);
        await tBigPayload(cfg);
      } else {
        for (const id of ['token', 'stream_local', 'stream_auto', 'stream_sse', 'stream_ws', 'bigpayload']) {
          record(id, 'skip', '백엔드 미도달 — 건너뜀', '');
        }
      }
      await tDownload();
      await tStorage();
      await tReadChat();
      await tWriteChatNonDestructive();
      await tAppendGuard();
      await tReadCharacter();
    } catch (e) {
      console.log('[risu-elf-probe] 실행 중 예외: ' + (e && e.message));
    }
    if (btn) { btn.disabled = false; btn.textContent = '다시 실행'; }
    running = false;
  }

  async function open() {
    const cfg = await readConfig();
    buildUI(cfg);
    await Risuai.showContainer('fullscreen');
    runAll();
  }

  // ---------------------------------------------------------------- 등록

  const ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>';

  const parts = [];
  try {
    parts.push(await Risuai.registerSetting('Risu Elf 프로브', open, ICON, 'html'));
  } catch (e) { console.log('[risu-elf-probe] registerSetting 실패: ' + (e && e.message)); }
  try {
    parts.push(await Risuai.registerButton(
      { name: 'Risu Elf 프로브', icon: ICON, iconType: 'html', location: 'hamburger' }, open));
  } catch (e) { console.log('[risu-elf-probe] registerButton 실패: ' + (e && e.message)); }

  try {
    await Risuai.onUnload(async () => {
      for (const p of parts) {
        if (p && p.id) { try { await Risuai.unregisterUIPart(p.id); } catch { /* ignore */ } }
      }
    });
  } catch { /* ignore */ }

  console.log(`[risu-elf-probe] v${PROBE_VERSION} 로드됨 — 설정 → 플러그인 또는 햄버거 메뉴에서 열 것`);
})();
