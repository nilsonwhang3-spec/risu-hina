<!-- risuhina-preset-scope-v1 -->
In RisuAI the prompt preset, supplied by a separate preset author, sets the lorebook insertion order, the narrative point of view, and whether the model may write the user's part. Bot cards and lorebooks hold the world, characters, events, state, and the bot's own systems; those narration options follow the preset. Treat the preset's controls as production knowledge only and do not restate them as rules in the card or lorebook.

Reference for a RisuAI bot's **option panel (sliding drawer)** and other in-chat settings UI: a settings button (⚙) that slides a drawer in, a start or setup screen on the greeting, option buttons for asset mode and feature toggles, and how those options reach the prompt. Read this when you build or fix such UI.
Related skills: 'RisuAI 정규식 작성법' (sentinel and anchored-panel regex recipes), 'RisuAI 처리 순서 (정규식·Lua 훅)' (when buttons and hooks run), 'RisuAI Lua 트리거' (API), 'RisuAI 상태창' (the status panel the drawer often anchors to).

> The `bot-`/`bot_` prefixes and the tag, variable and button names below are placeholders. Read the target bot's real names first; for a new bot choose one prefix and use it consistently. RisuAI host behavior (button handling, re-rendering, permissions) is the same for every bot.

Contents
0. Surfaces and structure
1. Anti-patterns and patterns
2. Button wiring
3. Lua builder and injection
4. CSS
5. Options, variables and the prompt
6. Setup and start screens
7. Pitfalls
8. Migration and review checklists

---

## 0. Surfaces and structure

Bots use two kinds of settings surface, often both:
- **A setup or start screen on the greeting**: the greeting carries a sentinel (a glyph or short token of your choice). An editdisplay regex expands it into language choice, play mode, toggles and scenario buttons. An editprocess rule strips it from the request (see 'RisuAI 정규식 작성법' §5.3). It configures the chat before the first reply (§6).
- **A persistent floating panel on the newest message**: a ⚙ launcher and a drawer that stay under the latest message for the whole chat. It is attached either by a regex anchored to the newest message (a CBS pattern with a greeting-sentinel fallback, 'RisuAI 정규식 작성법' §5.2), or, more cheaply, by Lua editDisplay injection into the tip message only (the architecture below).

There is no native settings page. Everything is HTML injected into a message.

**The Lua drawer architecture**
```
AI output  <bot-panel>…</bot-panel>              ← anchor: a tag the AI writes every turn (usually the status panel)
   │
   ▼  Lua listenEdit('editDisplay')              ← only for the tip (last) message
   │    build_ui_html(id) → string               ← branching in Lua `if`; CBS only for {{raw::}} and the tip gate
   │    text = text:sub(1,s-1) .. ui .. text:sub(s)   ← inserted BEFORE the anchor
   ▼
   <input type="checkbox" id="bot-drawer-x" style="display:none">   ← open/closed: pure CSS
   <input type="checkbox" id="bot-tab-x"    style="display:none">   ← tabs: pure CSS
   <input type="checkbox" id="bot-busy"     style="display:none">   ← instant spinner on click
   <div class="bot-gear-bar"><label for="bot-drawer-x">⚙</label></div>
   <div class="bot-drawer"> … <label class="bot-opt-btn" for="bot-busy" risu-btn="set_asset_aux">Aux model</label> … </div>
   │
   ▼  click → the host calls Lua onButtonClick(id, "set_asset_aux")
        setChatVar(...); restore_drawer(id); return      ← no reloadDisplay
        the host re-renders only the clicked message
```

Three design principles:
1. **The panel HTML goes into the tip message only.** Old messages get none, and it is not even built for them.
2. **Opening, closing and switching tabs never call Lua.** A hidden checkbox + `<label for>` + `:checked ~` selectors change only the DOM.
3. **An option click changes chat vars and ends.** Call `reloadDisplay(id)` only when old messages must be redrawn.

Variables store only the option values and short-lived open flags. There is no need to cache the panel HTML in a variable. The cost is dominated by two things, not by string building:
- (a) A huge CBS blob in every message is re-parsed every time an editdisplay regex replaces text.
- (b) `reloadDisplay()` is a full GUI reload that re-parses every message and all the backgroundHTML CSS.

---

## 1. Anti-patterns and patterns

