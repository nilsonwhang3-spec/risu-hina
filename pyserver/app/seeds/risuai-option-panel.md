<!-- risuhina-preset-scope-v1 -->
RisuAI는 별도의 프롬프트 제작자가 제공하는 프롬프트 프리셋에서 로어북 삽입 순서, 서술 시점, 대필 유무를 옵션으로 지정한다. 봇카드와 로어북에는 세계관·인물·사건·상태 및 봇 고유 시스템을 작성하고, 해당 서술 옵션은 프리셋 설정을 따른다. 프리셋의 제어 옵션은 제작 지식으로만 참고하고 봇카드·로어북 본문에 별도 규칙으로 기재하지 않는다.

RisuAI 봇의 **옵션 패널(슬라이딩 드로어)** 레퍼런스. 설정 버튼(⚙)을 누르면 옆에서 밀려 나오는 패널에
에셋 출력 모드·기능 켜기/끄기 같은 옵션 버튼을 두는 UI 를 만들거나 고칠 때 읽어라.

> 아래 코드의 `bot-`/`bot_` 접두사, 태그·변수·버튼 이름은 설명용 자리표시자다. 봇마다 고유 접두사를 정해
> 일관되게 바꿔 쓴다. RisuAI 호스트 동작(버튼 처리, 재렌더, 권한)은 모든 봇에 공통이다.

---

# RisuAI 옵션 패널(슬라이딩 드로어) 작성법

## 0. 한눈에 보는 구조

```
AI 출력   <bot-panel>…</bot-panel>             ← 앵커: AI 가 매 턴 출력하는 태그(보통 상태창)
   │
   ▼  Lua listenEdit('editDisplay')            ← 팁(마지막) 메시지 1건에만
   │    build_ui_html(id) → 문자열 조립          ← 조건 분기는 Lua if, CBS 는 {{raw::}}·팁 게이트만
   │    text = text:sub(1,s-1) .. ui .. text:sub(s)   ← 앵커 "앞"에 삽입
   ▼
   <input type="checkbox" id="bot-drawer-x" style="display:none">   ← 열림/닫힘: 순수 CSS
   <input type="checkbox" id="bot-tab-x"    style="display:none">   ← 탭: 순수 CSS
   <input type="checkbox" id="bot-busy"     style="display:none">   ← 클릭 즉시 스피너
   <div class="bot-gear-bar"><label for="bot-drawer-x">⚙</label></div>
   <div class="bot-drawer"> … <label class="bot-opt-btn" for="bot-busy" risu-btn="set_asset_aux">보조모델</label> … </div>
   │
   ▼  클릭 → 호스트가 Lua onButtonClick(id, "set_asset_aux") 호출
        setChatVar(...); restore_drawer(id); return      ← reloadDisplay 호출 안 함
        호스트가 클릭된 메시지 1건만 재렌더
```

세 가지 설계 원칙:
1. **패널 HTML 은 팁 메시지 1건에만 들어간다.** 옛 메시지에는 넣지 않고, 빌드도 하지 않는다.
2. **열림/닫힘/탭 전환은 Lua 를 부르지 않는다.** hidden checkbox + `<label for>` + `:checked ~` 셀렉터로 DOM 만 바꾼다.
3. **옵션 클릭은 chatvar 만 바꾸고 끝낸다.** `reloadDisplay(id)` 는 옛 메시지까지 다시 그려야 할 때만.

변수에 저장하는 것은 옵션 값과 짧게 쓰는 열림 플래그뿐이다. 패널 HTML 자체를 변수에 캐시할 필요는 없다.
비용을 지배하는 것은 HTML 문자열 조립이 아니라 다음 두 가지다.
- (a) 모든 메시지에 거대한 CBS 덩어리를 넣으면, editdisplay 정규식이 치환할 때마다 그 덩어리가 다시 CBS 파싱된다.
- (b) `reloadDisplay()` 는 모든 메시지와 backgroundHTML CSS 전체를 다시 파싱하는 전체 GUI 리로드다.

---

## 1. 안티패턴과 패턴

