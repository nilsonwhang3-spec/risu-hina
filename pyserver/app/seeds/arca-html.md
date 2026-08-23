아카라이브(arca.live)에 붙여넣을 HTML을 쓸 때의 제약. 챗로그·소개글·요약 무엇이든
이 규칙을 지켜야 게시 후에도 모양이 남는다.

아카라이브는 Froala WYSIWYG 에디터를 쓰고, 서버 새니타이저가 많은 CSS와 태그를
조용히 제거한다. **제거되면 오류가 아니라 그냥 사라진다** — 붙여넣기 전에는
멀쩡해 보이고 게시 후에 무너지므로, 처음부터 통과하는 것만 쓰는 편이 빠르다.

결과물은 `out/` 에 저장하고, 사용자가 복사해 붙여넣을 수 있게 HTML 그대로 둔다.

---

## 핵심 규칙

**차단 CSS** (사용 시 속성 제거 또는 엘리먼트 삭제):
- 레이아웃: `flex`, `grid`, `position`, `z-index`, `overflow`, `gap`
- 효과: `transform`, `animation`, `transition`, `opacity`, `filter`, `backdrop-filter`
- 클리핑: `clip-path` → 엘리먼트 자체가 삭제됨
- 기타: `cursor`, `pointer-events`, `user-select`, `content`, `mix-blend-mode`
- 선택자: `::before`, `::after`, `:hover`, `:nth-child`, `@media`, `@keyframes`

**차단 태그**: `mark`, `small`, `big`, `code`, `kbd`, `audio`, `svg`, `form`, `input`, `select`, `textarea`, `button`, `script`, `style`, `link`, `dl`, `dt`, `dd`

**허용 레이아웃 방식**:
- `display: table` + `display: table-cell` (수평 분할 — 양쪽 모두 필요)
- `display: inline-block` (개별 블록 요소)
- `display: inline-flex` (버튼 행, 배지 — `gap` 대신 `&nbsp;` 사용)
- `float: right` (`<summary>` 안에서만 검증됨)

**허용 CSS**: `color`, `background`, `background-color`, `linear-gradient()`, `radial-gradient()`, `font-*`, `letter-spacing`, `word-spacing`, `line-height`, `text-align`, `text-indent`, `text-decoration`, `text-transform`, `vertical-align`, `padding`, `margin`, `border`, `border-radius`, `border-collapse`, `border-image`, `width`, `max-width`, `min-width`, `height`, `min-height`, `box-shadow`, `text-shadow`, `calc()`, `clamp()`, `font-variant`, `list-style: none`

**필수 패턴**:
- 모든 스타일은 `style=""` 인라인으로
- 빈 `<span>`/`<div>`에는 `&nbsp;` 삽입 (아니면 Froala가 삭제)
- `opacity` 대신 `rgba(R,G,B,A)` 알파 채널 사용
- `border-image`와 `border-radius` 동시 사용 불가 (CSS 스펙 제한)
- `<blockquote>` 스타일은 내부 `<div>`에 적용 (직접 적용 시 제거됨)
- `<table>` 스타일은 `style` 속성으로 (`border`, `cellpadding` HTML 속성 차단)
- `<a>` 태그에 `target="_blank" rel="noopener noreferrer"` 필수
- `<code>` 대신 `<span style="font-family:monospace;...">` 사용
- HTML 주석 `<!-- -->` 자동 삭제됨
- `<style>` 태그 차단 → CSS 변수 `var()` 사용 불가

---

## 에디터 자동 동작

| 동작 | 설명 |
|------|------|
| 빈 엘리먼트 제거 | 텍스트 없는 `<span>`/`<div>` → 삭제. `&nbsp;` 삽입으로 방지 |
| 태그 변환 | `<b>`→`<strong>`, `<i>`→`<em>`, `<strike>`→`<s>` |
| blockquote 스타일 제거 | 직접 스타일 제거됨. 내부 `<div>`에 적용 |
| img 자동 처리 | `src`가 아카 CDN으로 재작성, `onerror` 제거, `class="fr-fic fr-dii"` 추가 |
| table 속성 제거 | `border`/`cellpadding` HTML 속성 → `style`로 대체 |
| 빈 `<p>` | `<p><br></p>`로 변환 |