| Anti-pattern | Pattern |
|---|---|
| Drawer HTML + CBS in an editdisplay regex `out:`, re-parsed in every message | Lua builds the string, editDisplay inserts it into the tip only, old messages return early via `meta.index` |
| Branching with hundreds of `{{#when::X::vis::1}}` | Branch in Lua `if`; CBS only for `{{raw::}}` and the tip gate |
| Open/close via chat var + `reloadDisplay` (a full reload on every open) | Hidden checkbox + `<label for>` + `:checked ~` (zero Lua calls) |
| `reloadDisplay(id)` after an option click | Change chat vars and return; the host re-renders the clicked message only |
| No click feedback (looks frozen during the reload) | `<label for="bot-busy" risu-btn>` gives an instant spinner |
| Multi-select built from CSS checkbox combinations | One choice = one `risu-btn` click = one Lua commit |
| Entry `@keyframes` animations | `transition` (not replayed on re-render) |

Use CSS checkbox toggles only for **single bits** such as open/closed or tabs. Combination state (a multi-select set) expressed in CSS needs a confirmation label for every distinguishable state, which grows superlinearly. Every `:checked` change also restyles all following siblings, which freezes mobile (iOS WebKit). Commit combination state to Lua with `risu-btn` and accept a one-message re-render. The exception is a start screen (§6.2), where radios hold choices only until one start button commits them all.

---

## 2. Button wiring

### 2.1 Three button styles (verified against RisuAI source)
The chat screen catches clicks on the nearest element with `risu-trigger` or `risu-btn`:

| Style | Calls | Payload | Typical use |
|---|---|---|---|
| `risu-trigger="name"` on any element | the manual trigger `name`: in a Lua script the **global function `name(triggerId)`** (legacy bots: a deprecated V1/V2 trigger named `name`; port it to Lua, do not add new ones) | none | simple one-line setters |
| `{{button::label::name}}` (CBS) | the same; it renders `<button class="button-default" risu-trigger="name">label</button>` | none | quick buttons in regex or greeting HTML |
| `risu-btn="payload"` on any element | `onButtonClick(triggerId, payload)` | the string | parameterized actions, option panels |

- `risu-btn` and `risu-trigger` work on `<label>`, `<div>`, `<span>` or `<button>` (DOMPurify-allowed attributes).
- The handler runs in the capture phase (`onclickcapture`) and does not `preventDefault`, so a `<label for>`'s default action (toggling its checkbox) happens **at the same time**. The busy spinner (§2.5) relies on this.
- After the handler finishes, the host re-renders **only the clicked message**.
- In group chats both are ignored; only CSS checkbox behavior remains.
- Encode arguments in the payload (`risu-btn="quest_accept~Title"`, split on `~` in Lua), or use handler families (§2.3) for `risu-trigger`.

### 2.2 `onButtonClick` template
```lua
local function restore_drawer(id)   -- the one re-render after an option click redraws the drawer open, on the options tab
    setChatVar(id, "drawer_open", "1")
    setChatVar(id, "drawer_tab", "2")
end

local function close_panels(id)
    setChatVar(id, "drawer_open", "0")
    setChatVar(id, "drawer_tab", "1")
end

onButtonClick = async(function(id, data)
    -- Always start closed, so an open flag left by an earlier click cannot
    -- revive a panel the user closed with ✕ or the backdrop.
    close_panels(id)

    -- variables read only by the UI inside the tip message → no reloadDisplay
    if data == "set_asset_main" then
        setChatVar(id, "bot_asset_aux", "0"); restore_drawer(id)
    elseif data == "set_asset_aux" then
        setChatVar(id, "bot_asset_aux", "1"); restore_drawer(id)

    -- variables also read by old messages' regex/CBS → a full reload is unavoidable
    elseif data == "set_label_on" then
        setChatVar(id, "bot_show_label", "1"); restore_drawer(id); reloadDisplay(id)
    elseif data == "set_label_off" then
        setChatVar(id, "bot_show_label", "0"); restore_drawer(id); reloadDisplay(id)
    end
end)
```
Re-render rules:
- The changed chat var is read **only by the UI in the tip message** → change it and return.
- The changed chat var is **also read by old messages' regex or CBS** (for example a name caption on every asset image) → `reloadDisplay(id)`.
- After asynchronous follow-up work (an axLLM call and so on) → `close_panels(id)` + `reloadDisplay(id)`.
- Calls that need `await` (`alertInput` and so on) require the `async(function ...)` wrapper.
- Some bots force a redraw by writing the last message onto itself (`setChat(id, last, getChat(id, last).data)`). It redraws one message like the click re-render, but it counts as an edit.