| 안티패턴 | 패턴 |
|---|---|
| editdisplay 정규식 `out:` 에 드로어 HTML+CBS → 모든 메시지에서 재파싱 | Lua 가 문자열 조립, editDisplay 가 팁 1건에만 삽입, 옛 메시지는 `meta.index` 로 조기 반환 |
| 조건 분기를 `{{#when::X::vis::1}}` 수백 개로 | 분기는 Lua `if`, CBS 는 `{{raw::}}` 와 팁 게이트만 |
| 열림/닫힘을 chatvar + `reloadDisplay` 로 (열 때마다 전체 리로드) | hidden checkbox + `<label for>` + `:checked ~` (Lua 0회) |
| 옵션 클릭 후 `reloadDisplay(id)` | chatvar 만 바꾸고 return. 호스트가 클릭 메시지 1건만 재렌더 |
| 클릭 피드백 없음 (리로드 동안 멈춘 듯 보임) | `<label for="bot-busy" risu-btn>` 로 즉발 스피너 |
| 다중 선택을 CSS 체크박스 조합으로 | 선택 하나 = `risu-btn` 1클릭 = Lua 커밋 1회 |
| 진입 `@keyframes` 애니메이션 | `transition` (재렌더 때 다시 재생되지 않는다) |

CSS 체크박스 토글은 **열림/닫힘/탭 같은 단일 비트**에만 쓴다. 다중 선택 집합 같은 조합 상태를 CSS 로 풀면
구분할 상태 수만큼 확인 라벨이 필요해 초선형으로 늘고, `:checked` 가 바뀔 때마다 뒤따르는 형제 전체가 스타일
재계산되어 모바일(iOS WebKit)이 멈춘다. 조합 상태는 `risu-btn` 으로 Lua 에 커밋하고 메시지 1건 재렌더를 받아들인다.

---

## 2. 버튼 이벤트 배선

### 2.1 `risu-btn="payload"` 속성

CBS 에는 `{{button::label::trigger}}` 가 있지만 옵션 패널은 원시 HTML 속성 `risu-btn` 을 쓰는 편이 자유롭다.
RisuAI 호스트는 클릭 시 `closest('[risu-trigger],[risu-btn]')` 로 요소를 찾아 Lua `onButtonClick(id, payload)` 를 부르고,
핸들러가 끝나면 **클릭이 일어난 메시지 1건만** 재렌더한다.

- `risu-btn` 은 `<label>`, `<div>`, `<span>`, `<button>` 어디에든 붙일 수 있다(DOMPurify 허용 속성).
- 핸들러는 캡처 단계(`onclickcapture`)에서 돌고 `preventDefault` 를 하지 않는다. 그래서 `<label for>` 의 기본 동작(체크박스 토글)과 **동시에** 일어난다. §2.4 busy 스피너가 이 성질을 쓴다.
- `risu-trigger="name"` 은 별개 경로(CBS 트리거 스크립트의 manual 트리거)다. Lua `onButtonClick` 과 무관하다.
- 그룹 챗에서는 `risu-btn` 이 무시된다. CSS 체크박스 동작만 남는다.

### 2.2 `onButtonClick` 템플릿

```lua
local function restore_drawer(id)   -- 옵션 클릭 뒤 1회 재렌더 때 드로어를 열린 채(옵션 탭)로 다시 그린다
    setChatVar(id, "drawer_open", "1")
    setChatVar(id, "drawer_tab", "2")
end

local function close_panels(id)
    setChatVar(id, "drawer_open", "0")
    setChatVar(id, "drawer_tab", "1")
end

onButtonClick = async(function(id, data)
    -- 진입 시 항상 닫힘으로 시작한다. 이전 클릭이 남긴 열림 플래그가
    -- 사용자가 ✕/백드롭으로 닫은 패널을 되살리지 못하게 한다.
    close_panels(id)

    -- 팁 메시지 안의 UI 만 읽는 변수 → reloadDisplay 호출하지 않는다
    if data == "set_asset_main" then
        setChatVar(id, "asset_aux", "0"); restore_drawer(id)
    elseif data == "set_asset_aux" then
        setChatVar(id, "asset_aux", "1"); restore_drawer(id)

    -- 옛 메시지의 정규식/CBS 도 읽는 변수 → 전체 리로드가 불가피하다
    elseif data == "set_label_on" then
        setChatVar(id, "show_asset_label", "1"); restore_drawer(id); reloadDisplay(id)
    elseif data == "set_label_off" then
        setChatVar(id, "show_asset_label", "0"); restore_drawer(id); reloadDisplay(id)
    end
end)
```

