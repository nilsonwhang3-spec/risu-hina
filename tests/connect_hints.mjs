import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';

// A user on the RisuAI desktop app saw only "Expected double-quoted property
// name in JSON at position 18": Tauri's streamed_fetch reports a failed
// request as {"success":false, body:...} and the host's own JSON.parse throws.
// The real cause was https:// on the plain-HTTP backend at 127.0.0.1.
const out = await build({
  entryPoints: [new URL('../plugin/src/transport.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  define: { __PLUGIN_VERSION__: '"0.15.50"' },
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { explainFetchFailure, localHttpsHint } = mod;

// The exact text the user reported (V8 / WebView2), and WebKit's wording.
const tauri = explainFetchFailure('Expected double-quoted property name in JSON at position 18 (line 1 column 19)');
assert.match(tauri, /연결 자체가 실패/, 'the masked Tauri failure is named');
assert.match(tauri, /http\/https/, 'and points at the scheme');
assert.match(explainFetchFailure('JSON Parse error: Expected \'}\''), /연결 자체가 실패/, 'WebKit wording too');
assert.equal(explainFetchFailure('Failed to fetch'), 'Failed to fetch', 'other errors pass through');

for (const u of ['https://127.0.0.1:6020', 'https://localhost:6020/', 'https://192.168.0.5:6020',
                 'https://10.0.0.2:6020', 'https://172.20.1.1:6020', 'https://100.101.102.103:6020',
                 'https://[::1]:6020', ' HTTPS://127.0.0.1:6020 ']) {
  const h = localHttpsHint(u);
  assert.match(h, /http 입니다/, `warned: ${u}`);
  assert.match(h, /http:\/\//, `suggests the http URL: ${u}`);
}
assert.match(localHttpsHint('https://127.0.0.1:6020'), /http:\/\/127\.0\.0\.1:6020/);
for (const u of ['http://127.0.0.1:6020', 'https://hina.example.com', 'https://172.32.0.1:6020',
                 'https://100.200.1.1', '', 'not a url']) {
  assert.equal(localHttpsHint(u), '', `left alone: ${u}`);
}

// PocketRisu's /proxy2 could not connect: 500 {"error":"fetch failed"}, the
// backend healthy on the same PC and the URL left at its default.
const { relayFailureHint } = mod;
const local = relayFailureHint('{"error":"fetch failed"}', 'http://127.0.0.1:6020');
assert.match(local, /PocketRisu/, 'names the relay, not a wrong address');
assert.match(local, /Docker/, 'mentions the container case');
assert.match(local, /host\.docker\.internal:6020/, 'and the address to try there');
assert.match(local, /127\.0\.0\.1:6020\/health/, 'gives the check to run');
assert.match(relayFailureHint('{"error":"Proxy request failed: connect ECONNREFUSED"}', 'http://localhost:6020'), /PocketRisu/);
const remote = relayFailureHint('{"error":"fetch failed"}', 'https://hina.example.com');
assert.match(remote, /RisuAI 서버가/, 'remote URL gets the generic relay advice');
assert.doesNotMatch(remote, /Docker/);
for (const raw of ['', '<html>502 Bad Gateway</html>', '{"service":"other"}']) {
  assert.equal(relayFailureHint(raw, 'http://127.0.0.1:6020'), '', `left alone: ${raw}`);
}

// Web RisuAI refuses a private address before any request (§1-117): the
// advice names the address class and the https way out, never "wait".
const { webPrivateHint, addressKind } = mod;
const HOST = '웹에서는 사설망 직접 호출 불가. Tauri 또는 LAN Node self-host 사용';
const lo = webPrivateHint(HOST, 'http://127.0.0.1:6020');
assert.match(lo, /127\.0\.0\.1·localhost/, 'names loopback');
assert.match(lo, /ts\.net/, 'gives the tailscale serve address');
assert.match(lo, /직접 요청 보내기/, 'names the plain-fetch setting by its Korean label');
assert.doesNotMatch(lo, /자동으로 다시 시도/, 'no retry promise');
assert.match(webPrivateHint(HOST, 'http://100.101.102.103:6020'), /Tailscale IP/);
assert.match(webPrivateHint(HOST, 'http://192.168.0.5:6020'), /사설 IP/);
assert.equal(webPrivateHint('Failed to fetch', 'http://127.0.0.1:6020'), '', 'other failures left alone');
const kinds = {
  'http://127.0.0.1:6020': 'loopback', 'http://localhost:6020': 'loopback', 'http://[::1]:6020': 'loopback',
  'http://100.64.0.1:6020': 'tailscale', 'http://100.127.9.9': 'tailscale', 'http://100.128.0.1': 'domain',
  'http://192.168.1.2:6020': 'private', 'http://10.1.2.3': 'private', 'http://172.16.0.1': 'private',
  'https://pc.tailnet.ts.net': 'domain', 'https://hina.example.com': 'domain', 'nope': 'invalid',
};
for (const [u, k] of Object.entries(kinds)) assert.equal(addressKind(u).kind, k, u);
assert.equal(addressKind('https://pc.tailnet.ts.net').scheme, 'https');

// The browser itself refused (Failed to fetch) an IP address from web RisuAI.
const { webLocalFetchHint } = mod;
assert.match(webLocalFetchHint('Failed to fetch', 'http://127.0.0.1:6020'), /로컬 네트워크 액세스/);
assert.match(webLocalFetchHint('TypeError: NetworkError when attempting to fetch resource.', 'http://100.70.1.1:6020'), /직접 요청 보내기/);
assert.equal(webLocalFetchHint('Failed to fetch', 'https://hina.example.com'), '', 'a domain keeps the tunnel advice');
assert.equal(webLocalFetchHint('ECONNREFUSED', 'http://127.0.0.1:6020'), '', 'other failures left alone');

const { webRelayHint } = mod;
assert.match(webRelayHint('http://127.0.0.1:6020'), /Use Plain Fetch/);
assert.equal(webRelayHint('https://hina.example.com'), '', 'a domain keeps the generic advice');

// "127.0.0.1:6020" without a scheme fetched risuai.xyz's own index.html.
const { normalizeBackendUrl } = mod;
assert.equal(normalizeBackendUrl(' 127.0.0.1:6020/ '), 'http://127.0.0.1:6020');
assert.equal(normalizeBackendUrl('localhost:6020'), 'http://localhost:6020');
assert.equal(normalizeBackendUrl('https://pc.tailnet.ts.net/'), 'https://pc.tailnet.ts.net');
assert.equal(normalizeBackendUrl('http://192.168.0.5:6020'), 'http://192.168.0.5:6020');
assert.equal(normalizeBackendUrl(''), '');

console.log('PASS - masked desktop fetch failure, https on a local backend, relay connect failure, web private refusal');
