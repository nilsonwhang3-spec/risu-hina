/**
 * One stylesheet, injected once.
 *
 * RisuAI's CSS custom properties cascade into the plugin iframe, so borrowing
 * them makes the panel follow the user's theme for free. Each has a fallback
 * because a fork or an older build may not define all of them.
 *
 * No images in the chrome, still: mainline RisuAI's plugin CSP allows
 * `img-src blob:` since 2026-08 (docs/06 §1-7), so blob-URL images work on
 * both hosts now - but the chrome keeps to inline SVG (markup, not a fetch)
 * and every <img> the panel draws degrades to text when a host refuses it.
 */
export const CSS = `
:host, * { box-sizing: border-box; }
body {
  margin: 0;
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', sans-serif;
  background: var(--bgcolor, #12141a);
  color: var(--textcolor, #d8dce4);
}
button, input, textarea, select { font: inherit; color: inherit; }
button {
  padding: 6px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--borderc, #2b323f);
  background: var(--darkbutton, #1b202a);
  /* A label never breaks mid-word ("진단 정/보"): the row wraps instead. */
  white-space: nowrap; flex-shrink: 0;
}
button:hover:not(:disabled) { filter: brightness(1.25); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.danger { background: #b91c1c; border-color: #b91c1c; color: #fff; }
button.ghost { background: transparent; }
input, textarea, select {
  background: var(--darkbg, #171b23);
  border: 1px solid var(--borderc, #2b323f);
  border-radius: 5px; padding: 6px 9px; width: 100%;
}
textarea { resize: vertical; line-height: 1.6; }
a { color: #7dd3fc; }
code { font-family: Consolas, monospace; font-size: 12px; }

/* Scrollbars: a light translucent thumb with no rail drawn across the panel.
   Firefox takes the standard property, Chromium the webkit one. */
* { scrollbar-width: thin; scrollbar-color: rgba(190, 200, 215, .28) transparent; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(190, 200, 215, .22); border-radius: 6px;
  border: 2px solid transparent; background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background: rgba(190, 200, 215, .42); background-clip: content-box; }
::-webkit-scrollbar-corner { background: transparent; }

.wrap { display: flex; flex-direction: column; height: 100vh; }
header {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--borderc, #2b323f); flex-shrink: 0;
}
header h1 { margin: 0; font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 7px; }
.spacer { flex: 1; }
.dim { color: var(--textcolor2, #79839a); font-size: 12px; font-weight: 400; }

/* Backend health, inline in the title row. It is one dot and a version - it
   never justified a full row of its own above a panel whose job is showing a
   long transcript. */
.status {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 12px; padding: 2px 8px; border-radius: 20px;
  background: rgba(16, 185, 129, .10);
}
.status.bad { background: rgba(239, 68, 68, .14); }
.status.warn { background: rgba(245, 158, 11, .13); }
.status .chatname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.healthdot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
.status.bad .healthdot { background: #ef4444; }
.status.warn .healthdot { background: #f59e0b; }

/* The active tab's tool row, full width under the tabs. */
.toolslot {
  flex-shrink: 0; display: flex; align-items: center; flex-wrap: wrap;
  border-bottom: 1px solid var(--borderc, #2b323f);
}
.toolslot .toolrow { border-bottom: none; }
.toolslot .chatbar { flex: 0 0 auto; padding-right: 4px; }
.toolslot .chatbar + .tabslot:not([style*="none"])::before {
  content: ''; display: inline-block; width: 1px; height: 18px;
  background: var(--borderc, #2b323f); margin: 0 4px; vertical-align: middle;
}
.toolslot .tabslot { flex: 1 1 auto; display: flex; align-items: center; min-width: 0; }
.toolslot .tabslot > .toolrow { flex: 1 1 auto; }
.chatbar .changesum { font-size: 11px; margin-left: 4px; white-space: nowrap; }
.chatbar .applybadge { margin-left: 2px; }
.shellnotice:empty { display: none; }
.tab .tabbadge { margin-left: 5px; font-size: 10px; padding: 0 5px; }
.tchip.skill { background: rgba(37,99,235,.16); border-color: rgba(37,99,235,.35); }
.skillfiles .pickrow { padding: 3px 6px; font-size: 12px; }
.hint.dim { opacity: .7; }
.tabsep { width: 1px; align-self: stretch; margin: 6px 6px; background: var(--borderc, #2b323f); }
.vartable { display: flex; flex-direction: column; gap: 4px; }
.varrow {
  display: grid; grid-template-columns: minmax(90px, 1.2fr) 60px minmax(120px, 2fr) auto;
  gap: 8px; align-items: center; padding: 4px 6px; border-radius: 5px;
}
.varrow.changed { background: rgba(245,158,11,.08); }
.varrow:hover { background: rgba(128,128,128,.08); }
.varkey { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.vartype { font-size: 11px; }
.varvalue input { width: 100%; }
.varops { display: flex; gap: 4px; align-items: center; }
.varadd input { flex: 1; min-width: 90px; }
@media (max-width: 720px) {
  .varrow { grid-template-columns: 1fr 1fr; }
  .varrow .varvalue { grid-column: 1 / -1; }
  .varrow .varops { grid-column: 1 / -1; justify-content: flex-end; }
}
button.outline {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  margin: 4px 0; padding: 6px 8px; font-size: 12px;
  background: rgba(37,99,235,.10); border-color: rgba(37,99,235,.25);
}
button.outline:hover { background: rgba(37,99,235,.18); }
.shellnotice .notice { margin: 6px 10px 0; }
.applypop .row { margin-top: 6px; }
.applypop .row button { width: 100%; }

/* Eleven tabs now; on a narrow panel the bar scrolls rather than wrapping. */
.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--borderc, #2b323f); flex-shrink: 0; overflow-x: auto; overflow-y: hidden; }
.tabs .tab { white-space: nowrap; }

/* Regex patterns, HTML payloads, trigger JSON - text where columns matter. */
.codearea { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: 12px; }

/* The apply verb when a gate (bot not selected, assets importing) blocks it. */
.tool.dimmed { opacity: 0.45; }

/* The shared list filter, and the list rows that carry reorder buttons. */
.searchbox { padding: 4px 8px; }
.searchbox input { width: 100%; }
.treerow.lorecard {
  border: 1px solid var(--borderc, #2b323f); border-radius: 6px;
  padding: 3px 6px 3px 3px; margin: 3px 6px;
}
.movebtn { padding: 1px 6px; min-width: 0; }
/* Trigger mode switch, drawn like RisuAI's own V2 / Lua buttons. */
.modebtn { padding: 3px 10px; font-size: 12px; border: 1px solid transparent; }
.modebtn.on { border-color: #2563eb; color: var(--textcolor, #d8dce4); font-weight: 700; }
.tab {
  padding: 8px 16px; border: none; background: none; border-radius: 0;
  color: var(--textcolor2, #79839a); border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab.active { color: var(--textcolor, #d8dce4); border-bottom-color: #2563eb; font-weight: 700; }
/* The asset importer's progress at the end of the tab row. */
.syncbadge {
  margin-left: auto; align-self: center; padding: 2px 8px; border-radius: 4px; font-size: 11px;
  color: var(--textcolor2, #79839a); border: 1px solid var(--borderc, #2b323f); white-space: nowrap;
}
.syncbadge.busy { color: #f59e0b; border-color: rgba(245,158,11,.5); }
.syncbadge.err { color: #ef4444; border-color: rgba(239,68,68,.5); }

main { flex: 1; min-height: 0; display: flex; }
.panel { display: none; flex: 1; min-height: 0; }
.panel.active { display: flex; }
.pad { padding: 14px; overflow-y: auto; flex: 1; }

/* Flat sections rather than accented rounded cards. A coloured left rail on
   every block turns the panel into stripes and communicates nothing, because
   everything has one; emphasis is kept for blocks that need it. */
.card {
  border: 1px solid var(--borderc, #2b323f); border-radius: 6px;
  padding: 11px; margin-bottom: 10px; background: transparent;
}
.card h2 {
  margin: 0 0 9px; font-size: 11px; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--textcolor2, #79839a);
}
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* A result box under a button row: spaced from the row only when it has something. */
.outbox:not(:empty) { margin-top: 10px; }
.card > .notice, .card > div > .notice { margin-top: 8px; }
.row + .row { margin-top: 8px; }
.grow { flex: 1; min-width: 0; }
label.field { display: block; margin-bottom: 10px; }
label.field > span { display: block; margin-bottom: 4px; color: var(--textcolor2, #79839a); font-size: 12px; }

.notice {
  padding: 8px 10px; border-radius: 5px; margin-bottom: 10px; font-size: 12px;
  background: rgba(245, 158, 11, .10);
}
.notice.err { background: rgba(239, 68, 68, .12); }
.notice.ok { background: rgba(16, 185, 129, .12); }

/* The lorebook entry's insertorder, beside its name. */
.ordertag {
  flex-shrink: 0; padding: 0 5px; border-radius: 3px; font-size: 10.5px;
  font-family: Consolas, monospace; font-variant-numeric: tabular-nums;
  background: rgba(128,128,128,.14);
}
.badge {
  display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px;
  border: 1px solid var(--borderc, #2b323f);
}
.badge.ok { color: #10b981; border-color: rgba(16,185,129,.5); }
.badge.warn { color: #f59e0b; border-color: rgba(245,158,11,.5); }
.badge.err { color: #ef4444; border-color: rgba(239,68,68,.5); }

.empty { padding: 36px 20px; text-align: center; color: var(--textcolor2, #79839a); }
pre.mono {
  font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap;
  word-break: break-all; max-height: 200px; overflow: auto;
  background: rgba(128,128,128,.08); border-radius: 5px; padding: 8px; margin: 6px 0 0;
}
.hint { color: var(--textcolor2, #79839a); font-size: 12px; }
.sectionline { height: 1px; background: var(--borderc, #2b323f); margin: 16px 0 12px; }
.sectiontitle {
  font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--textcolor2, #79839a); margin-bottom: 8px;
}

/* --- chat selection ------------------------------------------------------ */

.botcard { display: flex; gap: 12px; align-items: flex-start; }
.botportrait, .botinitials {
  width: 72px; height: 72px; border-radius: 8px; flex-shrink: 0;
  background: rgba(128,128,128,.12);
}
.botportrait { object-fit: cover; }
.botinitials {
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 700; color: var(--textcolor2, #79839a);
}
.botname { font-size: 15px; font-weight: 700; }
/* The background asset importer, under the bot's name on the picker. */
.assetsync { margin-top: 4px; }
/* The assets tab: a grid of thumbnails with the name under each, like RisuAI's. */
.assetgrid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; margin-bottom: 14px;
}
.assetcell {
  border: 1px solid var(--borderc, #2b323f); border-radius: 6px; padding: 6px; min-width: 0;
  display: flex; flex-direction: column; gap: 4px;
}
.assetcell.changed { border-color: rgba(245,158,11,.6); }
.assetcell.failed { border-color: rgba(239,68,68,.5); }
.assetpic {
  aspect-ratio: 1 / 1; border-radius: 4px; overflow: hidden; display: flex; align-items: center;
  justify-content: center; background: rgba(128,128,128,.08);
}
.assetpic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.assetname {
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.assetname.editable { cursor: text; }
.assetname.editable:hover { text-decoration: underline dotted; }
.assetrename { width: 100%; font-size: 12px; padding: 2px 4px; }
.assetmeta { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--textcolor2, #79839a); }
.assetmeta .tiny { margin-left: auto; padding: 0 5px; }
.assettype {
  display: inline-block; padding: 14px 18px; border-radius: 6px; font-size: 12px;
  color: var(--textcolor2, #79839a); background: rgba(128,128,128,.10);
}
/* The chevron that opens a preset list; the settings sections in the tab row. */
.chev { font-size: 20px; line-height: 1; padding: 2px 12px; }
.tabs .subtabs { display: flex; gap: 2px; align-items: center; }
.tabs .subtabs .subtab { padding: 8px 14px; }
.steps { margin: 6px 0 0 18px; padding: 0; }
.steps li { margin: 2px 0; }
.thinking .stopbtn { margin-left: 8px; }
/* A shell / pip request waiting on the user, inside the assistant bubble. */
.permit {
  border: 1px solid rgba(245,158,11,.6); border-radius: 6px; padding: 8px 10px; margin: 6px 0;
  background: rgba(245,158,11,.07);
}
.permit.allowed { border-color: rgba(16,185,129,.5); background: rgba(16,185,129,.06); }
.permit.denied { border-color: rgba(239,68,68,.5); background: rgba(239,68,68,.06); }
.permit-title { font-weight: 700; font-size: 12px; margin-bottom: 4px; }
.permit pre.mono { max-height: 140px; }
.settingsclose { margin-left: auto; }
.snaplist .verrow { padding: 4px 0; }
/* Folders in the files tree: a label row, files indented under it. */
.folderrow .folderlabel { cursor: default; color: var(--textcolor2, #79839a); }
.folderkids { margin-left: 14px; border-left: 1px solid rgba(128,128,128,.18); padding-left: 4px; }
/* API key form rows and the model catalog picker. */
.keyform { border: 1px dashed var(--borderc, #2b323f); border-radius: 6px; padding: 8px; margin: 6px 0; }
.keyform .row input { flex: 1; min-width: 120px; }
.catalogpop { width: min(520px, calc(100vw - 32px)); max-width: none; box-sizing: border-box; }
.catalogpop input { width: 100%; min-width: 0; box-sizing: border-box; }
.catalogpop .row { min-width: 0; }
.cataloglist { max-height: 320px; overflow-y: auto; margin-top: 6px; }
.catrow {
  display: flex; gap: 8px; width: 100%; text-align: left; padding: 5px 6px; border: none;
  background: transparent; border-radius: 4px; font-size: 12px;
}
.catrow:hover { background: rgba(128,128,128,.12); }
.assetline { gap: 8px; }
.assetline.err .hint { color: #ef4444; }
.assetline.warn .hint { color: #f59e0b; }
.assetbar {
  height: 3px; margin-top: 4px; border-radius: 2px; overflow: hidden;
  background: rgba(128,128,128,.18); max-width: 360px;
}
.assetfill { height: 100%; width: 0; background: #2563eb; transition: width .3s; }
.assetbar.indeterminate .assetfill {
  width: 30%; animation: assetslide 1.2s ease-in-out infinite alternate;
}
@keyframes assetslide { from { margin-left: 0; } to { margin-left: 70%; } }

.folder { margin-bottom: 4px; }
.folderhead {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  padding: 6px 8px; border: none; background: transparent; border-radius: 5px;
  color: var(--textcolor2, #79839a); font-size: 12px;
}
.folderhead:hover { background: rgba(128,128,128,.10); }
.folderdot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; background: #79839a; }
.folderbody { display: none; padding-left: 10px; }
.folderbody.open { display: block; }
/* On a desktop-width panel a borderless full-width row reads as prose, not a
   list: cap the width and rule every row so the chats read as chats. */
.chatlist, .folder {
  display: flex; flex-direction: column; max-width: 640px;
  border: 1px solid var(--borderc, #2b323f); border-radius: 6px; overflow: hidden;
}
.folder { display: block; margin-bottom: 6px; }
.chatlist { margin-bottom: 6px; }
.chatitem {
  display: flex; align-items: center; gap: 9px; padding: 8px 10px; cursor: pointer;
  border-bottom: 1px solid var(--borderc, #2b323f);
}
.chatlist .chatitem:last-child, .folderbody .chatitem:last-child { border-bottom: none; }
.chatitem:hover { background: rgba(128,128,128,.10); }
.chatitem.presetnow, .chatitem.current { background: rgba(37,99,235,.10); }
.chatitem .n { color: var(--textcolor2, #79839a); font-size: 11px; min-width: 40px; text-align: right; }

/* --- editor: explorer | turns | tools ------------------------------------ */

.split { display: flex; flex: 1; min-height: 0; width: 100%; }
/* Phone-only view switch (panes.ts); the mobile block below shows it. */
.mbar { display: none; }

/* A folded section inside a card: a summary line, the rest on demand. */
details.fold > summary {
  cursor: pointer; font-size: 12.5px; color: var(--textcolor2, #79839a); padding: 6px 8px;
  border: 1px dashed var(--borderc, #2b323f); border-radius: 6px; list-style: none;
}
details.fold > summary::before { content: '▸ '; }
details.fold[open] > summary::before { content: '▾ '; }
details.fold[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
details.fold > .foldbody {
  padding: 10px 10px 6px; border: 1px dashed var(--borderc, #2b323f); border-top: none;
  border-radius: 0 0 6px 6px;
}
.explorer {
  width: 118px; flex-shrink: 0; overflow-y: auto; padding: 6px 4px;
  border-right: 1px solid var(--borderc, #2b323f);
}
.expgroup {
  display: block; width: 100%; text-align: left; padding: 5px 8px; margin-bottom: 2px;
  border: none; background: transparent; border-radius: 5px; font-size: 12px;
  color: var(--textcolor2, #79839a); font-variant-numeric: tabular-nums;
}
.expgroup:hover { background: rgba(128,128,128,.12); }
.expgroup.on { background: rgba(37,99,235,.18); color: var(--textcolor, #d8dce4); }
.expmark { font-size: 10px; margin-left: 5px; }

.left {
  flex: 1; min-width: 260px; display: flex; flex-direction: column; position: relative;
  /* Lifted off the surrounding panels: the transcript is the subject, the
     explorer and tools are chrome around it. */
  background: rgba(255, 255, 255, .035);
}
/* The agent takes half the width by default: the conversation is where the
   work happens and 380px wrapped every sentence of it. */
.right { flex: 0 0 50%; min-width: 250px; display: flex; flex-direction: column; }
/* touch-action: none is what makes the drag work on a phone - without it the
   browser claims the touch for scrolling and fires pointercancel at once. */
.gutter { flex: 0 0 5px; cursor: col-resize; background: var(--borderc, #2b323f); opacity: .45; touch-action: none; }
.gutter.leftside { flex-basis: 4px; }
.gutter:hover, .gutter.dragging { opacity: 1; background: #2563eb; }

.toolrow {
  display: flex; align-items: center; gap: 3px; padding: 6px 8px; flex-wrap: wrap;
  border-bottom: 1px solid var(--borderc, #2b323f); flex-shrink: 0;
}
.toolrow .sep { width: 1px; height: 18px; background: var(--borderc, #2b323f); margin: 0 4px; }
button.tool {
  display: flex; align-items: center; gap: 5px; padding: 4px 8px;
  background: transparent; border-color: transparent;
}
button.tool:hover:not(:disabled) { background: rgba(128,128,128,.12); }
button.tool.on { background: rgba(37,99,235,.18); }
button.tool .glyph { font-size: 14px; line-height: 1; }
button.tool .tool-label { font-size: 12px; }
button.iconbtn { padding: 4px 8px; background: transparent; border-color: transparent; font-size: 14px; }
button.iconbtn:hover:not(:disabled) { background: rgba(128,128,128,.14); }

.scroller { flex: 1; overflow-y: auto; position: relative; }
.spacerTop, .spacerBottom { width: 100%; }

.turn { padding: 8px 12px; border-bottom: 1px solid rgba(128,128,128,.10); }
.turn.changed { background: rgba(37, 99, 235, .06); }
.turn.isnew { background: rgba(16, 185, 129, .06); }
.turn.preview { background: rgba(245, 158, 11, .07); }
.turn.doomed { background: rgba(239, 68, 68, .09); opacity: .7; }
.turn.doomed .turn-body { text-decoration: line-through; }
.turn-head {
  display: flex; gap: 8px; align-items: center; color: var(--textcolor2, #79839a);
  font-size: 11px; margin-bottom: 3px;
}
.turn-head .spacer { flex: 1; }
.turn-no {
  /* Tabular figures and a fixed min-width so the numbers form a column: a
     ragged left edge makes a 394-turn list much harder to scan. */
  min-width: 30px; padding: 1px 5px; border-radius: 4px; text-align: right;
  font-family: Consolas, monospace; font-variant-numeric: tabular-nums;
  font-size: 11px; font-weight: 700;
  background: rgba(128,128,128,.16); color: var(--textcolor, #d7dce6);
}
.turn.changed .turn-no { background: rgba(37, 99, 235, .32); }
.turn.isnew .turn-no { background: rgba(16, 185, 129, .30); }
.turn.doomed .turn-no { background: rgba(239, 68, 68, .30); }
.turn-role { font-weight: 700; }
.turn-role.user { color: #7dd3fc; }
.turn-role.char { color: #fbbf24; }
.turn-body { white-space: pre-wrap; word-break: break-word; }
/* Speech and inner thought, the two the logs actually mark. The card's own
   regexes do this on the chat screen; the stored text is flat without it. */
.speech { color: #f0a04b; }
.thought { color: #7dd3fc; }
.turn-body.raw { font-family: Consolas, monospace; font-size: 12px; color: var(--textcolor2, #9aa4b8); }
.turn-body img.turn-img { max-width: 100%; max-height: 320px; border-radius: 5px; margin: 4px 0; }
/* Space images in markdown (agent bubbles, viewers). */
.wsimg img { max-width: 100%; border-radius: 5px; margin: 4px 0; }
.wsimg.thumb img { max-height: 180px; }

/* The artifact viewer: an overlay over the CENTRE pane only - the left
   column and the agent stay usable while it is open. */
.split > .left { position: relative; }
.artifactview {
  position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column;
  background: var(--darkbg, #171717); border-left: 1px solid var(--borderc, #444);
}
.artifacthead {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--borderc, #444);
}
.artifacttitle { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifactbody { flex: 1; overflow: auto; padding: 12px 16px; }
.artifactbody img { max-width: 100%; }
.artifactchip { text-align: left; }

/* A strip of fresh images in the agent log. */
.imgstrip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0; }
.imgstrip .wsimg img { max-height: 72px; border-radius: 6px; margin: 0; }
.turn textarea { min-height: 90px; }
.diff-del { background: rgba(239, 68, 68, .22); text-decoration: line-through; }
.diff-ins { background: rgba(16, 185, 129, .22); }
.before-label { color: var(--textcolor2, #79839a); font-size: 11px; margin-top: 4px; }
button.tiny { padding: 1px 7px; font-size: 11px; border-radius: 4px; }
button.iconbtn.tiny { padding: 2px 4px; display: inline-flex; align-items: center; }

/* The turn editor. Tall on purpose - a turn is often a screen of prose, and
   the whole reason this left the row is that a few lines were not enough. */
.turneditwrap { display: flex; flex-direction: column; }
textarea.turnedit {
  min-height: 46vh; max-height: 62vh; line-height: 1.7; font-size: 13px;
  resize: vertical;
}

.filterbar {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  padding: 5px 12px; font-size: 11.5px;
  background: rgba(245, 158, 11, .12);
  border-bottom: 1px solid rgba(245, 158, 11, .3);
  color: var(--textcolor, #d7dce6);
}
.filterbar .spacer { flex: 1; }
.rangerow { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
.rangerow input { width: 74px; text-align: center; }

/* --- files · presets · skills --------------------------------------------- */
.filerow {
  display: flex; align-items: center; gap: 8px; padding: 3px 0;
  border-bottom: 1px solid rgba(128,128,128,.08);
}
.filerow:last-child { border-bottom: none; }
button.linkish {
  flex: 1; min-width: 0; padding: 2px 0; border: none; background: none;
  text-align: left; color: var(--textcolor, #d7dce6); font-size: 12px;
  font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; border-radius: 0;
}
button.linkish:hover { color: #7dd3fc; text-decoration: underline; }
.filepreview {
  max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-size: 11.5px; line-height: 1.5;
}
.presetrow, .skillrow {
  padding: 7px 0; border-bottom: 1px solid rgba(128,128,128,.10);
  display: flex; align-items: center; gap: 6px;
}
.skillrow { display: block; }
.presetrow:last-child, .skillrow:last-child { border-bottom: none; }
.presetrow .grow { flex: 1; min-width: 0; }
.skillbody {
  margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* --- settings sub-tabs ---------------------------------------------------- */
.settingswrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.subtabs {
  display: flex; gap: 2px; padding: 0 12px; flex-shrink: 0; flex-wrap: wrap;
  border-bottom: 1px solid var(--borderc, #2b323f);
}
.subtab {
  padding: 7px 13px; border: none; background: none; border-radius: 0; font-size: 12px;
  color: var(--textcolor2, #79839a); border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.subtab.active { color: var(--textcolor, #d8dce4); border-bottom-color: #2563eb; font-weight: 700; }
.subpane { display: none; }
.subpane.active { display: block; }

/* --- tree (files · lorebook · memory) ------------------------------------- */
.tree { display: flex; flex-direction: column; gap: 1px; padding: 4px; min-width: 0; }
.treehead, .treefoot {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  padding: 5px 4px; border-bottom: 1px solid var(--borderc, #2b323f);
}
.treefoot { border-bottom: none; border-top: 1px solid var(--borderc, #2b323f); margin-top: 6px; }
.treescope {
  padding: 7px 5px 3px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--textcolor2, #79839a);
}
.treebranch {
  display: flex; align-items: center; gap: 5px; width: 100%;
  padding: 4px 6px; border: none; background: transparent; border-radius: 5px;
  font-size: 12px; color: var(--textcolor, #d8dce4); text-align: left;
}
.treebranch:hover { background: rgba(128,128,128,.12); }
.treekids { padding-left: 9px; }
.treerow { display: flex; align-items: center; gap: 3px; }
button.treefile {
  flex: 1; min-width: 0; padding: 3px 6px; border: none; background: transparent;
  border-radius: 5px; text-align: left; font-size: 12px;
  color: var(--textcolor2, #9aa4b8);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
button.treefile:hover { background: rgba(128,128,128,.12); color: var(--textcolor, #d8dce4); }
button.treefile.on { background: rgba(37, 99, 235, .22); color: var(--textcolor, #d8dce4); }

/* The tree column is wider than the turn explorer: file and entry names are
   words, not two-digit ranges. */
.explorer:has(.tree) { width: 210px; }
/* The studio's left column carries the generation card under the tree, so it
   needs room for labelled fields rather than just folder names. */
.explorer:has(.studiotabs) { width: 300px; }
.scenerow { display: flex; flex-direction: column; gap: 4px; padding: 8px 0;
            border-bottom: 1px solid rgba(128,128,128,.12); }
.advbox { margin: 10px 0; }
.advbox summary { cursor: pointer; font-size: 12px; opacity: .7; margin-bottom: 6px; }
.assetpic { position: relative; }
.foldertag { position: absolute; right: 4px; bottom: 4px; font-size: 14px;
             filter: drop-shadow(0 0 2px rgba(0,0,0,.6)); }
.scenerow .row input[type=number] { width: 74px; flex: none; }
textarea.promptedit { width: 100%; box-sizing: border-box; min-height: 42vh; font-family: var(--mono, monospace); }

/* --- the comparison selector ---------------------------------------------- */
/* Column count is set inline (2..6) because it is the user's control, not a
   breakpoint: how many candidates fit side by side is a judgement about the
   pictures, not about the window. */
.selgrid { display: grid; gap: 8px; }
.selcell { border: 2px solid transparent; border-radius: 6px; padding: 4px; }
/* The three states have to be readable at a glance across a wall of thumbnails,
   so they are borders and not badges. */
.selcell.picked   { border-color: var(--ok, #34d399); }
.selcell.fixing   { border-color: var(--warn, #fbbf24); }
.selcell.dropping { border-color: var(--err, #f87171); opacity: .45; }
.selflags { gap: 4px; justify-content: center; margin-top: 4px; }
.selflags button.on { background: var(--accent, #6366f1); color: #fff; }
.selcell .assetpic { cursor: pointer; }

/* --- modal ---------------------------------------------------------------- */
.modalback {
  position: fixed; inset: 0; z-index: 90; display: flex;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(0, 0, 0, .55);
}
.modalbox {
  display: flex; flex-direction: column; width: 100%; max-width: 460px;
  max-height: 100%; border-radius: 9px;
  background: var(--bgcolor, #12141a);
  border: 1px solid var(--borderc, #2b323f);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .5);
}
.modalbox.wide { max-width: 620px; }
.modalhead {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  padding: 11px 14px; border-bottom: 1px solid var(--borderc, #2b323f);
}
.modalhead h2 {
  margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--textcolor2, #79839a);
}
.modalbody { padding: 14px; overflow-y: auto; }
.modalbody .card { border: none; padding: 0; margin-bottom: 0; }

/* One row per preset or skill inside a picker. */
.pickrow {
  display: flex; align-items: center; gap: 8px; padding: 8px 4px;
  border-bottom: 1px solid rgba(128,128,128,.10);
}
.pickrow:last-child { border-bottom: none; }
.pickrow.on { background: rgba(37, 99, 235, .12); border-radius: 5px; }
/* A disabled skill is still stored - dimmed, not hidden. */
.pickrow.off .pickname { opacity: .55; }
.pickrow input[type=checkbox] { width: auto; flex-shrink: 0; }
.pickrow .grow { flex: 1; min-width: 0; cursor: pointer; }
.pickname { display: flex; align-items: center; gap: 6px; }

/* The one preset the agent is actually using. */
.presetnow {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 11px; border-radius: 6px; margin-bottom: 9px;
  background: rgba(37, 99, 235, .10);
  border: 1px solid rgba(37, 99, 235, .30);
}
.presetnow .grow { min-width: 0; }
.presetnow-name { font-weight: 700; }

.field select {
  width: 100%; padding: 6px 8px; border-radius: 5px; font-size: 12px;
  background: var(--bgcolor, #1a1f27); color: var(--textcolor, #d7dce6);
  border: 1px solid var(--borderc, #2b323f);
}

/* --- right panel --------------------------------------------------------- */

.right-inner { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.rtabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--borderc, #2b323f); flex-shrink: 0; }
.rtab {
  padding: 7px 13px; border: none; background: none; border-radius: 0; font-size: 12px;
  color: var(--textcolor2, #79839a); border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.rtab.active { color: var(--textcolor, #d8dce4); border-bottom-color: #2563eb; font-weight: 700; }
.rpanel { display: none; min-height: 0; }
.rpanel.active { display: block; overflow-y: auto; }
.rpanel.agentwrap.active { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

button.modebtn {
  display: block; width: 100%; text-align: left; margin-bottom: 5px;
  background: transparent; border-color: var(--borderc, #2b323f);
}
button.modebtn.on { border-color: #2563eb; background: rgba(37, 99, 235, .12); }
button.modebtn.todo { opacity: .55; }
label.checkrow { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 12px; }
label.checkrow input { width: auto; }

.popover {
  position: fixed; z-index: 200; min-width: 280px; max-width: 380px;
  max-height: 340px; overflow-y: auto; padding: 8px;
  background: var(--darkbg, #171b23); border: 1px solid var(--borderc, #2b323f);
  border-radius: 7px; box-shadow: 0 12px 32px rgba(0,0,0,.5);
}
.verrow, .sessrow { display: flex; align-items: center; gap: 8px; padding: 6px 4px; }
.verrow + .verrow, .sessrow + .sessrow { border-top: 1px solid rgba(128,128,128,.12); }
.sessrow { cursor: pointer; }
.sessrow:hover { background: rgba(128,128,128,.10); }

/* --- agent ---------------------------------------------------------------
 *
 * The agent column sits on a slightly lifted ground of its own. The three
 * panels were all the same dark, so the boundary between "the transcript" and
 * "the conversation about the transcript" had to be inferred from the content.
 * --darkbg is PocketRisu's own second surface, so this follows the host theme
 * rather than inventing a colour that only suits one of them.
 */
.agentwrap { flex: 1; min-height: 0; }
.agentpanel {
  display: flex; flex-direction: column; height: 100%; padding: 8px 10px; gap: 7px;
  background: var(--darkbg, rgba(255, 255, 255, .022));
}
.right { background: var(--darkbg, rgba(255, 255, 255, .022)); }
.agenthead { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.agentlog { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 9px; }
.bubble { border-radius: 6px; padding: 7px 10px; }
.bubble.user { background: rgba(37, 99, 235, .12); }
.bubble.assistant { background: rgba(255, 255, 255, .05); }
.bubble.note { background: transparent; border: 1px dashed rgba(255, 255, 255, .18); font-size: 12px; opacity: .85; }
.bubble.note.ok { border-color: rgba(34, 197, 94, .5); }
.bubble.note.err { border-color: rgba(239, 68, 68, .5); }
.bubble-body { white-space: pre-wrap; word-break: break-word; }
.costline { margin-top: 5px; font-size: 11px; color: var(--textcolor2, #79839a); }
.trace { margin-bottom: 5px; display: flex; flex-wrap: wrap; gap: 4px; }
.tchip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px;
  border-radius: 4px; font-size: 11px; background: rgba(128,128,128,.14);
  color: var(--textcolor2, #79839a);
}
.tchip .tx { color: #7dd3fc; font-weight: 700; }
.agentcompose { display: flex; gap: 6px; align-items: flex-end; flex-shrink: 0; }
/* One line taller than it was: two lines of Korean plus room to see a third
   coming, which is about the length of a real instruction here. The box is
   the flexible part and may shrink below its content: with width:100% and no
   min-width it kept its size when the panel was dragged narrow and pushed
   the send button out of the visible column. */
.agentinput {
  flex: 1 1 auto; min-width: 0; width: auto; max-width: 100%; min-height: 82px; max-height: min(220px, 40vh);
  background: var(--bgcolor, #12141a);
  /* Height only. The default handle also drags the width, and a box pulled
     wider than its column pushed the attach and send buttons off the panel. */
  resize: vertical;
}
.agentinput.dropping { border-color: #7dd3fc; background: rgba(125, 211, 252, .08); }
button.sendbtn { padding: 9px 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
/* Attach above send, in a column beside the box. */
.agentbtns { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; justify-content: flex-end; }
.agentbtns button { width: 42px; justify-content: center; }
/* --- merge conflicts -------------------------------------------------------
   Red rather than the ordinary amber "수정": an edit badge says "this will be
   written", a conflict badge says "this cannot be written until you choose". */
.badge.conflict { background: rgba(239, 68, 68, .18); border-color: rgba(239, 68, 68, .55); color: #fca5a5; }
.tabbadge.conflict { background: rgba(239, 68, 68, .22); border-color: rgba(239, 68, 68, .6); }
.conflictbox {
  border: 1px solid rgba(239, 68, 68, .45); border-radius: 7px; padding: 8px 10px; margin: 8px 0;
  background: rgba(239, 68, 68, .06);
}
.conflicthead { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.conflictrow { border-top: 1px solid var(--borderc, #2b323f); padding-top: 8px; margin-top: 8px; }
.conflictname { font-size: 12.5px; color: var(--textcolor2, #79839a); margin-bottom: 4px; }

/* A snapshot row whose delete is on its way to the backend. */
.verrow.deleting, .chatitem.deleting { opacity: .4; }

/* --- 집중 편집: one text box, the whole screen ------------------------------ */
.modalbox.focusmodal { max-width: none; width: calc(100vw - 48px); height: calc(100vh - 48px); }
.modalbox.focusmodal .modalbody { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.focusbody { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 8px; }
textarea.focusarea { flex: 1; min-height: 0; resize: none; font-size: 14px; line-height: 1.7; }
textarea.focusarea.codearea { font-size: 12.5px; line-height: 1.55; }
.focusfoot { flex-shrink: 0; }
.card h2 .focusbtn { text-transform: none; letter-spacing: 0; font-weight: 400; }
.card h2 { display: flex; align-items: center; gap: 8px; }

/* --- line diff: an IDE's margin, on the material the panel edits ------------- */
.diffcard { margin: 2px 0 10px; }
.diffbody { margin-top: 6px; }
.diffview {
  border: 1px solid var(--borderc, #2b323f); border-radius: 5px; overflow: auto;
  max-height: 440px; font-size: 12px;
}
.diffview.code { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: 11.5px; }
.diffsum {
  display: flex; gap: 6px; align-items: center; padding: 4px 8px; font-size: 11px;
  border-bottom: 1px solid var(--borderc, #2b323f); position: sticky; top: 0;
  background: var(--bgcolor, #12141a);
}
.diff-ins-n { color: #10b981; font-weight: 700; }
.diff-del-n { color: #ef4444; font-weight: 700; }
.diffline { display: flex; line-height: 1.55; border-left: 3px solid transparent; }
.diffline.ins { background: rgba(16, 185, 129, .13); border-left-color: #10b981; }
.diffline.del { background: rgba(239, 68, 68, .13); border-left-color: #ef4444; }
.diffmark {
  width: 20px; flex-shrink: 0; text-align: center; user-select: none;
  color: var(--textcolor2, #79839a); font-family: Consolas, monospace;
}
.diffline.ins .diffmark { color: #10b981; }
.diffline.del .diffmark { color: #ef4444; }
.difftext { white-space: pre-wrap; word-break: break-word; flex: 1; padding-right: 8px; }
.diffskip {
  padding: 2px 8px; font-size: 11px; text-align: center;
  color: var(--textcolor2, #79839a); background: rgba(128,128,128,.08);
}
.diffmeta { margin: -4px 0 8px; }

/* --- workspace files: tree | list · grid ------------------------------------ */
.filetree .treerow { gap: 0; }
.filetree .treebranch { padding: 3px 6px; gap: 4px; }
.filetree .treebranch.on { background: rgba(37, 99, 235, .22); color: var(--textcolor, #d8dce4); }
.filetree .treebranch.dropping { outline: 2px dashed #7dd3fc; outline-offset: -2px; }
.filetree .treekids { padding-left: 12px; }
.filetree .caret {
  width: 16px; flex-shrink: 0; padding: 0; border: none; background: transparent;
  color: var(--textcolor2, #79839a); font-size: 10px; text-align: center;
}
.filetree .treebranch { overflow: hidden; }
.filetree .treebranch .n {
  flex-shrink: 0; margin-left: auto; padding: 0 6px; border-radius: 9px;
  font-size: 11px; font-variant-numeric: tabular-nums; line-height: 16px;
  color: var(--textcolor, #d8dce4); background: rgba(128,128,128,.22);
}
.filetree .treebranch.on .n { background: rgba(37, 99, 235, .45); }
.frow .ftag {
  display: inline-block; min-width: 34px; margin-right: 7px; padding: 0 4px; border-radius: 3px;
  font-family: Consolas, monospace; font-size: 10px; text-align: center; line-height: 15px;
  color: var(--textcolor2, #79839a); background: rgba(128,128,128,.16);
}
.filebar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.filecrumb { font-weight: 700; font-family: Consolas, monospace; font-size: 12.5px; }
.filehint { font-size: 11px; color: var(--textcolor2, #79839a); margin-bottom: 6px; }
.filelist { outline: none; border: 1px solid var(--borderc, #2b323f); border-radius: 6px; min-height: 220px; }
.filelist:focus-within { border-color: rgba(37, 99, 235, .55); }
.filelist.dropping, .pad.dropping .filelist { outline: 2px dashed #7dd3fc; outline-offset: -2px; background: rgba(125, 211, 252, .06); }
.frow {
  display: grid; grid-template-columns: 22px 1fr 76px 118px; gap: 8px; align-items: center;
  padding: 5px 8px; border-bottom: 1px solid rgba(128,128,128,.08); font-size: 12px; user-select: none;
}
.frow:last-child { border-bottom: none; }
.frow:hover { background: rgba(128,128,128,.08); }
.frow.sel { background: rgba(37, 99, 235, .18); }
.frow.head {
  font-size: 10.5px; color: var(--textcolor2, #79839a); font-weight: 700;
  text-transform: uppercase; letter-spacing: .04em; background: rgba(128,128,128,.05);
}
.frow .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow .fname .ficon { margin-right: 5px; }
.frow .fsize { text-align: right; font-variant-numeric: tabular-nums; color: var(--textcolor2, #79839a); }
.frow .ftime { color: var(--textcolor2, #79839a); font-variant-numeric: tabular-nums; font-size: 11px; }
.frow input[type=checkbox] { width: auto; margin: 0; }
.fgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; padding: 10px; }
.fcell {
  border: 1px solid var(--borderc, #2b323f); border-radius: 6px; padding: 6px;
  display: flex; flex-direction: column; gap: 4px; user-select: none; min-width: 0;
}
.fcell:hover { background: rgba(128,128,128,.06); }
.fcell.sel { border-color: #2563eb; background: rgba(37, 99, 235, .12); }
.fcell .fname { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fcell .fsize { font-size: 10px; color: var(--textcolor2, #79839a); }
.confirmbar {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 10px;
  border-radius: 5px; background: rgba(239, 68, 68, .12); margin-bottom: 8px; font-size: 12px;
}
.uploadprog { font-size: 12px; margin-bottom: 8px; color: var(--textcolor2, #79839a); }
.zipask {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 10px;
  border-radius: 5px; background: rgba(125, 211, 252, .1); margin-bottom: 8px; font-size: 12px;
}
.fpreview img { max-width: 100%; max-height: 70vh; border-radius: 5px; display: block; }
.fempty { padding: 28px 16px; text-align: center; color: var(--textcolor2, #79839a); font-size: 12px; }
@media (max-width: 760px) {
  .frow { grid-template-columns: 22px 1fr 70px; }
  .frow .ftime { display: none; }
  .modalbox.focusmodal { width: 100%; height: 100%; }
}
button.attachbtn { padding: 8px 9px; display: flex; align-items: center; flex-shrink: 0; }

.attachbar { display: flex; flex-wrap: wrap; gap: 5px; flex-shrink: 0; }
.attachchip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
  padding: 2px 4px 2px 8px; border-radius: 5px; font-size: 11.5px;
  background: rgba(125, 211, 252, .14); border: 1px solid rgba(125, 211, 252, .3);
}
.attachchip > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachchip.bad { background: rgba(239, 68, 68, .14); border-color: rgba(239, 68, 68, .35); }
.stagedbox { flex-shrink: 0; max-height: 42%; overflow-y: auto; }
.card.staged { border-color: rgba(245,158,11,.45); background: rgba(245,158,11,.06); }
.stagedrow { display: flex; gap: 8px; align-items: center; padding: 3px 0; flex-wrap: wrap; }
.stagedrow .grow { flex: 1; min-width: 120px; }

/* An empty conversation, saying what to ask for. */
.welcome { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
.welcome-title { font-weight: 700; font-size: 13px; }
.welcome-foot { margin-top: 4px; }
button.exbtn {
  display: flex; align-items: flex-start; gap: 7px; width: 100%; text-align: left;
  padding: 8px 10px; font-size: 12px; line-height: 1.5;
  background: rgba(255, 255, 255, .045);
  border: 1px solid var(--borderc, #2b323f);
}
button.exbtn:hover:not(:disabled) { border-color: #2563eb; filter: none; background: rgba(37, 99, 235, .12); }
.exmark { color: #7dd3fc; flex-shrink: 0; }

/* --- markdown in agent replies ------------------------------------------- */
.md-p { margin: 0 0 6px; }
.md-p:last-child { margin-bottom: 0; }
.md-tablewrap { overflow-x: auto; margin: 4px 0 8px; }
.md-table { border-collapse: collapse; font-size: 12px; min-width: 50%; }
.md-table th, .md-table td { border: 1px solid rgba(128,128,128,.3); padding: 3px 7px; text-align: left; vertical-align: top; }
.md-table th { background: rgba(255,255,255,.06); font-weight: 600; }
.md-table td.num, .md-table th.num { text-align: right; }
.md-table td.mid, .md-table th.mid { text-align: center; }
.snaplist { margin: 6px 0 4px; }
.verrow .badge.modechip { background: var(--accent, #7c5cff); color: #fff; opacity: .85; }
.badge.now { background: rgba(37, 99, 235, .25); }
.md-h { font-weight: 700; margin: 8px 0 4px; }
.md-h1 { font-size: 15px; }
.md-h2 { font-size: 14px; }
.md-h3, .md-h4 { font-size: 13px; color: var(--textcolor2, #9aa4b8); }
.md-list { margin: 4px 0 6px; padding-left: 20px; }
.md-list li { margin-bottom: 2px; }
.md-quote {
  margin: 4px 0 6px; padding: 2px 0 2px 10px;
  border-left: 2px solid rgba(128,128,128,.4); color: var(--textcolor2, #9aa4b8);
}
.md-code {
  margin: 5px 0; padding: 8px; border-radius: 5px; overflow-x: auto;
  background: rgba(0,0,0,.28); font-family: Consolas, monospace; font-size: 11.5px;
}
.md-code code { white-space: pre; }
.md-inline-code {
  padding: 1px 4px; border-radius: 3px; background: rgba(128,128,128,.2);
  font-family: Consolas, monospace; font-size: 12px;
}
.md-hr { border: none; border-top: 1px solid var(--borderc, #2b323f); margin: 8px 0; }

/* --- thinking indicator --------------------------------------------------- */
.thinking { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.elapsed {
  font-family: Consolas, monospace; font-variant-numeric: tabular-nums;
  font-size: 11px; color: var(--textcolor2, #79839a);
  padding: 0 5px; border-radius: 4px; background: rgba(128,128,128,.14);
}
.elapsed.done { background: transparent; padding: 0; }
.dots.stopped i { animation: none; opacity: .2; }
.thinkingtext { font-size: 11px; color: var(--textcolor2, #79839a); }
.dots { display: inline-flex; gap: 3px; }
.dots i {
  width: 5px; height: 5px; border-radius: 50%; background: #7dd3fc;
  animation: blink 1.1s infinite ease-in-out;
}
.dots i:nth-child(2) { animation-delay: .18s; }
.dots i:nth-child(3) { animation-delay: .36s; }
@keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

/* --- narrow screens -------------------------------------------------------
 *
 * Pocket RisuAI on a phone gets the same panel, and two things broke there:
 * the agent column sat off the right edge because the split is horizontal, and
 * wide fields in the settings pushed the page sideways.
 *
 * The split stacks instead of shrinking. That ordering is deliberate - on a
 * phone the agent is the thing being used and the transcript is the thing being
 * checked, so the transcript takes what is left rather than the other way
 * round. The same gutter still resizes, just vertically (see splitter.ts).
 */
.mtoggle { display: none; }
@media (max-width: 760px) {
  .split { flex-direction: column; position: relative; }

  /* One view at a time (panes.ts): the agent, or the explorer + editor.
     Drags set flex-basis inline, so the shown side must win with !important. */
  .split .gutter { display: none; }
  .split.m-agent > .explorer, .split.m-agent > .left { display: none; }
  .split.m-centre > .right { display: none; }
  .split.m-agent > .right { flex: 1 1 auto !important; min-height: 0; }
  .split.m-centre > .left { flex: 1 1 auto !important; }

  /* The view switch is a bar across the top of the split, not a floating
     pill: the pill sat on the attach and send buttons in the agent view and
     its label named the *other* view, which read as the current one. Two
     segments, the lit one is where you are. */
  .mbar {
    display: flex; align-items: center; gap: 6px; padding: 5px 8px; flex-shrink: 0;
    border-bottom: 1px solid var(--borderc, #2b323f); background: rgba(255, 255, 255, .03);
  }
  .mbar .mseg { display: flex; border: 1px solid var(--borderc, #2b323f); border-radius: 6px; overflow: hidden; }
  .mbar .mseg button {
    border: none; border-radius: 0; padding: 5px 13px; font-size: 12px; background: transparent;
    color: var(--textcolor2, #79839a);
  }
  .mbar .mseg button.on { background: rgba(37, 99, 235, .28); color: var(--textcolor, #d8dce4); font-weight: 700; }
  .mbar .mlist { margin-left: auto; font-size: 12px; padding: 4px 10px; }
  .split.m-agent .mbar .mlist { display: none; }

  /* The explorer becomes a scrolling strip of jump targets across the top
     rather than a column eating a third of a 390px screen. */
  .explorer {
    /* The base rule is a block column; a strip has to say it is a flex row. */
    display: flex; flex-direction: row; align-items: center;
    width: auto; max-width: none; flex-shrink: 0;
    overflow-x: auto; overflow-y: hidden;
    border-right: none; border-bottom: 1px solid var(--borderc, #2b323f);
    padding: 5px 8px; gap: 5px;
  }
  .tree { padding: 2px; }
  /* A tree (lorebook, meta fields, regex...) is a list, not a strip: it
     scrolls vertically, starts short so the entry below it gets the screen,
     and the bar's 목록 button opens it to most of the height. It was pinned
     at 190px with overflow hidden - the fifth item on was unreachable. */
  .explorer:has(.tree) { display: block; width: auto; max-height: 150px; overflow-y: auto; overflow-x: hidden; }
  .split.m-list > .explorer:has(.tree) { max-height: 62%; }
  .explorer:has(.tree) .tree { width: 100%; }

  /* One line of status. The pill wrapped to three lines on a phone and took
     80px of a screen that has none to spare. */
  header .status { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; }
  header .status > * { white-space: nowrap; }
  .status .botname { display: none; }
  .explorer .expgroup {
    flex-shrink: 0; width: auto; min-width: 72px; margin-bottom: 0;
    white-space: nowrap;
  }

  .left { min-width: 0; min-height: 120px; }
  /* flex-basis is set inline by the drag, so height must not be pinned here -
     these only decide who yields when there is not enough room. */
  .right { min-width: 0; flex-basis: 55%; min-height: 180px; }

  .gutter {
    width: auto; height: 7px; cursor: row-resize;
    background-image: linear-gradient(to right, transparent 42%,
      rgba(190,200,215,.35) 42%, rgba(190,200,215,.35) 58%, transparent 58%);
  }

  /* The tool row wraps instead of scrolling off the edge. */
  .toolrow { flex-wrap: wrap; row-gap: 4px; }
  .toolrow .spacer { flex-basis: 100%; height: 0; }
  .tool-label { display: none; }

  header { padding: 7px 10px; gap: 6px; }
  header h1 span { display: none; }
  .status .chatname { display: none; }
  .tab { padding: 8px 11px; }
  .pad { padding: 10px; }

  /* Nothing may push the page sideways. Rows become columns and every control
     is allowed to shrink below its content width - a fixed-width input in a
     flex row is what put the settings fields past the right edge. */
  .row { flex-wrap: wrap; }
  .row > * { min-width: 0; }
  .rangerow input { width: 64px; }
  .field select, .field input, .field textarea { max-width: 100%; }
  .modalback { padding: 0; }
  .modalbox, .modalbox.wide { max-width: none; height: 100%; border-radius: 0; }
  .filepreview { font-size: 11px; }
  .pickrow { flex-wrap: wrap; row-gap: 4px; }
  .pickrow .grow { flex-basis: 100%; }
}

/* Belt and braces: whatever the width, the panel itself never scrolls
   sideways. A single over-wide child used to take the whole page with it. */
.wrap { overflow-x: hidden; }
.pad { overflow-x: hidden; }

/* Checkboxes, once, at the end so it wins the width:100% + padding that the
   generic input rule (and .genform input) hand every <input>. A checkbox
   the size of a text field floating mid-row was the complaint. */
input[type=checkbox] {
  width: auto; min-width: 0; padding: 0; margin: 0;
  flex: none; accent-color: #2563eb;
}
label.row { align-items: center; gap: 6px; }
.pickrow { align-items: flex-start; }
.pickrow input[type=checkbox] { margin-top: 3px; }

/* --- the studio's left tabs, collapse rails, and inline editors ------------------ */
/* Tabs LOOK like tabs: a flat horizontal strip on a baseline rule, the active
   one underlined in accent - not bordered boxes a form or a button would
   wear. The strip never wraps into a column. */
.tabstrip {
  display: flex; flex-direction: row; flex-wrap: nowrap; align-items: flex-end;
  gap: 2px; border-bottom: 1px solid var(--borderc, #2b323f); min-width: 0;
}
.tabstrip .tab {
  flex: 0 1 auto; min-width: 0; width: auto; padding: 5px 12px;
  border: none; background: transparent; border-radius: 6px 6px 0 0;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  color: var(--textcolor2, #79839a); font-size: 13px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.tabstrip .tab:hover { color: var(--textcolor, #d8dce4); background: rgba(128, 128, 128, .08); }
.tabstrip .tab.on {
  color: var(--textcolor, #d8dce4); font-weight: 700;
  border-bottom-color: #2563eb;
}
.tabstrip .grow { flex: 1 1 0; min-width: 0; }
.tabstrip .railbtn { flex: 0 0 auto; padding: 1px 6px; font-size: 12px; margin-bottom: 3px; }
.studiotabs { padding: 6px 6px 0; }
.centretabs { margin-bottom: 10px; }

/* Collapsed rails: the pane and its gutter vanish, a slim strip stays so the
   panel can be found again. */
.split.lcollapse > .explorer, .split.lcollapse > .gutter.leftside { display: none; }
.split.rcollapse > .right, .split.rcollapse > .gutter:not(.leftside) { display: none; }
.panelrail {
  display: none; flex: 0 0 26px; flex-direction: column; align-items: center;
  gap: 10px; padding: 8px 0; border: 1px solid var(--borderc, #2b323f);
  border-radius: 6px; background: var(--darkbg, #171a21);
}
.split.lcollapse > .panelrail.lrail { display: flex; }
.split.rcollapse > .panelrail.rrail { display: flex; }
.panelrail button { padding: 1px 6px; }
.panelrail .vlabel { writing-mode: vertical-rl; font-size: 11px; opacity: .55; letter-spacing: 2px; white-space: nowrap; }

/* The tool buttons under the style editor (캐릭터 · 조각). */
.toolbtns { display: flex; gap: 6px; padding: 6px 8px; }
.toolbtns .toolbtn { flex: 1; padding: 7px 6px; display: flex; align-items: center; justify-content: center; gap: 6px; }

/* The selected style, edited in place in the left column. */
.styleedit { padding: 4px 8px 0; }
.styleedit textarea { width: 100%; box-sizing: border-box; resize: vertical; }
.styleedit .field { display: block; margin-bottom: 6px; }
.styleedit .field > span { display: block; font-size: 11px; opacity: .7; margin-bottom: 2px; }
div.field > span:first-child { display: block; font-size: 11px; opacity: .7; margin-bottom: 2px; }
div.field { min-width: 0; }

/* The character editor hosted inside the left column. */
.charinline { margin: 0 4px 8px 4px; padding: 0 4px; }
.charinline textarea, .charinline input, .charinline select { width: 100%; box-sizing: border-box; }
.charinline input[type=checkbox], .charinline input[type=file], .charinline input[type=range] { width: auto; }
/* Left-column editors must be able to SHRINK: promptedit's 42vh floor is for
   the centre's full-page editors, and it made the column a scroll hunt. */
textarea.promptedit.compact, .styleedit textarea.promptedit { min-height: 60px; resize: vertical; }

/* Reference cards: the picture is the name, ✕ sits ON it, sliders below. */
.refgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.refcard { border: 1px solid var(--borderc, #2b323f); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.refcard.off { opacity: .55; }
.refcard.bad { border-color: #ef4444; }
.refpic { position: relative; min-height: 60px; border-radius: 6px; overflow: hidden; background: var(--darkbg, #171a21); }
.refpic img { width: 100%; height: auto; display: block; }
.refx { position: absolute; top: 4px; right: 4px; padding: 0 6px; background: rgba(0, 0, 0, .6); }
.refslider { display: flex; align-items: center; gap: 6px; }
.refslider input[type=range] { flex: 1; min-width: 0; margin: 0; }
.refslider .hint { flex: 0 0 auto; }
.refval { min-width: 30px; text-align: right; font-family: var(--mono, monospace); }
.stylefold summary { font-size: 12px; }

/* Notices are toasts in the corner - never a bar that shoves the centre. */
.toastwrap { position: fixed; top: 12px; right: 12px; z-index: 60; display: flex; flex-direction: column; gap: 6px; max-width: min(420px, 80vw); pointer-events: none; }
.toast { pointer-events: auto; cursor: pointer; padding: 8px 12px; border-radius: 8px; font-size: 12px;
         background: var(--darkbg, #171a21); border: 1px solid var(--borderc, #2b323f);
         box-shadow: 0 6px 20px rgba(0, 0, 0, .35); color: var(--textcolor, #d8dce4); }
.toast.ok { border-color: rgba(16, 185, 129, .6); }
.toast.err { border-color: rgba(239, 68, 68, .7); }

/* The fragment organizer in the centre. */
.fragcols { display: flex; gap: 14px; align-items: flex-start; }
.fragcols > .fraglist { flex: 0 0 250px; min-width: 0; }
.fragcols > .fragedit { flex: 1; min-width: 0; }
.fraglist input { width: 100%; box-sizing: border-box; }

/* The centre tabs (1장 · 배치 · 잡 히스토리) style via .tabstrip above. */

/* 1장: one big picture, then the controls, then the batch strip. */
.bigpreview {
  min-height: 58vh; display: flex; flex-direction: column; align-items: center;
  justify-content: center; border: 1px solid var(--borderc, #2b323f);
  border-radius: 8px; background: var(--darkbg, #171a21); overflow: hidden;
}
.bigpreview img { max-width: 100%; max-height: 72vh; object-fit: contain; display: block; }
.bigpreview .previewname { padding: 4px 8px; }
.countbox { width: 56px; text-align: center; }
.striprow { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.stripcell { flex: 0 0 72px; height: 72px; padding: 0; overflow: hidden; border-radius: 6px; }
.stripcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.stripcell.on { outline: 2px solid #2563eb; }

/* 배치: the scene cards (the reservation queue's face). */
.scenegrid { display: grid; gap: 8px; margin-bottom: 8px; }
.scenecard { border: 1px solid var(--borderc, #2b323f); border-radius: 8px; padding: 6px; }
.scenecard.reserved { border-color: #2563eb; }
.sceneface { min-height: 70px; display: flex; align-items: center; justify-content: center;
             border-radius: 6px; overflow: hidden; background: var(--darkbg, #171a21); }
.sceneface .jobpic img { max-height: 180px; object-fit: cover; }
.scenefallback { font-size: 13px; opacity: .6; padding: 20px 4px; }
.reservenum { min-width: 30px; }

/* 배치: one section per JOB, newest first. */
.jobsec { margin-bottom: 14px; border: 1px solid var(--borderc, #2b323f); border-radius: 8px; padding: 8px; }
.jobsec.live { border-color: #2563eb; }
.jobsec.focusjob { outline: 2px solid #2563eb; }
.jobhead { margin-bottom: 6px; }
.jobgrid { display: grid; gap: 8px; }
.jobpic { cursor: zoom-in; display: block; }
.jobpic img { width: 100%; height: auto; display: block; border-radius: 6px; }
.jobwait { display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: center;
           min-height: 90px; border: 1px dashed var(--borderc, #2b323f); border-radius: 6px; }
.liveframe { position: relative; }
.liveframe .badge { position: absolute; top: 6px; left: 6px; }
.jobcell .fname { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jobrow { cursor: pointer; }
.jobrow .wsimg.thumb img { max-height: 40px; border-radius: 4px; }

/* The selector's rule chips and group cards. */
.tokenchip { font-family: var(--mono, monospace); }
.groupcard { cursor: pointer; }
.groupcard.picked { outline: 2px solid #2563eb; border-radius: 6px; }
.groupcard .fname { display: flex; gap: 4px; align-items: center; }
.groupcard .fname .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The folder grid (OUTPUT → a folder). */
.foldergrid { display: grid; gap: 8px; }
.foldergrid .foldcell { cursor: pointer; text-align: center; padding: 12px 6px; }
.foldergrid .foldface { font-size: 30px; }
.foldergrid .imgcell { cursor: pointer; }
.foldergrid .imgcell.picked { outline: 2px solid #2563eb; border-radius: 6px; }

/* The 요청 설정 modal form. */
.genform label.field { margin-bottom: 6px; }
.genform label.field > span { display: block; font-size: 11px; opacity: .7; margin-bottom: 2px; }
.genform input, .genform select { width: 100%; box-sizing: border-box; }
.genform input[type=checkbox] { width: auto; }
.genform .row { gap: 6px; align-items: flex-end; }

@media (max-width: 900px) {
  .panelrail { display: none !important; }
}
`;

export function injectStyles(): void {
  if (document.getElementById('risu-hina-style')) return;
  const style = document.createElement('style');
  style.id = 'risu-hina-style';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}