재렌더 판단 규칙:
- 바뀐 chatvar 를 **팁 메시지 안의 UI 만** 읽는다 → chatvar 만 바꾸고 return 한다.
- 바뀐 chatvar 를 **옛 메시지의 정규식/CBS 도** 읽는다(예: 모든 에셋 이미지에 붙는 이름 캡션) → `reloadDisplay(id)`.
- 비동기 후속 작업(axLLM 호출 등)이 끝난 뒤에는 `close_panels(id)` + `reloadDisplay(id)`.
- `alertInput` 등 await 가 필요한 호출이 있으면 `async(function ...)` 래핑이 필수다.

### 2.3 열림 플래그의 역할과 "기본 닫힘 정책"

`drawer_open`/`drawer_tab` 같은 변수는 "열림 상태의 진실"이 아니다. 사용자가 ✕/백드롭으로 닫아도 CSS 만 움직이고
변수는 그대로다. 이 변수들은 **옵션 클릭 직후 단 1회 재렌더 때 어느 체크박스를 `checked` 로 다시 그릴지** 정하는
단명 플래그다. 그래서 다음 네 곳에서 무조건 닫힘으로 리셋한다.

1. `onButtonClick` 진입.
2. `onStart`. 세션을 다시 열 때 드로어가 열린 채 뜨는 것을 막는다.
3. `listenEdit('editInput')`. 새 생성은 항상 닫힘으로 시작한다.
4. `listenEdit('editOutput')`. 리롤 때 RisuAI 의 chatvar 롤백이 옛 스냅샷의 열림 값을 되살리고, 빈 입력 전송은 editInput 을 건너뛴다.

이 리셋을 빼면 "드로어 유령 열림"이 생긴다. 옵션 핸들러가 남긴 열림 값이, 이후 임의의 프로그램적 리로드
(비동기 보조모델 패스 등)에서 드로어를 저절로 연다.

### 2.4 busy 스피너: 클릭 즉시 피드백

옵션 버튼을 `<label for="bot-busy" risu-btn="…">` 로 만든다. 순서는 이렇다.
1. label 기본 동작으로 `#bot-busy` 가 체크되고, CSS 오버레이가 즉시 보인다.
2. 동시에 캡처 단계에서 `risu-btn` 핸들러가 돈다.
3. Lua 가 끝나면 호스트가 메시지를 재렌더한다. 새 DOM 의 체크박스는 unchecked 이므로 스피너가 사라진다.

오버레이가 두 번째 클릭을 막으므로 더블클릭 이중 토글도 막힌다.

```css
.bot-busy-ov { display:none; position:absolute; left:0; top:0; right:0; bottom:0; background:rgba(8,12,18,.62);
  z-index:60; align-items:center; justify-content:center; flex-direction:column; }
#bot-busy:checked ~ .bot-drawer .bot-busy-ov { display:flex; }
```

---

## 3. Lua 빌더와 주입

### 3.1 빌드당 메모이즈 리더

```lua
local function ui_reader(id)
    local memo = {}
    return function(name)
        local v = memo[name]
        if v == nil then
            v = getChatVar(id, name) or ""
            memo[name] = v
        end
        return v
    end
end
```
캐시 수명은 빌드 1회다. 다음 렌더에서 값이 바뀔 수 있으므로 렌더 사이에 남기지 않는다.

### 3.2 드로어 빌더 골격

