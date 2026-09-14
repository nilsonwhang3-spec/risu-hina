import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from '../plugin/node_modules/linkedom/esm/index.js';
import { transformSync } from '../plugin/node_modules/esbuild/lib/main.js';
const { document } = parseHTML('<html><body></body></html>').window;
let full = '-- raw "quotes" \\n\r\n'.repeat(18000);
let revision = 'initial';
const calls = [];
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
};
const body = document.body;
const context = vm.createContext({ body, el, f: { name: 'large.lua', path: 'projects/large.lua' },
  state: { touchFiles() {} }, msg: String, notice: message => { throw new Error(message); },
  modal: (_title, content, opts) => { assert.ok(opts.sticky); body.appendChild(content); return () => content.remove(); },
  transport: { async post(_path, payload) {
    calls.push(payload);
    if ('content' in payload) {
      if (payload.revision !== revision) throw new Error('stale file');
      full = payload.content; revision = 'saved'; return { revision };
    }
    return { content: full, revision };
  } },
});
const source = readFileSync(new URL('../plugin/src/ui/tab-files.ts', import.meta.url), 'utf8');
const start = source.indexOf('    if (/\\.(lua|txt)$/i.test(f.name))');
assert.ok(start >= 0);
vm.runInContext(transformSync(source.slice(start, source.indexOf('    if (r.truncated)', start)), { loader: 'ts' }).code, context);
body.querySelector('button').click();
await new Promise(resolve => setTimeout(resolve, 0));
const input = body.querySelector('textarea');
assert.equal(input.value, full);
const save = [...body.querySelectorAll('button')].find(b => b.textContent === '파일 저장');
input.value += '-- changed';
save.click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(full, input.value);
assert.equal(calls.at(-1).revision, 'initial');
revision = 'external-change';
input.value = '-- keep this unsaved draft';
save.click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(input.value, '-- keep this unsaved draft');
assert.ok(body.textContent.includes('stale file'));
assert.equal(save.disabled, false);
console.log('PASS full Lua editor, raw content save, revision forwarding, conflict preserves draft');