---

## 허용 태그 전체 목록

```
strong, em, u, s, del, ins, sub, sup, pre, a, img, video, iframe
span, div, br, hr, p, h1-h6
blockquote (style 속성 제거됨 → 내부 div/span에 스타일)
details, summary
ul, ol, li
table, thead, tbody, tfoot, tr, th, td
ruby, rt, time
```

---

## 차단 구문 상세

- `<style>` 태그, 외부 CSS, 커스텀 클래스
- HTML 주석 `<!-- -->` (자동 삭제)
- `onclick`, `onmouseover` 등 모든 이벤트 핸들러
- `javascript:` URL (인코딩/중화됨)
- `<table>`의 `border`, `cellpadding` HTML 속성 (style 사용)
- CSS `var()` — 새니타이저가 통과시키지만 `<style>` 차단으로 변수 선언 불가

---

## 코드 블록 대체 패턴

`<code>` 태그가 차단되므로 `<span>`이나 `<pre>`로 대체한다.

### 인라인 코드

```html
<span style="background:#1a0f2e;color:#c89ef0;padding:2px 6px;border-radius:4px;font-size:11px;font-family:monospace;">code</span>
```

### 멀티라인 코드

줄바꿈은 `<br>`, 들여쓰기는 `&nbsp;` 반복.
`white-space:pre-wrap`에만 의존하면 새니타이저가 제거 시 한 줄로 출력될 수 있다.

```html
<div style="font-family:monospace;background:#0d1117;padding:16px;border-radius:8px;border:1px solid #30363d;color:#c9d1d9;font-size:12px;line-height:1.8;">
  <span style="color:#8b949e;">// Comment</span><br>
  <span style="color:#ff7b72;">const</span> <span style="color:#79c0ff;">x</span> = {<br>
  &nbsp;&nbsp;key: <span style="color:#a5d6ff;">"value"</span><br>
  };
</div>
```

### Diff 스타일

```html
<pre style="background:#0d0812;color:#e8d5f0;padding:14px 16px;border-radius:8px;font-size:12px;line-height:1.8;border:1px solid #2a1a2a;box-shadow:0 2px 12px rgba(0,0,0,0.4);border-left:3px solid #6c5ce7;">
<span style="color:#ff6b6b;text-decoration:line-through;">- removed line</span>
<span style="color:#80c080;">+ added line</span>
<span style="color:#888;">// unchanged</span>
</pre>
```

---

## 루비

```html
<ruby>東<rt>ひがし</rt></ruby><ruby>京<rt>きょう</rt></ruby>
```

---

## 타이포그래피 표현

```html
<!-- 드라마틱 타이틀 -->
<div style="font-size:36px;font-weight:900;letter-spacing:-1px;line-height:1.1;color:#fff;text-shadow:0 4px 20px rgba(0,0,0,0.8);">TITLE</div>

<!-- 속삭임 -->
<span style="font-size:11px;letter-spacing:6px;text-transform:uppercase;color:rgba(180,180,200,0.5);">whisper text</span>

<!-- 스몰캡스 -->
<span style="font-variant:small-caps;font-weight:bold;font-size:1.1em;letter-spacing:2px;">Official Notice</span>

<!-- 물결 밑줄 강조 -->
<span style="text-decoration:underline wavy #e74c3c;">dangerous text</span>
```

---

## 색상 휠 레퍼런스

선택에 막혔을 때 참고:

```
WARM:  red #c44848 · orange #d4843c · amber #f4a853 · yellow #d4c44c
NEUT:  gold #d4a44c · bronze #a88448 · taupe #a08870 · gray #606870
COOL:  teal #4ab8a8 · cyan #5db8f0 · blue #5a8fd8 · indigo #7a68d8
COLD:  violet #9a7ad8 · magenta #d868a8 · pink #c47a9a · rose #d86878
```

---