```lua
local function build_drawer_html(gv)
    local b = {}
    -- 체크박스는 .bot-drawer 의 "앞선 형제" 여야 하고, 각각 한 줄에 하나씩 (§6-1 markdown 함정)
    b[#b + 1] = '<input type="checkbox" id="bot-drawer-x" style="display:none"'
        .. (gv("drawer_open") == "1" and " checked>\n" or ">\n")
    b[#b + 1] = '<input type="checkbox" id="bot-tab-x" style="display:none"'
        .. (gv("drawer_tab") == "2" and " checked>\n" or ">\n")
    b[#b + 1] = '<input type="checkbox" id="bot-busy" style="display:none">\n'
    -- 런처. 첫 메시지(인사)에서 숨길 버튼은 {{#if {{greater_equal::{{lastmessageid}}::1}}}} 로 감싼다
    b[#b + 1] = '<div class="bot-gear-bar"><label class="bot-gear-btn" for="bot-drawer-x">⚙</label></div>\n'
    -- 드로어 본체: 백드롭·닫기·탭은 전부 <label for> (risu-btn 없음 = Lua 호출 없음)
    b[#b + 1] = '<div class="bot-drawer">\n<label class="bot-drawer-backdrop" for="bot-drawer-x"></label>\n<div class="bot-drawer-panel">'
    b[#b + 1] = '<div class="bot-drawer-header"><span>봇 이름</span><label class="bot-drawer-close" for="bot-drawer-x">✕</label></div>'
        .. '<div class="bot-busy-ov"><span class="bot-busy-spin"></span><span>적용 중…</span></div>'
    b[#b + 1] = '<div class="bot-tab-bar"><label class="bot-tab bot-tab-a" for="bot-tab-x">정보</label><label class="bot-tab bot-tab-b" for="bot-tab-x">옵션</label></div>'
    b[#b + 1] = '<div class="bot-drawer-body"><div class="bot-tab-a-body">…</div>'
    -- 옵션 탭: 활성 클래스는 CBS 가 아니라 Lua 가 직접 결정한다
    local aux = gv("asset_aux") == "1"
    local function opt_btns(onA, btnA, txtA, onB, btnB, txtB)
        return '<div class="bot-opt-btns"><label class="bot-opt-btn ' .. (onA and "is-on" or "")
            .. '" for="bot-busy" risu-btn="' .. btnA .. '">' .. txtA .. '</label><label class="bot-opt-btn '
            .. (onB and "is-on" or "") .. '" for="bot-busy" risu-btn="' .. btnB .. '">' .. txtB .. '</label></div>'
    end
    b[#b + 1] = '<div class="bot-opt-body"><div class="bot-opt-group"><div class="bot-opt-label">에셋 출력</div>'
        .. opt_btns(not aux, "set_asset_main", "메인 모델", aux, "set_asset_aux", "보조모델") .. '</div></div>'
    b[#b + 1] = '</div></div></div>'   -- body, panel, drawer
    return table.concat(b)
end

local function build_ui_html(id)
    local gv = ui_reader(id)
    return "\n{{#if {{equal::{{chat_index}}::{{lastmessageid}}}}}}\n"   -- 팁 전용 게이트 (최종 권위)
        .. build_drawer_html(gv)
        .. "\n{{/if}}"
end
```

### 3.3 주입: `listenEdit('editDisplay')`, 팁 메시지에만

```lua
listenEdit('editDisplay', function(id, text, meta)
    local s = text:find("<bot-panel>", 1, true)          -- 앵커 없는 메시지(유저·시스템)는 즉시 반환
    if not s then return text end
    local idx = (type(meta) == "table") and tonumber(meta.index) or nil
    if idx ~= nil then
        local n = getChatLength(id)
        if type(n) == "number" and n >= 1 and idx >= 0 and idx < n - 1 then
            return text                                  -- 확실히 옛 메시지: 빌드조차 하지 않는다
        end
    end
    local ok, ui = pcall(build_ui_html, id)              -- 실패해도 원문은 그대로
    if not ok or type(ui) ~= "string" then return text end
    return text:sub(1, s - 1) .. ui .. text:sub(s)       -- 앵커 "앞"에 삽입
end)
```

- 세 겹 방어다. 앵커가 없으면 빌드하지 않고, `meta.index` 로 옛 메시지를 조기 반환하며, 블록 안의 CBS 팁 게이트가 최종 권위다. meta 형태가 예상과 달라도 잘못 그려지지 않고 빌드 1회를 낭비할 뿐이다.
- 앵커로는 AI 가 매 턴 출력하는 태그(상태창 등)를 쓴다. 없으면 Lua editDisplay 에서 본문 끝에 빈 앵커 태그를 덧붙이고 그것을 쓴다.
- 앵커 **앞**에 넣으면, 이후 앵커 블록을 감싸는 정규식(`<bot-panel>([\s\S]*?)</bot-panel>`)에 드로어가 삼켜지지 않는다.
- Lua editDisplay 는 정규식 스크립트보다 먼저 돌고, 그 출력은 CBS 파싱된다. 그래서 Lua 문자열 안의 `{{raw::}}`·`{{#if}}` 가 동작한다.
- editDisplay 리스너는 등록 순서대로 실행된다. 본문을 훑는 다른 리스너(CoT 이스케이프 등)를 먼저 등록해 주입 블록을 훑지 않게 한다.
- editDisplay 안에서는 `setChatVar` 와 alert 만 쓸 수 있다. `setChat`/`reloadDisplay` 는 조용히 무시되므로, 빌더는 읽기(`getChatVar`, `getChatLength`)만 한다.

