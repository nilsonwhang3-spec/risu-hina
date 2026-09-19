import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';
import { Worker } from 'node:worker_threads';
const bundle = await build({ entryPoints: ['plugin/src/ui/markdown.ts'], bundle: true, write: false, format: 'esm' });
const url = 'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64');
const notes = '# Release 0.15.16\r\n\r\nUpdate ready.\r\n\r\n- Plan and Todo\r\n- Memory review\r\n\r\nVerified.\r\n';
const samples = [notes, notes.replace(/\r\n/g, '\n'), notes.replace(/\r\n/g, '\r'),
  '```c++\nint main() {}\n```', '```unsupported language\ncode\n```', '- text\u2028tail', '# heading\u2028tail'];
const worker = new Worker(`(async () => {
 const { parentPort, workerData } = require('node:worker_threads');
 const { parseHTML } = require(process.cwd()+'/plugin/node_modules/linkedom');
 const { window, document } = parseHTML('<html><body></body></html>');
 Object.assign(globalThis,{document,HTMLInputElement:window.HTMLInputElement,HTMLTextAreaElement:window.HTMLTextAreaElement});
 const {renderMarkdown} = await import(workerData.url);
 const rendered = workerData.samples.map(text => {
   const root = document.createElement('div'); root.appendChild(renderMarkdown(text));
   return { html: root.innerHTML, text: root.textContent, items: root.querySelectorAll('li').length };
 });
 parentPort.postMessage(rendered);
})().catch(e => { throw e; })`, { eval: true, workerData: { url, samples } });
let timer;
try {
 const result = await Promise.race([
   new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Markdown parser failed to make progress')),3000);}),
 ]);
 assert.equal(result[0].html,result[1].html,'CRLF renders like LF');
 assert.equal(result[0].html,result[2].html,'bare CR renders like LF');
 assert.equal(result[0].items,2);
 assert.match(result[0].html,/md-h1/);
 assert.match(result[0].text,/Verified/);
 for (let i=3;i<samples.length;i++) assert.ok(result[i].text.length,'unsupported syntax is retained');
 console.log('PASS - release notes CRLF/CR, lists, headings and malformed-block progress');
} finally { clearTimeout(timer); await worker.terminate(); }