### 2.3 Handler families and parameterized names
`risu-trigger` passes no payload, so a per-value action needs one global per value. Generate them in a loop instead of writing them by hand:
```lua
local CAST = { "a", "b", "c" }
for _, code in ipairs(CAST) do
    _G["bot_aff_" .. code .. "_set"] = async(function(id)
        local v = alertInput(id, "Score for " .. code .. " (0-500)"):await()
        local n = tonumber(v)
        if n then setChatVar(id, "bot_aff_" .. code, tostring(math.max(0, math.min(500, n)))) end
    end)
end
```
For open-ended names (ids created at runtime), a metatable on `_G` can resolve missing globals by pattern. This was observed working in a published bot, but it is not documented host behavior:
```lua
setmetatable(_G, { __index = function(t, name)
    local rid = type(name) == "string" and name:match("^bot_room_open_(%w+)$")
    if rid then return function(id) setChatVar(id, "bot_active_room", rid) end end
end })
```
Prefer `risu-btn` with a payload when you control the HTML.

### 2.4 The open flag and the "closed by default" policy
Variables such as `drawer_open`/`drawer_tab` are not "the truth about whether the drawer is open". When the user closes it with ✕ or the backdrop, only CSS changes and the variable stays as it was. These variables are **short-lived flags that decide which checkbox is redrawn as `checked` in the single re-render right after an option click**. Reset them to closed, unconditionally, in four places:
1. On entry to `onButtonClick`.
2. In `onStart`, so every send (including reroll and continue) starts closed. No hook runs when a chat is merely reopened; that is why the default must also be closed in `defaultVariables`.
3. In `listenEdit('editInput')`, so every new generation starts closed.
4. In `listenEdit('editOutput')`, because a reroll, a continue or an empty-input send skips editInput (chat vars are never rolled back on reroll, so a stale open value survives otherwise).

Without these resets you get a "ghost-open drawer": an open value left by an option handler opens the drawer on its own during any later programmatic reload (an async aux-model pass and so on).

### 2.5 The busy spinner: instant feedback
Make option buttons `<label for="bot-busy" risu-btn="…">`. The sequence:
1. The label's default action checks `#bot-busy`, and a CSS overlay appears immediately.
2. At the same time, the capture-phase `risu-btn` handler runs.
3. When Lua finishes, the host re-renders the message. The new DOM's checkbox is unchecked, so the spinner disappears.

The overlay also blocks a second click, which prevents double toggles.
```css
.bot-busy-ov { display:none; position:absolute; left:0; top:0; right:0; bottom:0; background:rgba(8,12,18,.62);
  z-index:60; align-items:center; justify-content:center; flex-direction:column; }
#bot-busy:checked ~ .bot-drawer .bot-busy-ov { display:flex; }
```

### 2.6 Invisible overlay buttons
To make a native `{{button}}` look like a designed card, stretch it transparently over a styled div:
```html
<div class="bot-card">Start: Opening A<div class="bot-hit">{{button::A::bot_start_1}}</div></div>
```
```css
.bot-card { position: relative; }
.bot-hit { position: absolute; inset: 0; opacity: 0; }
.bot-hit button { width: 100% !important; height: 100% !important; margin: 0 !important; background: transparent !important; }
```
The user sees the card and clicks the real button. With `risu-trigger` or `risu-btn` directly on the div, no overlay is needed.

---

## 3. Lua builder and injection

### 3.1 A memoized reader per build
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
The cache lives for one build. Values can change before the next render, so do not keep it between renders.