### 3.4 정규식+CBS 로 만든 패널을 유지해야 할 때

Lua 를 쓰지 않는 구형 구조(정규식 `out:` 안에 `{{#when::panel_open::vis::1}}…{{/when}}` + 열고 닫을 때마다 `reloadDisplay`)는
닫힘 애니메이션이 불가능하고 모든 메시지에서 CBS 를 재파싱한다. 또 RisuAI 스크립트 캐시 키에 chatvar 값이 들어가지 않아,
변수만 바뀌면 옛 화면이 남을 수 있다. 그런 패널은 Lua editDisplay 끝에 `text .. "<!--bot:" .. getChatVar(id,"X") .. "-->"`
같은 캐시 버스터 주석을 붙인다. Lua 빌더 방식은 변수 값이 HTML 에 직접 박혀 출력 문자열이 달라지므로 필요 없다.

---

## 4. CSS (backgroundHTML 의 `<style>` 안)

### 4.1 스코핑 관례
- 모든 클래스·id 에 봇 고유 접두사를 붙여 다른 봇·테마와 충돌하지 않게 한다.
- `all: initial` 리셋은 독립된 카드 UI 에만 쓴다. 드로어에 쓰면 fixed·flex 까지 리셋된다.
- 폰트를 요소에 명시해 RisuAI 테마 폰트 상속을 피한다.
- 렌더러 호환을 위해 `aspect-ratio`, `min()/calc()`, `grid repeat(auto-fill, minmax())`, % inset absolute 를 피하고 고정 px + flex-wrap 으로 짠다.
- CSS 는 반드시 `</style>` **안**에 둔다. 밖에 붙이면 적용되지 않는 죽은 CSS 가 된다.
- 상태 규칙은 ID 대신 클래스로 쓴다. ID 는 특이도가 높아 게이트 규칙이 이기지 못한다. 특이도가 같으면 파일 뒤쪽 규칙이 이긴다.

### 4.2 드로어: 열림/닫힘 = 체크박스

```css
#bot-drawer-x, #bot-tab-x, #bot-busy { display: none; }
.bot-drawer { display: block; }
.bot-drawer-backdrop {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,.45); cursor: pointer; display: block;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity .25s ease, visibility .25s ease; z-index: 9998;
}
#bot-drawer-x:checked ~ .bot-drawer .bot-drawer-backdrop { opacity: 1; visibility: visible; pointer-events: auto; }
.bot-drawer-panel {
  position: fixed; top: 0; right: 0; width: 280px; height: 100%;
  background: #111c2b; border-left: 1px solid #2a3a4a; box-shadow: -4px 0 20px rgba(0,0,0,.4);
  display: flex; flex-direction: column; z-index: 9999;
  transform: translateX(100%); visibility: hidden;
  transition: transform .3s ease, visibility .3s ease;
}
#bot-drawer-x:checked ~ .bot-drawer .bot-drawer-panel { transform: translateX(0); visibility: visible; }
.bot-drawer-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid #2a3a4a; }
.bot-drawer-close { cursor:pointer; display:inline-block; }
.bot-drawer-body { flex:1; overflow-y:auto; }
@media (max-width: 768px) { .bot-drawer-panel { width: 100%; } }
```

닫힘 상태를 `display:none` 이 아니라 `transform + visibility + pointer-events` 로 처리해야 여닫을 때 모두 transition 이 걸린다.
`visibility` 를 transition 에 넣으면 닫힐 때 슬라이드가 끝난 뒤에 hidden 이 된다.

### 4.3 탭 전환: 체크박스 1개 = 탭 2개

