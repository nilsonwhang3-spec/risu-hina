import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '../plugin/node_modules/esbuild/lib/main.js';
import { parseHTML } from '../plugin/node_modules/linkedom/esm/index.js';

const { document, Event, CustomEvent } = parseHTML('<html><body></body></html>').window;
const context = vm.createContext({ document, CustomEvent, el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
} });
const source = readFileSync(new URL('../plugin/src/ui/tree.ts', import.meta.url), 'utf8').replace("import { el } from './dom';", '').replaceAll('export ', '');
vm.runInContext(transformSync(source + '\nglobalThis.api = { collectDrop, installDrop, treeRow };', { loader: 'ts' }).code, context);
const { collectDrop, installDrop, treeRow } = context.api;
const files = [{ name: 'one.webp' }, { name: 'two.png' }];
const dt = {
  files, types: ['Files'], getData: () => '',
  items: files.map(file => ({ kind: 'file', getAsFile: () => file,
    webkitGetAsEntry: () => ({ isFile: true, file: (_ok, bad) => bad(new Error('EncodingError')) }) })),
};
assert.deepEqual(Array.from(await collectDrop(dt), x => x.file), files);
const target = document.createElement('div');
const child = target.appendChild(document.createElement('span'));
let uploaded;
installDrop(target, { into: () => 'projects/destination', onFiles: (path, items) => { uploaded = { path, items }; } });
const event = new Event('drop', { bubbles: true, cancelable: true });
event.dataTransfer = dt;
child.dispatchEvent(event);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(uploaded.path, 'projects/destination');
assert.equal(uploaded.items.length, 2);
const sourceNode = treeRow({ path: 'projects/source', name: 'source', kids: [], draggable: true }, 0,
  { expanded: new Set(), selected: new Set(), onOpen() {}, onToggle() {}, dragPaths: () => ['projects/source', 'projects/second'] });
const branch = sourceNode.querySelector('.treebranch');
assert.equal(branch.draggable, true);
let payload;
const drag = new Event('dragstart');
drag.dataTransfer = { setData: (_type, data) => { payload = JSON.parse(data); } };
branch.dispatchEvent(drag);
assert.deepEqual(payload, ['projects/source', 'projects/second']);
// Folder traversal keeps relative paths and consumes all readEntries batches.
let batch = 0;
const entry = { name: 'folder', isDirectory: true, createReader: () => ({ readEntries(ok) {
  ok(batch < 2 ? [{ isFile: true, file: resolve => resolve(files[batch++]) }] : []);
} }) };
const folder = await collectDrop({ files: [], items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => entry }] });
assert.deepEqual(Array.from(folder, x => [x.rel, x.file.name]), [['folder', 'one.webp'], ['folder', 'two.png']]);
console.log('PASS multi-file drop with broken entries, bubbling drop target, tree multi-drag, folder batches');

context.setTimeout = fn => fn();
context.splitter = () => document.createElement('div');
const panes = readFileSync(new URL('../plugin/src/ui/panes.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replaceAll('export ', '');
vm.runInContext(transformSync(panes + '\nglobalThis.mobile = { threePane, showMobileAgent, showMobileCentre };', { loader: 'ts' }).code, context);
const pane = context.mobile.threePane(undefined, { controls: false });
document.body.appendChild(pane.root);
assert.ok(pane.root.classList.contains('m-agent'));
context.mobile.showMobileCentre();
assert.ok(pane.root.classList.contains('m-centre'));
assert.ok(!pane.root.classList.contains('m-agent'));
pane.root.querySelectorAll('.mseg button')[1].click();
assert.ok(pane.root.classList.contains('m-agent'));
console.log('PASS review-side mobile transition and AI-chat return button');