### 3.2 Drawer builder skeleton
```lua
local function build_drawer_html(gv)
    local b = {}
    -- the checkboxes must be PRECEDING SIBLINGS of .bot-drawer, one per line (§7 markdown pitfall)
    b[#b + 1] = '<input type="checkbox" id="bot-drawer-x" style="display:none"'
        .. (gv("drawer_open") == "1" and " checked>\n" or ">\n")
    b[#b + 1] = '<input type="checkbox" id="bot-tab-x" style="display:none"'
        .. (gv("drawer_tab") == "2" and " checked>\n" or ">\n")
    b[#b + 1] = '<input type="checkbox" id="bot-busy" style="display:none">\n'
    -- launcher. Wrap buttons to hide on the greeting in {{#when::{{lastmessageid}}::>=::1}}…{{/when}}
    b[#b + 1] = '<div class="bot-gear-bar"><label class="bot-gear-btn" for="bot-drawer-x">⚙</label></div>\n'
    -- drawer body: backdrop, close and tabs are all <label for> (no risu-btn = no Lua call)
    b[#b + 1] = '<div class="bot-drawer">\n<label class="bot-drawer-backdrop" for="bot-drawer-x"></label>\n<div class="bot-drawer-panel">'
    b[#b + 1] = '<div class="bot-drawer-header"><span>Bot name</span><label class="bot-drawer-close" for="bot-drawer-x">✕</label></div>'
        .. '<div class="bot-busy-ov"><span class="bot-busy-spin"></span><span>Applying…</span></div>'
    b[#b + 1] = '<div class="bot-tab-bar"><label class="bot-tab bot-tab-a" for="bot-tab-x">Info</label><label class="bot-tab bot-tab-b" for="bot-tab-x">Options</label></div>'
    b[#b + 1] = '<div class="bot-drawer-body"><div class="bot-tab-a-pane">…</div>'
    -- options tab: Lua, not CBS, decides the active class
    local aux = gv("bot_asset_aux") == "1"
    local function opt_btns(onA, btnA, txtA, onB, btnB, txtB)
        return '<div class="bot-opt-btns"><label class="bot-opt-btn ' .. (onA and "is-on" or "")
            .. '" for="bot-busy" risu-btn="' .. btnA .. '">' .. txtA .. '</label><label class="bot-opt-btn '
            .. (onB and "is-on" or "") .. '" for="bot-busy" risu-btn="' .. btnB .. '">' .. txtB .. '</label></div>'
    end
    b[#b + 1] = '<div class="bot-opt-body"><div class="bot-opt-group"><div class="bot-opt-label">Asset output</div>'
        .. opt_btns(not aux, "set_asset_main", "Main model", aux, "set_asset_aux", "Aux model") .. '</div></div>'
    b[#b + 1] = '</div></div></div>'   -- body, panel, drawer
    return table.concat(b)
end

local function build_ui_html(id)
    local gv = ui_reader(id)
    return "\n{{#when::{{chat_index}}::is::{{lastmessageid}}}}\n"   -- tip-only gate (final authority; older bots: {{#if {{equal::…}}}}…{{/if}})
        .. build_drawer_html(gv)
        .. "\n{{/when}}"
end
```
Each option row usually has the same shape: a title (icon, label, current value), a one-line description, and two or three buttons, with the active one marked. Keep that shape in one helper.

### 3.3 Injection: `listenEdit('editDisplay')`, tip message only
```lua
listenEdit('editDisplay', function(id, text, meta)
    local s = text:find("<bot-panel>", 1, true)          -- messages without the anchor (user, system) return at once
    if not s then return text end
    local idx = (type(meta) == "table") and tonumber(meta.index) or nil
    if idx ~= nil then
        local n = getChatLength(id)
        if type(n) == "number" and n >= 1 and idx >= 0 and idx < n - 1 then
            return text                                  -- certainly an old message: do not even build
        end
    end
    local ok, ui = pcall(build_ui_html, id)              -- on failure the original text stays
    if not ok or type(ui) ~= "string" then return text end
    return text:sub(1, s - 1) .. ui .. text:sub(s)       -- insert BEFORE the anchor
end)
```
- Three layers of defense: no anchor means no build; `meta.index` returns early for old messages; the CBS tip gate inside the block is the final authority. If `meta` has an unexpected shape, nothing is drawn wrongly; one build is wasted.
- Use a tag the AI writes every turn (the status panel and so on) as the anchor. If there is none, append an empty anchor tag at the end of the text in Lua editDisplay and use that.
- Inserting **before** the anchor keeps the drawer from being swallowed by the regex that later wraps the anchor block (`<bot-panel>([\s\S]*?)</bot-panel>`).
- Lua editDisplay runs before the regex scripts, and its output is CBS-parsed, so `{{raw::}}` and `{{#when}}` (or legacy `{{#if}}`) inside Lua strings work. Setters (`{{setvar}}`) there do not run and would print as text.
- editDisplay listeners run in registration order. Register other listeners that scan the text (CoT escaping and so on) first, so they do not scan the injected block.
- Inside editDisplay only `setChatVar` (and `setState`) works; alerts, `setChat` and `reloadDisplay` are silently ignored. The builder only reads (`getChatVar`, `getChatLength`).