```css
/* #bot-tab-x unchecked = 탭 A, checked = 탭 B. 두 탭 라벨이 같은 체크박스를 가리키고,
   활성 탭은 pointer-events:none 이라 눌러도 토글되지 않는다. */
.bot-tab-a, #bot-tab-x:checked ~ .bot-drawer .bot-tab-b { color:#c4a060; border-bottom:2px solid #c4a060; pointer-events:none; }
#bot-tab-x:checked ~ .bot-drawer .bot-tab-a { color:#5a6a7a; border-bottom:none; pointer-events:auto; }
.bot-opt-body { display:none; }
#bot-tab-x:checked ~ .bot-drawer .bot-tab-a-body { display:none; }
#bot-tab-x:checked ~ .bot-drawer .bot-opt-body { display:block; }
```
탭이 3개 이상이면 `<input type="radio" name="bot-tab" id="bot-tab-1">` 여러 개로 확장한다.

### 4.4 옵션 버튼: label 을 버튼처럼

```css
.bot-opt-group + .bot-opt-group { margin-top:16px; }
.bot-opt-label { color:#5a6a7a; font-size:11px; font-weight:700; letter-spacing:.08em; margin-bottom:10px; }
.bot-opt-btns { display:flex; gap:6px; }
.bot-opt-btn { flex:1; padding:8px 12px; border:1px solid #2a3a4a; background:#0f1923; color:#6b7d8e;
  font-size:12px; font-weight:600; border-radius:6px; cursor:pointer; transition:all .2s; }
.bot-opt-btn.is-on { color:#c4a060; background:rgba(196,160,96,.1); border-color:#c4a060; }
label.bot-opt-btn { display:flex; align-items:center; justify-content:center; text-align:center; box-sizing:border-box; }
```

런처(⚙)를 상태창 흐름 안에 두면 스크롤과 함께 움직이고, `position:fixed` 플로팅 버튼으로 두면 화면에 고정된다. 드로어 자체는 fixed 다.

---

## 5. 변수와 defaultVariables

카드 `defaultVariables`(한 줄에 `name=value`):

```
drawer_open=0
drawer_tab=1
asset_aux=0
show_asset_label=1
```

RisuAI 는 **새 챗**에만 이 값을 넣는다. 이미 있는 챗은 `onStart` 에서 백필한다.

```lua
function onStart(id)
    setChatVar(id, "drawer_open", "0"); setChatVar(id, "drawer_tab", "1")
    if not getChatVar(id, "asset_aux") then setChatVar(id, "asset_aux", "0") end
    if not getChatVar(id, "show_asset_label") then setChatVar(id, "show_asset_label", "1") end
end
```

명명 관례:
- **UI 열림 플래그**: 소문자, `"0"/"1"` 문자열. 탭은 `"1"/"2"`.
- **사용자 옵션**: 봇 접두사를 붙이거나, 여러 봇이 같은 뜻으로 쓰는 이름을 맞춘다.
- **파생(표시 전용) 변수**: `_ui`/`_html` 접미사. Lua 가 계산하고 정규식/CBS 가 `{{getvar::}}` 로 읽기만 한다.
- **반전 플래그**: 기본값이 0 이 되도록 부정형으로 짓는다(`feature_off=0` 이 켜짐). defaultVariables 가 빠져도 안전하다.

값 관례: 모든 chatvar 는 문자열이다. 미설정 값은 호스트 버전에 따라 `nil`/`""`/`"null"` 셋 다 올 수 있으므로,
빈 검사는 `v == nil or v == ""` 로, 숫자는 `tonumber(v) or 0` 으로 한다. CBS `vis`/`visnot` 의 첫 인자는 변수 **이름**이다.
`{{#when::asset_aux::vis::1}}` 은 맞고 `{{#when::{{getvar::asset_aux}}::vis::1}}` 은 틀리다.

---

## 6. 함정

1. **markdown-it 이 체크박스 형제 관계를 깨뜨린다 (가장 흔한 사고).** `<input>`/`<label>` 은 CommonMark 블록 태그가 아니다.
   체크박스와 뒤따르는 `<div>` 를 한 줄에 이어 쓰면 markdown 이 `<p>` 로 감싸고, HTML 파서가 첫 `<div>` 에서 `<p>` 를 닫는다.
   그러면 `.bot-drawer` 가 체크박스의 형제 범위 밖으로 밀려나 `:checked ~` 규칙이 전부 죽는다.
   규칙: 최상위 요소는 **한 줄에 하나**, 블록 안에 **빈 줄 금지**(빈 줄은 HTML 블록을 조기 종료), 한 줄에 여러 요소를 이으려면 첫 태그가 `<div>` 여야 한다.
