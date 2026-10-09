import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';
import { parseHTML } from '../plugin/node_modules/linkedom/esm/index.js';
const { window, document } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  Event: window.Event });
globalThis.__mobile = true;
let savedPlan = { revision: 0, mode: 'execute', document: '', tasks: [] };
let writes = 0;
const state = globalThis.__uiState = {
  sessionId: 'session', activeChatKey: 'chat', activeCharKey: 'bot', editMode: 'bot',
  async workPlan(mode, revision) {
    if (mode) { assert.equal(revision, savedPlan.revision); savedPlan = { ...savedPlan, mode, revision: revision + 1 }; }
    return savedPlan;
  },
  async approveStaged() { writes++; return { decided: 1, applied: 1 }; },
};
const result = await build({ entryPoints: ['plugin/src/ui/agent.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'panel-dependencies', setup(b) {
    const mocks = {
      '../state': 'export const state = globalThis.__uiState;',
      '../transport': 'export const clientLog = async () => {};',
      './shell': 'export const activeHalf = () => "bot";',
      './blobimg': 'export const smallScreen = () => globalThis.__mobile; export const workspaceImage = () => document.createElement("img"); export const evictBlob = () => {};',
      './tree': 'export const installDrop = () => {};',
      './artifact': 'export const showArtifact = () => {};',
      './markdown': 'export const renderMarkdown = text => { const node = document.createElement("div"); node.textContent = text; return node; };',
    };
    b.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({path}) => ({ contents: mocks[path] }));
  }}] });
const { AgentPanel } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const notices = [];
const panel = new AgentPanel({ onStagedChanged() {}, onApplied() {}, notice(text) { notices.push(text); } });
document.body.appendChild(panel.root);
const proposals = [{ id: 'p1', op: 'edit', seq: 1, reason: 'test proposal' }];
panel.setStaged(proposals);
let fold = panel.root.querySelector('.proposal-fold');
assert.equal(fold.open, false, 'mobile starts collapsed');
assert.match(fold.querySelector('summary').textContent, /1건/);
assert.equal(writes, 0, 'folding never accepts a proposal');
// Both proposal cards live in one scrolling tray with a grip above it, so
// open cards cannot squeeze the log to 0px (iPad landscape).
const tray = panel.root.querySelector('.agenttray');
assert.ok(tray && tray.contains(fold), 'proposals sit in the shared tray');
assert.equal(tray.querySelectorAll(':scope > .stagedbox').length, 2, 'staged and action boxes both in the tray');
assert.equal(tray.previousElementSibling?.className, 'traygrip', 'the resize grip sits above the tray');
fold.open = true;
fold.dispatchEvent(new window.Event('toggle'));
panel.setStaged(proposals);
fold = panel.root.querySelector('.proposal-fold');
assert.equal(fold.open, true, 'refresh preserves expanded state');
fold.open = false; fold.dispatchEvent(new window.Event('toggle'));
panel.setStaged([...proposals, { ...proposals[0], id: 'p2' }]);
assert.equal(panel.root.querySelector('.proposal-fold').open, false, 'new arrivals preserve collapsed state');
assert.match(panel.root.querySelector('.proposal-fold summary').textContent, /2건/);
panel.setActions([{ id: 'a1', summary: 'Lore change', byHost: false }]);
assert.equal(panel.root.querySelectorAll('.proposal-fold')[1].open, false, 'other action cards also fold');
await panel.switchMode();
assert.equal(savedPlan.mode, 'plan');
assert.match(panel.root.querySelector('.agentplan').textContent, /조사와 계획 작성/);
await panel.switchMode();
assert.equal(savedPlan.mode, 'execute');
savedPlan = { ...savedPlan, document: '# Durable plan', tasks: [
  { id: 'a', title: 'Verified work', status: 'completed', evidence: 'file checked' },
  { id: 'b', title: 'Next work', status: 'in_progress', evidence: '' },
] };
panel.setPlan(savedPlan);
assert.match(panel.root.querySelector('.agentplan summary').textContent, /1\/2.*Next work/);
assert.match(panel.root.querySelector('.plan-body').textContent, /file checked/);
const plan = panel.root.querySelector('.agentplan details');
plan.open = true; plan.dispatchEvent(new window.Event('toggle'));
panel.setPlan(savedPlan);
assert.equal(panel.root.querySelector('.agentplan details').open, true);
assert.deepEqual(notices, []);
assert.equal(writes, 0);
globalThis.__mobile = false;
const desktop = new AgentPanel({ onStagedChanged() {}, onApplied() {}, notice() {} });
desktop.setStaged(proposals);
assert.equal(desktop.root.querySelector('.proposal-fold').open, true, 'desktop remains expanded by default');
// Enter on a phone/tablet is a newline; only the button sends. On a desktop
// Enter still sends (the default is prevented).
const enter = () => { const e = new window.Event('keydown', { cancelable: true }); e.key = 'Enter'; return e; };
globalThis.__mobile = true;
const mobileEnter = enter(); panel.root.querySelector('.agentinput').dispatchEvent(mobileEnter);
assert.equal(mobileEnter.defaultPrevented, false, 'mobile Enter types a newline');
globalThis.__mobile = false;
const deskEnter = enter(); desktop.root.querySelector('.agentinput').dispatchEvent(deskEnter);
assert.equal(deskEnter.defaultPrevented, true, 'desktop Enter sends');