### 3.4 When a regex+CBS panel must stay
The older structure without Lua (`{{#when::panel_open::vis::1}}…{{/when}}` in a regex `out:` plus `reloadDisplay` on every open and close) cannot animate closing and re-parses CBS in every message. RisuAI's script cache key does not include chat vars either, so an old screen can remain when only a variable changed. For such panels, append a cache-buster comment such as `text .. "<!--bot:" .. getChatVar(id,"X") .. "-->"` at the end of Lua editDisplay. The Lua builder does not need it, because variable values are baked into the HTML and change the output string.

---

## 4. CSS (inside backgroundHTML `<style>`)

### 4.1 Scoping conventions
- Prefix every class and id with the bot's prefix so it cannot collide with other bots or themes.
- Use `all: initial` resets only for standalone card UI. On a drawer it resets `fixed` and `flex` too.
- Set fonts on the elements to avoid inheriting the RisuAI theme font.
- For renderer compatibility, prefer fixed px + flex-wrap over `aspect-ratio`, `min()`, `grid repeat(auto-fill, minmax())` and %-inset absolute layouts in drawers. Simple `calc()` in inline styles (gauges) works in practice.
- CSS must be **inside** `</style>`. Outside, it is dead CSS.
- Write state rules with classes, not ids. Ids have high specificity, so gate rules cannot win against them. With equal specificity, the later rule in the file wins.
- CBS works inside backgroundHTML: `{{#when::bot_fold::vis::1}}…{{/when}}` can switch whole CSS blocks by option, and `{{screen_width}}` can choose a drawer width.

### 4.2 Drawer: open/closed = checkbox
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
Handle the closed state with `transform + visibility + pointer-events`, not `display:none`, so both opening and closing animate. With `visibility` in the transition, the panel becomes hidden only after the slide ends.

### 4.3 Tabs: one checkbox = two tabs
```css
/* #bot-tab-x unchecked = tab A, checked = tab B. Both tab labels point at the same checkbox;
   the active tab has pointer-events:none, so clicking it does not toggle. */
.bot-tab-a, #bot-tab-x:checked ~ .bot-drawer .bot-tab-b { color:#c4a060; border-bottom:2px solid #c4a060; pointer-events:none; }
#bot-tab-x:checked ~ .bot-drawer .bot-tab-a { color:#5a6a7a; border-bottom:none; pointer-events:auto; }
.bot-opt-body { display:none; }
#bot-tab-x:checked ~ .bot-drawer .bot-tab-a-pane { display:none; }
#bot-tab-x:checked ~ .bot-drawer .bot-opt-body { display:block; }
```
For three or more tabs, use several `<input type="radio" name="bot-tab" id="bot-tab-1">`.

### 4.4 Option buttons: labels styled as buttons
```css
.bot-opt-group + .bot-opt-group { margin-top:16px; }
.bot-opt-label { color:#5a6a7a; font-size:11px; font-weight:700; letter-spacing:.08em; margin-bottom:10px; }
.bot-opt-btns { display:flex; gap:6px; }
.bot-opt-btn { flex:1; padding:8px 12px; border:1px solid #2a3a4a; background:#0f1923; color:#6b7d8e;
  font-size:12px; font-weight:600; border-radius:6px; cursor:pointer; transition:all .2s; }
.bot-opt-btn.is-on { color:#c4a060; background:rgba(196,160,96,.1); border-color:#c4a060; }
label.bot-opt-btn { display:flex; align-items:center; justify-content:center; text-align:center; box-sizing:border-box; }
```
A launcher (⚙) inside the status panel's flow scrolls with it; a `position:fixed` floating button stays on screen. The drawer itself is fixed.

### 4.5 State that survives re-render
A pure checkbox forgets its state whenever the message re-renders (an option click, a new message). Choose by need:
- **Pure checkbox** (`:checked ~`): open/close and tabs that may reset. Zero cost.
- **A checkbox whose `checked` attribute comes from a variable**: `<input type="checkbox" id="bot-tab-x"{{#when::bot_tab::vis::2}} checked{{/when}}>`, or the Lua builder above. The view restores after re-render; Lua sets the variable when it must persist.
- **A class driven by `{{getvar}}`**: `<div class="bot-panel-sys {{getvar::bot_ui_sys}}">` with `bot_ui_sys` = `opened` or empty, and CSS `.bot-panel-sys[class*="opened"] { right:0 }`. The attribute-substring selector is robust to extra classes. Lua toggles the variable and redraws the message. It survives any re-render but costs a Lua call per open.