2. **editDisplay 는 모든 메시지 렌더마다 호출된다.** 앵커가 없으면 즉시 반환하고, `meta.index` 로 옛 메시지를 조기 반환하며, 빌드는 `pcall` 로 감싼다.
3. **`json` 전역이 깨질 수 있다.** 일부 배포에서 json 모듈 로드가 실패해 `json` 이 table 이 아니면 리스너가 죽고, Lua 로 주입한 UI 전체가 조용히 사라진다.
   스크립트 선두에서 `type(json) ~= "table"` 이면 자체 encoder/decoder 로 대체한다.
4. **`animation` 은 재렌더마다 재생된다.** 옵션 클릭마다 깜빡이므로 `transition` 을 쓴다.
5. **CSS 가 `</style>` 밖에 있으면 죽은 CSS 다.** 스피너가 상시 노출되는 식의 사고로 나타난다.
6. **패널이 두 메시지에 그려지면 겹친다.** `position:fixed` 라 물리적으로 겹치고, 체크박스 id 가 고정이라 `<label for>` 가 첫 번째만 가리킨다. 팁 전용 게이트가 둘 다 막는다.
7. **`getFullChat()` 남용.** 전체 대화를 매 호출마다 Lua JSON 파서로 파싱한다. 긴 챗에서는 수백 KB 이고, wasm 힙이 파싱 고점을 반환하지 않아 모바일에서 탭이 강제 리로드된다. 팁만 필요하면 `getChat(id, idx)` 로 뒤에서부터 한 건씩 읽는다.
8. **비동기 작업이 끝났을 때 대상 메시지가 바뀌었을 수 있다.** 사용자가 그 사이 리롤/삭제했을 수 있으므로, `setChat` 전에 대상 메시지를 다시 읽어 그대로인지 비교한다.
9. **HTML 속성값에 변수 문자열을 넣으면 깨질 수 있다.** `"` 가 들어오면 속성이 끝난다. Lua 가 정한 값만 쓰거나 이스케이프한다. `url('{{raw::…}}')` 을 Lua 작은따옴표 문자열 안에 쓸 때는 `\'` 로 이스케이프한다.
10. 정규식의 `ableFlag: false` 는 비활성이 아니라 "flag 옵션 미사용(기본 g)" 이다.
11. 순수 옵션 패널은 `lowLevelAccess` 없이 만들 수 있다. `setChatVar`·`reloadDisplay` 는 기본 권한이다. `axLLM`·`LLM` 을 부르는 옵션(에셋 재생성 등)이 있을 때만 켠다.

---

## 7. 정규식 기반 패널 → Lua 빌더 이전 체크리스트

1. 정규식 `out:` 의 드로어 HTML 을 Lua `build_drawer_html(gv)` 로 옮긴다. `{{#when::X::vis::1}}…{{/when}}` 는 `if gv("X")=="1" then … end` 가 된다. `{{raw::}}` 만 CBS 로 남긴다.
2. `listenEdit('editDisplay', function(id, text, meta) … end)` 에서 앵커 위치를 찾아 `text:sub` 로 삽입한다. `meta.index`·`getChatLength` 로 옛 메시지를 조기 반환하고, 바깥을 `{{#if {{equal::{{chat_index}}::{{lastmessageid}}}}}}` 로 감싼다.
3. 열림/닫힘/탭을 hidden checkbox + `<label for>` 로 바꾸고, CSS 를 `#id:checked ~ .panel .x` 로 다시 쓴다. 체크박스는 패널 컨테이너의 **앞선 형제**로, 요소는 **한 줄에 하나**씩 둔다.
4. `onButtonClick` 에서 패널 여닫기 분기를 지운다. 옵션 분기는 `setChatVar` + `restore_drawer(id)` 만 하고 `reloadDisplay` 를 뺀다. 옛 메시지 정규식이 읽는 변수만 예외다.
5. `onButtonClick` 진입·`onStart`·`editInput`·`editOutput` 에서 열림 플래그를 리셋한다.
6. 옵션 버튼을 `<label class="… is-on" for="bot-busy" risu-btn="…">` 로 바꾸고 busy 오버레이 CSS 를 넣는다.
7. `defaultVariables` 에 열림 플래그를 추가하고 `onStart` 에서 백필한다.
8. `json` 자가 치유 블록을 넣는다.
9. 진입 `animation` 을 `transition` 으로 바꾼다.