// §1-100 tray ✕: closes the card until its queue changes.
desktop.setStaged(proposals);
desktop.root.querySelector('.stagedbox .trayclose').dispatchEvent(new window.Event('click'));
assert.equal(desktop.root.querySelectorAll('.stagedbox .proposal-fold').length, 0, '✕ closes the card');
desktop.setStaged(proposals);
assert.equal(desktop.root.querySelectorAll('.stagedbox .proposal-fold').length, 0, 'the same queue stays closed');
desktop.setStaged([...proposals, { ...proposals[0], id: 'p9' }]);
assert.equal(desktop.root.querySelectorAll('.stagedbox .proposal-fold').length, 1, 'a changed queue shows again');

// §1-100 carried conversation: shown with the question; continuing moves it.
const moved = [];
Object.assign(state, {
  agentChatKey: 'chat-new', health: {}, carry: { sessionId: 'old-s', chatKey: 'chat-old', label: '옛봇 · 옛챗' },
  agentPlaceLabel: () => '새봇 · 새챗',
  async carriedSession() { return { session: { sessionId: 'old-s', chatKey: 'chat-old', title: '' },
    messages: [{ seq: 1, role: 'user', content: '이전 요청', cost: null, usage: null },
               { seq: 2, role: 'assistant', content: '이전 답변', cost: null, usage: null }], staged: [], agentReady: true }; },
  async agentSession() { throw new Error('own conversation must not load before the user decides'); },
  async moveSession(id) { moved.push(id); state.sessionId = id; },
  async refreshChanges() {}, async refreshBotChanges() {}, async stagedEdits() { return []; }, async actions() { return []; },
  async files() { return { areas: [] }; },
});
const carriedPanel = new AgentPanel({ onStagedChanged() {}, onApplied() {}, notice() {} });
await carriedPanel.render();
const banner = carriedPanel.root.querySelector('.carrybanner');
assert.ok(banner && /옛봇 · 옛챗/.test(banner.textContent) && /이어갈까요/.test(banner.textContent), 'the carried conversation asks');
assert.match(carriedPanel.root.querySelector('.agentlog').textContent, /이전 답변/, 'and shows its messages');
banner.querySelector('button.primary').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(moved, ['old-s'], '여기서 이어가기 moves the session to this chat');
assert.equal(carriedPanel.root.querySelector('.carrybanner'), null, 'and the question goes');
carriedPanel.destroy();
panel.destroy(); desktop.destroy();
console.log('PASS - planning mode, Todo progress and persistent mobile proposal folding');