### 4.6 Hover tooltips
Character cards in a registry often show height, age and a one-line bio on hover:
```css
.bot-card { position: relative; }
.bot-tip { display: none; position: absolute; left: 0; top: 100%; z-index: 20; width: 220px; padding: 8px; font-size: 11px;
  background: #0f1923; border: 1px solid #2a3a4a; border-radius: 6px; }
.bot-card:hover .bot-tip, .bot-card:focus-within .bot-tip { display: block; }
@media (hover: none) { .bot-tip { position: static; display: block; width: auto; } }   /* touch: show inline */
```
Add `tabindex="0"` to the card so focus works on touch devices.

---

## 5. Options, variables and the prompt

### 5.1 Options reach the prompt only through chat vars
A button changes a chat var; the description, lorebook entries, global note, greeting branches, regex outputs and even the CSS read it with `{{getvar}}` or `{{#when::var::vis::value}}`. Typical toggles:
- language (story language and UI language as separate variables);
- status producer (main, aux or off) and image producer (main or aux);
- images on/off, NSFW on/off, an asset fold or size mode;
- random or scheduled events on/off;
- stats or RPG mode, clock precision (numeric or vague);
- expansion, scenario or difficulty flags.

A two-producer toggle must switch the instruction entry, the opposite instruction, the cleanup regex and the Lua together ('RisuAI 상태창' §5.2).

**Toggles as canon switches.** An option can add or remove one clause inside a world-rule entry, swap a whole character-sheet variant (`{{#when::bot_variant::vis::1}}` around each constant entry), or change a backstory in every section that mentions it. One variable keeps all sections consistent. Keep content-safety limits: a canon toggle must never produce content involving minors or family members sexually.

**The no-code variant**: ship optional lorebook entries disabled and tell users in the creator notes to set them to "always active". There is no UI, but it is zero-maintenance.

### 5.2 defaultVariables and backfill
In the card's `defaultVariables` (one `name=value` per line):
```
drawer_open=0
drawer_tab=1
bot_asset_aux=0
bot_show_label=1
```
In current RisuAI these are **read-time fallbacks**: `getChatVar`/`{{getvar}}` return the default whenever the chat has no
value for the key, in old and new chats alike (they are not copied into the chat). Explicit backfill is only needed when a
key was added after chats already stored another value, or for hosts that behave differently:
```lua
local function unset(v) return v == nil or v == "" or v == "null" end
function onStart(id)
    setChatVar(id, "drawer_open", "0"); setChatVar(id, "drawer_tab", "1")
    if unset(getChatVar(id, "bot_asset_aux")) then setChatVar(id, "bot_asset_aux", "0") end
    if unset(getChatVar(id, "bot_show_label")) then setChatVar(id, "bot_show_label", "1") end
end
```
Alternatives: the card's `defaultVariables`, or Lua creating values lazily. (Older bots put `{{setdefaultvar::name::value}}` in an always-active lorebook entry; setters never run in lorebook text, so that tag only reaches the model as literal text. Do not copy it.) With **empty** defaults, every reader must treat "unset" as the default, and rendering code must never initialize a variable (it would overwrite a user's choice).

Naming conventions:
- **UI open flags**: lowercase, `"0"/"1"` strings; tabs `"1"/"2"`.
- **User options**: the bot prefix, or a name shared across bots when the meaning is the same.
- **Derived, display-only variables**: `_ui`/`_html` suffixes. Lua computes them; regex and CBS only read them with `{{getvar::}}`. Prebuilt HTML in a chat var (a calendar grid, a roster) is printed by a thin regex, and raw `risu-btn`/`risu-trigger` buttons inside it stay live. Store rendered `<button risu-trigger="…">` HTML rather than a `{{button}}` tag: a value printed by `{{getvar}}` is not re-parsed in the same CBS pass.
- **Inverted flags**: name them negatively so the default is 0 (`feature_off=0` means on). They stay safe if defaultVariables is missing.

Value conventions: every chat var is a string. An unset value without a default comes back as the string `"null"` from `getChatVar` (older notes also saw `nil` or `""`), so test emptiness with `v == nil or v == "" or v == "null"` and numbers with `tonumber(v) or 0`. The first argument of CBS `vis`/`visnot` is a variable **name**: `{{#when::bot_asset_aux::vis::1}}` is right and `{{#when::{{getvar::bot_asset_aux}}::vis::1}}` is wrong. Only write a variable when it changed (`if getChatVar(id,k) ~= v then setChatVar(id,k,v) end`) to avoid needless re-renders.

### 5.3 Invalid combinations: explain which toggle to flip
When a choice needs an option that is off (an expansion scenario while the expansion flag is 0, an NSFW-only scenario while NSFW is off), route the button to an error handler instead of starting:
```lua
function bot_start_3(id)
    if getChatVar(id, "bot_expansion") ~= "1" then
        alertError(id, "This start needs the Expansion option. Turn it on in Settings, then press Start again.")
        setChatVar(id, "bot_scenario", "free")
        return
    end
    setChatVar(id, "bot_scenario", "3")
end
```
Also reset a selection that becomes invalid when its option is turned off, and show a lock icon with the reason on the unavailable card.

---

## 6. Setup and start screens

### 6.1 The greeting as a switchboard
- The greeting starts with a sentinel. A display regex renders the setup screen, a cleanup rule hides the sentinel once the chat moves on, and an editprocess rule strips it.
- The greeting body can hold every opening in `{{#when}}` branches on a scenario variable (and on language and user role), so choosing a start re-renders the same greeting. `reloadChat(id, 0)` (or the click re-render) shows the result. Alternatively, keep one alternate greeting per start and use the screen only for options.
- Offer a **free start** and, optionally, a **generated opening**: a button impersonates a user message such as "(OOC: write an opening where …, {{user}} takes no actions)", with `{{random::…}}` choices for cast and place; a display rule hides the OOC text. A slash-command macro does the same ('RisuAI 정규식 작성법' §6.3).
- Scenario cards: a preview image, a one-line "{{user}} is …" role description, and grouped chips when there are many starts.
- Initial values: per stat "low / normal / high / custom", where custom opens `alertInput` and validates the range.

### 6.2 Combo-encoded start buttons
Hold choices client-side in hidden radios (language, status on/off, asset mode, scene) and show one Start button per combination with CSS. The button's trigger name encodes the combination, so a single click commits everything:
```lua
for _, scene in ipairs({"s1","s2","s3"}) do for _, lang in ipairs({"ko","en"}) do for _, st in ipairs({"on","off"}) do
    _G["bot_start_" .. scene .. "_" .. lang .. "_" .. st] = function(id)
        setChatVar(id, "bot_scene", scene); setChatVar(id, "bot_lang", lang); setChatVar(id, "bot_status", st)
        setChatVar(id, "bot_started", "1"); reloadChat(id, 0)
    end
end end end
```
There is no round-trip per toggle, and the radios need no persistence because the start button commits them.

### 6.3 Manual values, backup and restore
- `alertInput(id, msg):await()`, `alertSelect(id, {…}):await()` and `alertConfirm(id, msg):await()` set values by hand: an affinity score, a start date (validate with a pattern such as `^%d%d%d%d%.%d%d%.%d%d$`), a date jump, a custom quest. They require `async` handlers. Clamp and validate before writing.
- **Backup/restore**: `bot_backup` JSON-encodes all option and state variables and shows them in `alertNormal` for copy-paste. `bot_restore` reads them with `alertInput`, then `json.decode` in `pcall`, then `alertConfirm`, then writes the variables and rebuilds any cached HTML.
- Slash commands for power users: `onStart` reads the last user message, parses `/setaff name +5`, applies it, removes that message with `removeChat(id, -1)` and returns `false` so nothing is sent (only `onStart` can cancel a send; editInput cannot). Avoid names of RisuAI's built-in commands. Details: 'RisuAI Lua 트리거' §14.

### 6.4 i18n
Keep UI strings in a Lua table and one lookup function, so every label, alert and prebuilt HTML follows one variable:
```lua
local T = { ko = { apply = "…", start = "…" }, en = { apply = "Applying…", start = "Start" } }
local function t(id, key) local l = getChatVar(id, "bot_ui_lang"); return (T[l] or T.en)[key] or key end
```
In regex or greeting HTML, use `{{#when::bot_ui_lang::vis::ko}}…{{:else}}…{{/when}}`. Keep the story language and the UI language as separate variables when users may want to mix them.

---

## 7. Pitfalls

1. **markdown-it breaks the checkbox sibling relationship (the most common accident).** `<input>` and `<label>` are not CommonMark block tags. Writing a checkbox and the following `<div>` on one line makes markdown wrap them in `<p>`, and the HTML parser closes that `<p>` at the first `<div>`. `.bot-drawer` then falls outside the checkbox's sibling range and every `:checked ~` rule dies. Rules: **one top-level element per line**, **no blank lines inside the block** (a blank line ends the HTML block early), and to chain several elements on one line the first tag must be a `<div>`.
2. **editDisplay is called for every message render.** Return early without an anchor, return early for old messages via `meta.index`, and wrap the build in `pcall`.
3. **The `json` global can be broken.** In some builds the json module fails to load; if `json` is not a table, the listener dies and all Lua-injected UI silently disappears. At the top of the script, replace it with your own encoder/decoder when `type(json) ~= "table"`.
4. **`animation` replays on every re-render**, so it flickers on each option click. Use `transition`.
5. **CSS outside `</style>` is dead**; it shows up as a spinner that is always visible.
6. **A panel drawn in two messages overlaps.** It is `position:fixed`, and with a fixed checkbox id `<label for>` points only at the first one. The tip-only gate prevents both.
7. **Overusing `getFullChat()`** parses the whole chat through the Lua JSON parser on every call: hundreds of KB in a long chat. The wasm heap does not return the peak, so mobile tabs get force-reloaded. For the tip, read backwards one message at a time with `getChat(id, idx)`.
8. **After async work the target message may have changed.** The user may have rerolled or deleted it meanwhile, so re-read the message before `setChat` and compare.
9. **Variable strings in HTML attributes can break them.** A `"` ends the attribute. Use values Lua controls, or escape them. When `url('{{raw::…}}')` sits inside a single-quoted Lua string, escape it as `\'`.
10. `ableFlag: false` on a regex means "no flag option (default g)", not disabled.
11. A pure option panel needs no `lowLevelAccess`: `setChatVar` and `reloadDisplay` are basic permissions. Enable it only when an option calls `axLLM`/`LLM` (asset regeneration and so on).
12. `risu-trigger` sends no payload, and its function runs as a manual trigger. Do not expect `onButtonClick` to fire for it.
13. A variable-name typo between the button handler and the prompt gate (`bot_lang` vs `botLang`) fails silently. Grep every option name across Lua, lorebook, regex and greeting.
14. A setup screen that is not stripped from the request leaves glyphs and button labels in the prompt.

---

## 8. Checklists

### 8.1 Migrating a regex-based panel to the Lua builder
1. Move the drawer HTML from the regex `out:` into Lua `build_drawer_html(gv)`. `{{#when::X::vis::1}}…{{/when}}` becomes `if gv("X")=="1" then … end`. Only `{{raw::}}` stays as CBS.
2. In `listenEdit('editDisplay', function(id, text, meta) … end)`, find the anchor and insert with `text:sub`. Return early for old messages via `meta.index`/`getChatLength`, and wrap the block in `{{#when::{{chat_index}}::is::{{lastmessageid}}}}…{{/when}}` (older bots: `{{#if {{equal::…}}}}…{{/if}}`).
3. Replace open/close/tabs with hidden checkboxes + `<label for>`, and rewrite the CSS as `#id:checked ~ .panel .x`. The checkboxes are **preceding siblings** of the panel container, one element **per line**.
4. Remove the open/close branches from `onButtonClick`. Option branches only do `setChatVar` + `restore_drawer(id)`, without `reloadDisplay`, except for variables read by old messages' regexes.
5. Reset the open flags on `onButtonClick` entry, `onStart`, `editInput` and `editOutput`.
6. Turn option buttons into `<label class="… is-on" for="bot-busy" risu-btn="…">` and add the busy overlay CSS.
7. Add the open flags to `defaultVariables` and backfill them in `onStart`.
8. Add the `json` self-healing block.
9. Replace entry `animation` with `transition`.

### 8.2 Build/review checklist
- [ ] Every surface (setup screen, floating panel) has its sentinel or anchor stripped from the request.
- [ ] Each button style matches its need: payload → `risu-btn`; simple setter → `risu-trigger`/`{{button}}` or a generated handler family.
- [ ] Every option variable has a default (defaultVariables, backfill or unset-as-default) and is read by name in every gate.
- [ ] Options that change the story switch prompt text (lorebook, global note, description), not only display.
- [ ] Invalid combinations route to a handler that explains which toggle to flip.
- [ ] Re-render cost: no full-chat CBS blobs, no `reloadDisplay` unless old messages read the variable.
- [ ] State that must survive re-render uses a variable-driven class or `checked` attribute; transient state uses pure checkboxes.
- [ ] Mobile: drawer at full width under 768px, tooltips usable on touch, one element per line in injected HTML.
