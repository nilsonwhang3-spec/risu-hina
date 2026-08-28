//@name risu-hina
//@display-name Risu Hina v0.9.2
//@api 3.0
//@version 0.9.2
//@update-url https://raw.githubusercontent.com/nilsonwhang3-spec/risu-hina/master/plugin/Risu.Hina.Plugin.js
//@author Risu Hina

"use strict";
(() => {
  // src/transport.ts
  var BackendError = class extends Error {
    constructor(status, message, body) {
      super(message);
      this.status = status;
      this.body = body;
      this.name = "BackendError";
    }
  };
  var SIGNATURE = "risu-hina";
  var LEGACY_SIGNATURES = /* @__PURE__ */ new Set(["risu-elf", "real-ooc"]);
  var DEFAULT_TIMEOUT_MS = 2e4;
  var UPLOAD_TIMEOUT_MS = 18e4;
  var Transport = class {
    cfg = { url: "", token: "" };
    platform = "unknown";
    route = "unknown";
    lastHealth = null;
    tokenSafe = false;
    configure(cfg) {
      const url = (cfg.url || "").trim().replace(/\/+$/, "");
      if (url !== this.cfg.url) {
        this.tokenSafe = false;
        this.route = "unknown";
        this.lastHealth = null;
      }
      this.cfg = { url, token: (cfg.token || "").trim() };
    }
    get config() {
      return { ...this.cfg };
    }
    get health() {
      return this.lastHealth;
    }
    get routeKind() {
      return this.route;
    }
    get hostPlatform() {
      return this.platform;
    }
    get tokenAttached() {
      return this.tokenSafe;
    }
    async detectPlatform() {
      try {
        const info = await Risuai.getRuntimeInfo();
        this.platform = info?.platform ?? "unknown";
      } catch {
        this.platform = "unknown";
      }
    }
    /**
     * Confirm we are talking to our own backend directly, then allow the token.
     *
     * `/health` is auth-exempt on purpose so this probe needs no credential. A
     * hub relay cannot reach a private address, so a correct signature coming
     * back is what proves the path is direct.
     */
    async connect() {
      if (!this.cfg.url) throw new BackendError(0, "\uBC31\uC5D4\uB4DC URL\uC774 \uC124\uC815\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
      if (this.platform === "unknown") await this.detectPlatform();
      let res;
      try {
        res = await this.probe();
      } catch (e) {
        if (e instanceof BackendError) throw e;
        this.route = "blocked";
        this.tokenSafe = false;
        throw new BackendError(
          0,
          `\uBC31\uC5D4\uB4DC\uC5D0 \uB2FF\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${e instanceof Error ? e.message : String(e)}). URL \uC774 \uB9DE\uB294\uC9C0, \uD130\uB110\xB7VPN \uC774 \uC5F4\uB824 \uC788\uB294\uC9C0 \uD655\uC778\uD574 \uC8FC\uC138\uC694. \uC7A0\uC2DC \uB4A4 \uC790\uB3D9\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD569\uB2C8\uB2E4.`
        );
      }
      const body = await readJson(res);
      if (!body || body.service !== SIGNATURE && !LEGACY_SIGNATURES.has(String(body.service))) {
        this.route = "blocked";
        this.tokenSafe = false;
        const what = res.status ? `HTTP ${res.status}` : "\uBE48 \uC751\uB2F5";
        const raw = body && typeof body === "object" && "_raw" in body ? String(body._raw).replace(/\s+/g, " ").trim().slice(0, 80) : body ? JSON.stringify(body).slice(0, 80) : "";
        this.probeInfo = [
          `HTTP ${res.status}`,
          `type=${res.headers.get("content-type") || "?"}`,
          `cache=${res.headers.get("cache-control") || "-"}`,
          res.headers.get("age") ? `age=${res.headers.get("age")}` : "",
          res.headers.get("expires") ? `expires=${res.headers.get("expires")}` : "",
          `body=${raw}`
        ].filter(Boolean).join(" \xB7 ");
        throw new BackendError(
          res.status,
          `\uBC31\uC5D4\uB4DC\uC5D0\uC11C Risu Hina \uC751\uB2F5\uC744 \uBC1B\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${what}${raw ? " \xB7 " + raw : ""}). \uC8FC\uC18C\uAC00 \uB2E4\uB978 \uC11C\uBC84\uB97C \uAC00\uB9AC\uD0A4\uAC70\uB098 \uD130\uB110\uC774 \uC544\uC9C1 \uC548 \uC5F4\uB838\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uB4A4 \uC790\uB3D9\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD569\uB2C8\uB2E4.`,
          body
        );
      }
      this.route = "direct";
      this.tokenSafe = true;
      this.lastHealth = body;
      this.probeInfo = "";
      this.gate = versionGate("0.9.2", String(body.version || ""));
      return body;
    }
    /** Why ordinary calls are refused right now (version mismatch), or ''. */
    get versionGate() {
      return this.gate;
    }
    gate = "";
    /** What answered the last failed probe (status, type, cache headers), or ''. */
    probeInfo = "";
    /**
     * The connect probe: POST first, GET as the fallback.
     *
     * There is a caching CDN in front of at least one real deployment. When its
     * cache holds an error page for `GET /health`, the panel cannot connect
     * until that entry expires - measured at 49s and 79s in the server log,
     * with **no request reaching the backend** in either window, and the first
     * one that did arrive succeeding immediately. Cache-busting the URL does not
     * work: that edge ignores query strings (0.7.2 caught it serving one asset
     * blob for every key). A POST is never served from a cache, so the probe is
     * a POST; GET remains for backends older than 0.8.4, which have no route
     * for it.
     */
    async probe() {
      const post = await this.raw("POST", "/health", {}, { withToken: false });
      if (post.status !== 404 && post.status !== 405) return post;
      return await this.raw("GET", "/health", void 0, { withToken: false });
    }
    async get(path, query) {
      const qs = query ? "?" + Object.entries(query).filter(([, v]) => v !== void 0 && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
      return this.json("GET", path + qs, void 0);
    }
    async post(path, payload, timeoutMs) {
      return this.json("POST", path, payload, timeoutMs);
    }
    /** POST of something transcript-sized; longer timeout, same path otherwise. */
    async upload(path, payload) {
      return this.json("POST", path, payload, UPLOAD_TIMEOUT_MS);
    }
    /** GET that answers bytes, not JSON - a charx, an image out of the store. */
    async getBinary(path, query) {
      const qs = query ? "?" + Object.entries(query).filter(([, v]) => v !== void 0 && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
      const res = await this.raw("GET", path + qs, void 0, { timeoutMs: UPLOAD_TIMEOUT_MS });
      if (!res.ok) throw await toError(res);
      return new Uint8Array(await res.arrayBuffer());
    }
    /** POST of raw bytes (application/octet-stream) - the batch upload. */
    async postBytes(path, bytes) {
      const res = await this.raw("POST", path, void 0, { timeoutMs: UPLOAD_TIMEOUT_MS, bytes });
      if (!res.ok) throw await toError(res);
      const body = await readJson(res);
      if (isRaw(body)) throw new BackendError(res.status, "\uBC31\uC5D4\uB4DC \uB300\uC2E0 \uB2E4\uB978 \uC751\uB2F5\uC774 \uC654\uC2B5\uB2C8\uB2E4 (JSON \uC774 \uC544\uB2D8)");
      return body;
    }
    /** POST that answers bytes - a zip of workspace files. */
    async postBinary(path, payload) {
      const res = await this.raw("POST", path, payload, { timeoutMs: UPLOAD_TIMEOUT_MS });
      if (!res.ok) throw await toError(res);
      return new Uint8Array(await res.arrayBuffer());
    }
    /**
     * NDJSON stream. Yields one parsed object per line as it arrives.
     *
     * Phase 0 measured first-byte at ~289ms and lines arriving at the server's
     * own cadence over this path, so the agent panel can render progressively.
     */
    async *stream(path, payload, signal) {
      const res = await this.raw("POST", path, payload, { timeoutMs: 0, signal });
      if (!res.ok) throw await toError(res);
      const body = res.body;
      if (!body || typeof body.getReader !== "function") {
        const text2 = await res.text();
        for (const line of text2.split("\n")) {
          const v = parseLine(line);
          if (v !== void 0) yield v;
        }
        return;
      }
      const reader = body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const v = parseLine(line);
          if (v !== void 0) yield v;
        }
      }
      const tail = parseLine(buf);
      if (tail !== void 0) yield tail;
    }
    async json(method, path, payload, timeoutMs) {
      const res = await this.raw(method, path, payload, { timeoutMs });
      if (!res.ok) throw await toError(res);
      const body = await readJson(res);
      if (isRaw(body)) {
        throw new BackendError(
          res.status,
          `\uBC31\uC5D4\uB4DC \uB300\uC2E0 \uB2E4\uB978 \uC751\uB2F5\uC774 \uC654\uC2B5\uB2C8\uB2E4 (JSON \uC774 \uC544\uB2D8): \u201C${body._raw.replace(/\s+/g, " ").trim().slice(0, 100)}\u201D \u2014 \uD130\uB110\xB7\uD504\uB85D\uC2DC\uAC00 \uB300\uC2E0 \uB2F5\uD588\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.`
        );
      }
      return body;
    }
    async raw(method, path, payload, opts = {}) {
      if (!this.cfg.url) throw new BackendError(0, "\uBC31\uC5D4\uB4DC URL\uC774 \uC124\uC815\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
      if (this.gate && !GATE_EXEMPT.has(path.split("?")[0])) {
        throw new BackendError(0, this.gate);
      }
      const headers = {};
      const wantToken = opts.withToken !== false;
      if (wantToken && this.cfg.token) {
        if (!this.tokenSafe && this.platform === "web") {
          throw new BackendError(0, "\uC9C1\uC811 \uC5F0\uACB0\uC774 \uD655\uC778\uB418\uC9C0 \uC54A\uC544 \uD1A0\uD070\uC744 \uBCF4\uB0B4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC5F0\uACB0 \uC9C4\uB2E8\uC744 \uBA3C\uC800 \uC2E4\uD589\uD574 \uC8FC\uC138\uC694");
        }
        headers["Authorization"] = "Bearer " + this.cfg.token;
      }
      const init = {
        method,
        headers,
        networkRoute: "local_network"
      };
      if (opts.bytes) {
        headers["Content-Type"] = "application/octet-stream";
        init.body = opts.bytes;
      } else if (method === "POST") {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(payload ?? {});
      }
      if (opts.signal) init.signal = opts.signal;
      const url = this.cfg.url + path;
      const budget = opts.timeoutMs === void 0 ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
      const call = Risuai.nativeFetch(url, init);
      if (!budget) return await call;
      call.catch(() => {
      });
      let timer;
      try {
        return await Promise.race([
          call,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new BackendError(0, `${path} \uC751\uB2F5\uC774 ${Math.round(budget / 1e3)}\uCD08 \uC548\uC5D0 \uC624\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4`)),
              budget
            );
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
  function parseLine(line) {
    const s = line.trim();
    if (!s) return void 0;
    try {
      return JSON.parse(s);
    } catch {
      return { type: "raw", text: s };
    }
  }
  async function readJson(res) {
    let text2;
    try {
      text2 = await res.text();
    } catch {
      return null;
    }
    try {
      return JSON.parse(text2);
    } catch {
      return { _raw: text2.slice(0, 500) };
    }
  }
  function isRaw(v) {
    return !!v && typeof v === "object" && "_raw" in v && Object.keys(v).length === 1;
  }
  var GATE_EXEMPT = /* @__PURE__ */ new Set(["/health", "/update/check", "/update/apply", "/plugin", "/logs", "/diag", "/config"]);
  function versionGate(plugin, backend) {
    const mm = (v) => v.split(".").slice(0, 2).map((x) => parseInt(x, 10) || 0);
    if (!backend) return "";
    const [pa, pb] = mm(plugin);
    const [ba, bb] = mm(backend);
    if (pa === ba && pb === bb) return "";
    const pluginNewer = pa > ba || pa === ba && pb > bb;
    return pluginNewer ? `\uD50C\uB7EC\uADF8\uC778 v${plugin} \uACFC \uBC31\uC5D4\uB4DC v${backend} \uC758 \uBC84\uC804\uC774 \uB2E4\uB985\uB2C8\uB2E4. \u2699 \u2192 \uC5F0\uACB0\uC5D0\uC11C \uBC31\uC5D4\uB4DC\uB97C \uC5C5\uB370\uC774\uD2B8\uD574 \uC8FC\uC138\uC694.` : `\uBC31\uC5D4\uB4DC v${backend} \uAC00 \uD50C\uB7EC\uADF8\uC778 v${plugin} \uBCF4\uB2E4 \uC0C8 \uBC84\uC804\uC785\uB2C8\uB2E4. RisuAI \uD50C\uB7EC\uADF8\uC778 \uD654\uBA74\uC5D0\uC11C Risu Hina \uB97C \uC5C5\uB370\uC774\uD2B8(+)\uD574 \uC8FC\uC138\uC694.`;
  }
  async function toError(res) {
    const body = await readJson(res);
    let msg15 = body && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${res.status}`;
    if (res.status === 401) {
      msg15 = '\uD1A0\uD070\uC774 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uBC31\uC5D4\uB4DC PC \uC758 data/token.txt \uB0B4\uC6A9\uC744 \u2699 \u2192 \uC5F0\uACB0 \u2192 \uD1A0\uD070\uC5D0 \uB123\uACE0 "\uC800\uC7A5\uD558\uACE0 \uC5F0\uACB0"\uC744 \uB20C\uB7EC \uC8FC\uC138\uC694 (127.0.0.1 \uB85C \uC811\uC18D\uD560 \uB54C\uB294 \uBE44\uC6CC\uB3C4 \uB429\uB2C8\uB2E4).';
    } else if (res.status === 429) {
      msg15 = "\uD2C0\uB9B0 \uD1A0\uD070\uC774 \uC5EC\uB7EC \uBC88 \uAC70\uBD80\uB418\uC5B4 \uC7A0\uC2DC \uB9C9\uD614\uC2B5\uB2C8\uB2E4. 1\uBD84 \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.";
    }
    return new BackendError(res.status, msg15, body);
  }
  var transport = new Transport();
  function clientLog(level, event, detail) {
    return transport.post("/clientlog", { level, event, detail }).then(() => void 0).catch(() => void 0);
  }

  // src/ui/dom.ts
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === void 0 || v === false) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "html") node.innerHTML = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "value" && node instanceof HTMLTextAreaElement) {
        node.value = String(v);
      } else if (k === "value" && node instanceof HTMLInputElement) {
        node.value = String(v);
      } else if (k === "checked" && node instanceof HTMLInputElement) {
        node.checked = Boolean(v);
      } else if (v === true) {
        node.setAttribute(k, "");
      } else {
        node.setAttribute(k, String(v));
      }
    }
    const list2 = Array.isArray(children) ? children : [children];
    for (const c of list2) {
      if (c === null || c === void 0 || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  function searchBox(value, onInput, placeholder = "\uCC3E\uAE30") {
    const input = el("input", { class: "searchinput", placeholder, value });
    input.addEventListener("input", () => onInput(input.value));
    return el("div", { class: "searchbox" }, [input]);
  }
  function refocusSearch(root) {
    const input = root?.querySelector(".searchbox input") ?? document.querySelector(".tabslot .searchbox input");
    if (!input) return;
    input.focus();
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
    }
  }
  function setSelected(sel, value) {
    for (const opt of Array.from(sel.querySelectorAll("option"))) {
      const on = opt.value === value;
      opt.selected = on;
      if (on) opt.setAttribute("selected", "");
      else opt.removeAttribute("selected");
    }
    try {
      sel.value = value;
    } catch {
    }
  }
  function selectedValue(sel) {
    const options = Array.from(sel.querySelectorAll("option"));
    const live = options.find((o) => o.selected === true && o.hasAttribute("selected") === false) ?? (typeof sel.value === "string" && sel.value !== "" && options.find((o) => o.value === sel.value)) ?? options.find((o) => o.selected === true);
    if (live) return live.value;
    const stamped = sel.querySelector("option[selected]");
    return stamped?.value ?? sel.value ?? options[0]?.value ?? "";
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function svg(path, size = 20) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }
  var ICON = {
    app: svg('<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8"/><path d="M8 12h5"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 18),
    // A drawn arrow rather than the 🔄 emoji: the emoji renders at a different
    // weight and baseline from every other control in the header.
    reload: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>', 17),
    check: svg('<path d="m5 13 4 4L19 7"/>', 16),
    clip: svg('<path d="M21.4 11.1 12.3 20.2a5 5 0 0 1-7.1-7.1l9.2-9.2a3.3 3.3 0 1 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4l8.5-8.5"/>', 17),
    pencil: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>', 15),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.66 1.03 1.28 1.05H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 17),
    warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', 16)
  };
  function armed(button, label, confirmLabel, run) {
    let armedNow = false;
    let timer;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!armedNow) {
        armedNow = true;
        button.textContent = confirmLabel;
        button.classList.add("danger");
        timer = setTimeout(() => {
          armedNow = false;
          button.textContent = label;
          button.classList.remove("danger");
        }, 4e3);
        return;
      }
      if (timer) clearTimeout(timer);
      armedNow = false;
      button.textContent = label;
      button.classList.remove("danger");
      run();
    });
  }
  function diffFragments(before, after) {
    let head = 0;
    const max = Math.min(before.length, after.length);
    while (head < max && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const mk = (text2, cls) => {
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text2.slice(0, head)));
      const mid = text2.slice(head, text2.length - tail);
      if (mid) frag.appendChild(el("span", { class: cls, text: mid }));
      frag.appendChild(document.createTextNode(text2.slice(text2.length - tail)));
      return frag;
    };
    return { before: mk(before, "diff-del"), after: mk(after, "diff-ins") };
  }
  function fmtTime(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      return new Date(n).toISOString().slice(0, 16).replace("T", " ");
    } catch {
      return "";
    }
  }
  var TOOL = {
    snapshot: "\u{1F516}",
    versions: "\u{1F558}",
    apply: "\u{1F4BE}",
    export: "\u2B07",
    find: "\u{1F50D}",
    cut: "\u2702",
    view: "\u{1F441}",
    reload: "\u{1F504}",
    newChat: "\u2795",
    history: "\u{1F5C2}",
    info: "\u24D8"
  };
  var TOOL_GLYPH = {
    list_turns: ["\u{1F4CB}", "\uD6D1\uAE30"],
    read_turns: ["\u{1F4D6}", "\uC77D\uAE30"],
    search_turns: ["\u{1F50D}", "\uAC80\uC0C9"],
    read_card: ["\u{1FAAA}", "\uCE74\uB4DC"],
    read_lore: ["\u{1F4DA}", "\uB85C\uC5B4"],
    read_memory: ["\u{1F9E0}", "\uC694\uC57D"],
    list_skills: ["\u{1F9E9}", "\uC2A4\uD0AC \uBAA9\uB85D"],
    load_skill: ["\u{1F9E9}", "\uC2A4\uD0AC"],
    stage_edit: ["\u270F\uFE0F", "\uC218\uC815 \uC81C\uC548"],
    stage_bulk: ["\u270F\uFE0F", "\uC77C\uAD04 \uC81C\uC548"],
    stage_delete: ["\u2702\uFE0F", "\uC0AD\uC81C \uC81C\uC548"],
    list_staged: ["\u{1F4CC}", "\uC81C\uC548 \uD655\uC778"],
    run_python: ["\u{1F40D}", "\uC2A4\uD06C\uB9BD\uD2B8"],
    write_file: ["\u{1F4BE}", "\uD30C\uC77C \uC4F0\uAE30"],
    list_files: ["\u{1F4C1}", "\uD30C\uC77C \uBAA9\uB85D"],
    read_file: ["\u{1F4C4}", "\uD30C\uC77C \uC77D\uAE30"],
    web_search: ["\u{1F310}", "\uC6F9 \uAC80\uC0C9"]
  };
  var PAPER_PLANE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
  function modal(title, body, opts = {}) {
    const closeBtn = el("button", { class: "iconbtn", html: ICON.close, title: "\uB2EB\uAE30" });
    const box = el("div", { class: "modalbox" + (opts.wide ? " wide" : "") + (opts.cls ? " " + opts.cls : "") }, [
      el("div", { class: "modalhead" }, [
        el("h2", { text: title }),
        el("span", { class: "spacer" }),
        closeBtn
      ]),
      el("div", { class: "modalbody" }, [body])
    ]);
    const back = el("div", { class: "modalback" }, [box]);
    document.body.appendChild(back);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener("keydown", esc, true);
      opts.onClose?.();
    };
    const esc = (e) => {
      if (e.key === "Escape") close();
    };
    closeBtn.addEventListener("click", close);
    back.addEventListener("click", (e) => {
      if (e.target === back && !opts.sticky) close();
    });
    document.addEventListener("keydown", esc, true);
    setTimeout(() => box.querySelector("input, textarea, select, button")?.focus(), 0);
    return close;
  }
  function focusEdit(source, title, opts = {}) {
    const big = el("textarea", {
      class: "focusarea" + (opts.code ? " codearea" : ""),
      spellcheck: opts.code ? "false" : "true"
    });
    big.value = source.value;
    const count = el("span", { class: "hint", text: `${big.value.length}\uC790` });
    const sync = () => {
      source.value = big.value;
      count.textContent = `${big.value.length}\uC790`;
      source.dispatchEvent(new Event("input", { bubbles: true }));
    };
    big.addEventListener("input", sync);
    const done = el("button", { class: "primary", text: "\uC644\uB8CC" });
    const body = el("div", { class: "focusbody" }, [
      big,
      el("div", { class: "row focusfoot" }, [
        count,
        el("span", { class: "hint grow", text: "\uC785\uB825\uC740 \uBC14\uB85C \uC6D0\uB798 \uC0C1\uC790\uC5D0 \uBC18\uC601\uB429\uB2C8\uB2E4. \uC800\uC7A5\uC740 \uC6D0\uB798 \uD654\uBA74\uC758 \uC800\uC7A5 \uBC84\uD2BC\uC73C\uB85C \uD569\uB2C8\uB2E4." }),
        done
      ])
    ]);
    const close = modal(title, body, { cls: "focusmodal", sticky: true });
    done.addEventListener("click", close);
    setTimeout(() => {
      big.focus();
      try {
        big.setSelectionRange(source.selectionStart, source.selectionEnd);
      } catch {
      }
    }, 0);
  }
  function focusButton(source, title, opts = {}) {
    const b = el("button", { class: "ghost tiny focusbtn", text: "\u2922 \uC9D1\uC911 \uD3B8\uC9D1", title: "\uD654\uBA74 \uC804\uCCB4\uB85C \uD06C\uAC8C \uD3B8\uC9D1\uD569\uB2C8\uB2E4" });
    b.addEventListener("click", () => focusEdit(source, title, opts));
    return b;
  }
  function lineDiff(before, after) {
    const a = before.split("\n");
    const b = after.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const out = [];
    for (let i = 0; i < head; i++) out.push({ kind: "same", text: a[i] });
    const am = a.slice(head, a.length - tail);
    const bm = b.slice(head, b.length - tail);
    if (am.length && bm.length && am.length * bm.length <= 4e6) {
      const n = am.length, m = bm.length;
      const dp = [];
      for (let i2 = 0; i2 <= n; i2++) dp.push(new Uint32Array(m + 1));
      for (let i2 = n - 1; i2 >= 0; i2--) {
        for (let j2 = m - 1; j2 >= 0; j2--) {
          dp[i2][j2] = am[i2] === bm[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (am[i] === bm[j]) {
          out.push({ kind: "same", text: am[i] });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          out.push({ kind: "del", text: am[i] });
          i++;
        } else {
          out.push({ kind: "ins", text: bm[j] });
          j++;
        }
      }
      while (i < n) out.push({ kind: "del", text: am[i++] });
      while (j < m) out.push({ kind: "ins", text: bm[j++] });
    } else {
      for (const t of am) out.push({ kind: "del", text: t });
      for (const t of bm) out.push({ kind: "ins", text: t });
    }
    for (let i = a.length - tail; i < a.length; i++) out.push({ kind: "same", text: a[i] });
    return out;
  }
  function diffView(before, after, opts = {}) {
    const lines = lineDiff(before, after);
    const ctx = opts.context ?? 2;
    const dels = lines.filter((l) => l.kind === "del").length;
    const ins = lines.filter((l) => l.kind === "ins").length;
    const root = el("div", { class: "diffview" + (opts.code ? " code" : "") });
    root.appendChild(el("div", { class: "diffsum" }, [
      el("span", { class: "diff-ins-n", text: `+${ins}` }),
      el("span", { class: "diff-del-n", text: `\u2212${dels}` }),
      el("span", { class: "hint", text: dels || ins ? " \uC904 (\uAE30\uC900\uC120 \u2192 \uC9C0\uAE08)" : " \uC904 \u2014 \uB0B4\uC6A9\uC774 \uAC19\uC2B5\uB2C8\uB2E4" })
    ]));
    const show = new Array(lines.length).fill(false);
    lines.forEach((l, i) => {
      if (l.kind === "same") return;
      for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) show[k] = true;
    });
    let hidden = 0;
    const flush = () => {
      if (hidden) root.appendChild(el("div", { class: "diffskip", text: `\u2026 ${hidden}\uC904 \uAC19\uC74C \u2026` }));
      hidden = 0;
    };
    lines.forEach((l, i) => {
      if (!show[i]) {
        hidden++;
        return;
      }
      flush();
      root.appendChild(el("div", { class: "diffline " + l.kind }, [
        el("span", { class: "diffmark", text: l.kind === "del" ? "\u2212" : l.kind === "ins" ? "+" : " " }),
        el("span", { class: "difftext", text: l.text || " " })
      ]));
    });
    flush();
    return root;
  }
  function diffCard(before, after, opts = {}) {
    if (before === null || before === after) return null;
    const lines = lineDiff(before, after);
    const n = lines.filter((l) => l.kind !== "same").length;
    const body = el("div", { class: "diffbody", style: { display: opts.open ? "" : "none" } });
    const toggle = el("button", { class: "ghost tiny", text: opts.open ? "\uBCC0\uACBD \uB0B4\uC6A9 \uC811\uAE30" : `\uBCC0\uACBD \uB0B4\uC6A9 \uBCF4\uAE30 (${n}\uC904)` });
    toggle.addEventListener("click", () => {
      const open4 = body.style.display === "none";
      if (open4 && !body.childElementCount) body.appendChild(diffView(before, after, { code: opts.code }));
      body.style.display = open4 ? "" : "none";
      toggle.textContent = open4 ? "\uBCC0\uACBD \uB0B4\uC6A9 \uC811\uAE30" : `\uBCC0\uACBD \uB0B4\uC6A9 \uBCF4\uAE30 (${n}\uC904)`;
    });
    if (opts.open) body.appendChild(diffView(before, after, { code: opts.code }));
    return el("div", { class: "diffcard" }, [
      el("div", { class: "row" }, [
        el("span", { class: "hint grow", text: `\uAE30\uC900\uC120\uACFC \uB2E4\uB985\uB2C8\uB2E4 (${before.length}\uC790 \u2192 ${after.length}\uC790).` }),
        toggle
      ]),
      body
    ]);
  }
  function popover(anchor, content) {
    const pop = el("div", { class: "popover" }, [content]);
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    pop.style.maxWidth = Math.max(200, vw - 16) + "px";
    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 200;
    const left = Math.max(8, Math.min(rect.left, vw - pw - 8));
    const below = rect.bottom + 4;
    const top = below + ph > vh - 8 ? Math.max(8, rect.top - ph - 4) : below;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    const close = () => {
      pop.remove();
      document.removeEventListener("click", away, true);
      document.removeEventListener("keydown", esc, true);
    };
    const away = (e) => {
      const t = e.target;
      if (!pop.contains(t) && !anchor.contains(t)) close();
    };
    const esc = (e) => {
      if (e.key === "Escape") close();
    };
    setTimeout(() => {
      document.addEventListener("click", away, true);
      document.addEventListener("keydown", esc, true);
    }, 0);
    return close;
  }

  // src/assets.ts
  function extractAssetRefs(char) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (field, name, key) => {
      if (typeof key !== "string" || !key.startsWith("assets/")) return;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ field, name, key });
    };
    push("image", "\uD504\uB85C\uD544", char.image);
    for (const e of asArray(char["emotionImages"])) {
      if (Array.isArray(e)) push("emotion", String(e[0] ?? ""), e[1]);
    }
    for (const a of asArray(char["additionalAssets"])) {
      if (Array.isArray(a)) push("additional", String(a[0] ?? ""), a[1]);
    }
    for (const c of asArray(char["ccAssets"])) {
      if (c && typeof c === "object") {
        const cc = c;
        push("cc", String(cc.name ?? ""), cc.uri);
      }
    }
    const vits = char["vits"];
    if (vits && vits.files && typeof vits.files === "object") {
      for (const [k, v] of Object.entries(vits.files)) push("vits", k, v);
    }
    return out;
  }
  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }
  function b64encode(bytes) {
    let bin = "";
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const part = bytes.subarray(i, i + CHUNK);
      bin += String.fromCharCode.apply(null, part);
    }
    return btoa(bin);
  }
  var BATCH_BYTES = 8 * 1024 * 1024;
  var BATCH_ITEMS = 50;
  function syncAssets(char, charKey, opts, onProgress) {
    let cancelled = false;
    const p = {
      charKey,
      phase: "manifest",
      total: 0,
      present: 0,
      missing: 0,
      failed: 0,
      bytes: 0,
      read: 0,
      readFailed: 0,
      sent: 0,
      sentBytes: 0,
      toPush: 0,
      fastFilled: 0,
      pull: null,
      complete: false,
      error: "",
      startedAt: Date.now(),
      finishedAt: 0
    };
    const report = () => {
      try {
        onProgress(p);
      } catch {
      }
    };
    const absorb = (r) => {
      p.total = r.total;
      p.present = r.present;
      p.missing = Array.isArray(r.missing) ? r.missing.length : r.missing;
      p.failed = r.failed;
      p.bytes = r.bytes;
      p.pull = r.pull ?? null;
      p.complete = !!r.complete;
    };
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const done = (async () => {
      try {
        const refs = extractAssetRefs(char);
        p.total = refs.length;
        report();
        let m = await transport.upload("/assets/manifest", {
          charKey,
          refs,
          hubPull: opts.hubPull
        });
        absorb(m);
        p.fastFilled = m.fastFilled ?? 0;
        report();
        if (m.pulling) {
          p.phase = "pulling";
          report();
          while (!cancelled) {
            await sleep(opts.pollMs ?? 1500);
            const s2 = await transport.get("/assets/status", { charKey });
            absorb(s2);
            report();
            if (!s2.pulling) break;
          }
          if (cancelled) return finish("cancelled");
          m = await transport.upload("/assets/manifest", { charKey, refs, hubPull: false });
          absorb(m);
          report();
        }
        const missing = Array.isArray(m.missing) ? m.missing : [];
        p.toPush = missing.length;
        if (missing.length) {
          p.phase = "pushing";
          report();
          await push(missing);
          if (cancelled) return finish("cancelled");
        }
        const s = await transport.get("/assets/status", { charKey });
        absorb(s);
        return finish("done");
      } catch (e) {
        if (e instanceof BackendError && e.status === 404) {
          return finish("unsupported", "\uBC31\uC5D4\uB4DC\uC5D0 \uC5D0\uC14B \uC2A4\uD1A0\uC5B4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4 (\uBC31\uC5D4\uB4DC\uB97C \uC5C5\uB370\uC774\uD2B8\uD574 \uC8FC\uC138\uC694)");
        }
        return finish("error", e instanceof Error ? e.message : String(e));
      }
    })();
    function finish(phase, error = "") {
      p.phase = phase;
      p.error = error;
      p.finishedAt = Date.now();
      if (phase === "unsupported") p.complete = true;
      report();
      return p;
    }
    async function push(keys) {
      const failed = [];
      let batch = [];
      let batchBytes = 0;
      let uploading = Promise.resolve();
      let inTransit = 0;
      const flush = () => {
        if (!batch.length) return;
        const items5 = batch;
        const bytes = batchBytes;
        batch = [];
        batchBytes = 0;
        inTransit += 1;
        uploading = uploading.then(async () => {
          try {
            const r = await transport.upload(
              "/assets/upload",
              { charKey, items: items5 }
            );
            p.sent += r.stored;
            p.sentBytes += bytes;
            for (const b of r.bad ?? []) failed.push(b.key);
          } finally {
            inTransit -= 1;
          }
          report();
        });
      };
      let next = 0;
      const worker = async () => {
        while (!cancelled) {
          const i = next++;
          if (i >= keys.length) return;
          const key = keys[i];
          let bytes = null;
          try {
            const raw = await Risuai.readImage(key);
            if (raw && raw.byteLength) {
              bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            }
          } catch {
          }
          if (!bytes) {
            failed.push(key);
            p.readFailed += 1;
            report();
            continue;
          }
          p.read += 1;
          batch.push({ key, data: b64encode(bytes) });
          batchBytes += bytes.byteLength;
          if (batchBytes >= BATCH_BYTES || batch.length >= BATCH_ITEMS) flush();
          report();
          if (inTransit >= 2) await uploading;
        }
      };
      const n = Math.max(1, Math.min(8, opts.concurrency));
      await Promise.all(Array.from({ length: n }, () => worker()));
      if (!cancelled) flush();
      await uploading;
      if (failed.length && !cancelled) {
        try {
          await transport.post("/assets/fail", {
            charKey,
            keys: failed,
            reason: "readImage returned nothing"
          });
        } catch {
        }
      }
    }
    return { cancel: () => {
      cancelled = true;
    }, done };
  }
  function describeSync(p) {
    if (!p) return "";
    const mb2 = (n) => (n / 1048576).toFixed(1) + "MB";
    switch (p.phase) {
      case "manifest":
        return `\uC5D0\uC14B \uBAA9\uB85D \uB300\uC870 \uC911 \xB7 ${p.total}\uAC1C`;
      case "pulling": {
        const d = p.pull;
        return d ? `\uBC31\uC5D4\uB4DC\uAC00 \uD5C8\uBE0C\uC5D0\uC11C \uBC1B\uB294 \uC911 ${d.done}/${d.total}` + (d.notFound ? ` \xB7 \uC5C6\uC74C ${d.notFound}` : "") : "\uBC31\uC5D4\uB4DC\uAC00 \uD5C8\uBE0C\uC5D0\uC11C \uBC1B\uB294 \uC911";
      }
      case "pushing":
        return `\uC5D0\uC14B \uC784\uD3EC\uD2B8 \uC911 ${p.read + p.readFailed}/${p.toPush} \xB7 \uC804\uC1A1 ${mb2(p.sentBytes)}`;
      case "done": {
        if (!p.total) return "\uCC38\uC870\uD558\uB294 \uC5D0\uC14B \uC5C6\uC74C";
        const src = [];
        if (p.fastFilled) src.push(`\uAC19\uC740 PC \uC758 PocketRisu DB ${p.fastFilled}`);
        if (p.pull && p.pull.ok) src.push(`\uD5C8\uBE0C ${p.pull.ok}`);
        if (p.sent) src.push(`\uC774 \uBE0C\uB77C\uC6B0\uC800 ${p.sent}`);
        return `\uC5D0\uC14B ${p.present}/${p.total}\uAC1C \xB7 ${mb2(p.bytes)}` + (src.length ? ` \xB7 \uC774\uBC88\uC5D0 ${src.join(", ")}` : " \xB7 \uC774\uBBF8 \uC788\uC5C8\uC74C") + (p.failed ? ` \xB7 \uC77D\uAE30 \uC2E4\uD328 ${p.failed}` : "");
      }
      case "cancelled":
        return `\uC5D0\uC14B \uC784\uD3EC\uD2B8 \uC911\uB2E8\uB428 (${p.present}/${p.total})`;
      case "unsupported":
        return p.error;
      case "error":
        return "\uC5D0\uC14B \uC784\uD3EC\uD2B8 \uC2E4\uD328: " + p.error;
    }
    return "";
  }
  function syncBusy(p) {
    return !!p && (p.phase === "manifest" || p.phase === "pulling" || p.phase === "pushing");
  }

  // src/ui/styles.ts
  var CSS = `
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
  /* A label never breaks mid-word ("\uC9C4\uB2E8 \uC815/\uBCF4"): the row wraps instead. */
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
details.fold > summary::before { content: '\u25B8 '; }
details.fold[open] > summary::before { content: '\u25BE '; }
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

/* --- files \xB7 presets \xB7 skills --------------------------------------------- */
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

/* --- tree (files \xB7 lorebook \xB7 memory) ------------------------------------- */
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
   Red rather than the ordinary amber "\uC218\uC815": an edit badge says "this will be
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

/* --- \uC9D1\uC911 \uD3B8\uC9D1: one text box, the whole screen ------------------------------ */
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

/* --- workspace files: tree | list \xB7 grid ------------------------------------ */
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
.verrow .badge.now { background: rgba(37, 99, 235, .25); }
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
     and the bar's \uBAA9\uB85D button opens it to most of the height. It was pinned
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
`;
  function injectStyles() {
    if (document.getElementById("risu-hina-style")) return;
    const style = document.createElement("style");
    style.id = "risu-hina-style";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // src/host.ts
  var HostError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "HostError";
    }
  };
  var NO_SELECT_HINT = "RisuAI\uC5D0\uC11C \uBD07\uC744 \uC5F4\uC5B4 \uCC44\uD305 \uD654\uBA74\uC5D0 \uB4E4\uC5B4\uAC04 \uB2E4\uC74C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694";
  async function currentSlot() {
    let characterIndex;
    try {
      characterIndex = await Risuai.getCurrentCharacterIndex();
    } catch (e) {
      throw new HostError("noselect", NO_SELECT_HINT);
    }
    if (characterIndex == null || characterIndex < 0) {
      throw new HostError("noselect", NO_SELECT_HINT);
    }
    try {
      const chatIndex = await Risuai.getCurrentChatIndex();
      if (chatIndex == null || chatIndex < 0) throw new HostError("noselect", NO_SELECT_HINT);
      return { characterIndex, chatIndex };
    } catch (e) {
      if (e instanceof HostError) throw e;
      throw new HostError("noselect", NO_SELECT_HINT);
    }
  }
  async function readCharacter(characterIndex) {
    const char = await Risuai.getCharacterFromIndex(characterIndex);
    if (!char) throw new HostError("missing", `\uCE90\uB9AD\uD130 ${characterIndex}\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4`);
    return char;
  }
  async function readChat(slot) {
    const chat = await Risuai.getChatFromIndex(slot.characterIndex, slot.chatIndex);
    if (!chat || !Array.isArray(chat.message)) {
      throw new HostError("missing", "\uCC57\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4");
    }
    return chat;
  }
  function cardOf(char) {
    const out = {};
    for (const k of Object.keys(char)) {
      if (k === "chats" || k === "chatPage") continue;
      out[k] = char[k];
    }
    return out;
  }
  var DEFAULT_FALSE = /* @__PURE__ */ new Set([
    "alwaysActive",
    "selective",
    "useRegex",
    "enabled",
    "case_sensitive",
    "scanDepth",
    "loreCache",
    "folder",
    "activationPercent"
  ]);
  function strip(value) {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const src = value;
      const out = {};
      for (const k of Object.keys(src).sort()) {
        const v = strip(src[k]);
        if (v === null || v === void 0 || v === "") continue;
        if (Array.isArray(v) && !v.length) continue;
        if (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
        if (DEFAULT_FALSE.has(k) && (v === false || v === 0 || v === "0")) continue;
        out[k] = v;
      }
      return out;
    }
    return value;
  }
  function canon(value) {
    return typeof value === "string" ? value : JSON.stringify(strip(value));
  }
  function fnv32(text2) {
    let h = 2166136261;
    for (let i = 0; i < text2.length; i += 1) {
      const c = text2.codePointAt(i);
      for (const b of utf8(c)) h = Math.imul(h ^ b, 16777619) >>> 0;
      if (c > 65535) i += 1;
    }
    return h >>> 0;
  }
  function utf8(cp) {
    if (cp < 128) return [cp];
    if (cp < 2048) return [192 | cp >> 6, 128 | cp & 63];
    if (cp < 65536) return [224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63];
    return [240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63];
  }
  function checkList(what, live, before) {
    if (canon(live ?? []) === canon(before ?? [])) return;
    throw new HostError(
      "changed",
      `RisuAI \uCABD\uC5D0\uC11C ${what}\uC774(\uAC00) \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uD328\uB110\uC744 \uB2E4\uC2DC \uC5F4\uC5B4 \uBCD1\uD569\uD55C \uB4A4 \uBC18\uC601\uD574 \uC8FC\uC138\uC694`
    );
  }
  async function writeChat(slot, seenChatId, update) {
    const fresh = await readChat(slot);
    if (seenChatId && fresh.id && fresh.id !== seenChatId) {
      throw new HostError("changed", "\uCC57\uC774 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4 (\uBCF5\uC0AC\xB7\uBE0C\uB79C\uCE58 \uC9C1\uD6C4\uC77C \uC218 \uC788\uC2B5\uB2C8\uB2E4). \uB2E4\uC2DC \uBD88\uB7EC\uC640 \uC8FC\uC138\uC694");
    }
    if (update.messages && update.beforeTurns) {
      const live = fresh.message.map((m) => ({ id: String(m.chatId ?? ""), h: fnv32(String(m.data ?? "")) }));
      if (canon(live) !== canon(update.beforeTurns)) {
        throw new HostError(
          "changed",
          "RisuAI \uCABD\uC5D0\uC11C \uCC57\uC774 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4 (\uD134\uC774 \uB298\uC5C8\uAC70\uB098 \uC218\uC815\uB418\uC5C8\uC2B5\uB2C8\uB2E4). \uD328\uB110\uC744 \uB2E4\uC2DC \uC5F4\uC5B4 \uBCD1\uD569\uD55C \uB4A4 \uBC18\uC601\uD574 \uC8FC\uC138\uC694"
        );
      }
    }
    if (update.localLore && update.loreBefore) {
      checkList("\uB85C\uC5B4\uBD81", fresh.localLore, update.loreBefore);
    }
    const next = { ...fresh };
    const parts = [];
    let applied = 0;
    let mode2 = "noop";
    if (update.messages) {
      next.message = update.messages;
      applied = update.messages.length;
      mode2 = "replace";
      parts.push("message");
    } else if (update.edits?.length) {
      const byId = /* @__PURE__ */ new Map();
      fresh.message.forEach((m, i) => {
        if (m.chatId) byId.set(m.chatId, i);
      });
      for (const e of update.edits) {
        const idx = byId.get(e.msgId);
        if (idx === void 0) {
          throw new HostError("missing", `\uD134\uC774 \uB77C\uC774\uBE0C \uCC57\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4: ${e.msgId}`);
        }
        if (String(fresh.message[idx].data ?? "") !== e.before) {
          throw new HostError("changed", `RisuAI \uCABD\uC5D0\uC11C \uD134\uC774 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4 (${e.msgId}). \uB2E4\uC2DC \uBD88\uB7EC\uC640 \uC8FC\uC138\uC694`);
        }
      }
      const edits = update.edits;
      next.message = fresh.message.map((m, i) => {
        const hit = edits.find((e) => byId.get(e.msgId) === i);
        return hit ? { ...m, data: hit.after } : m;
      });
      applied = edits.length;
      mode2 = "edits";
      parts.push("message");
    }
    if (update.localLore) {
      next.localLore = update.localLore;
      parts.push("localLore");
    }
    if (update.memory) {
      Object.assign(next, update.memory);
      parts.push(...Object.keys(update.memory));
    }
    if (!parts.length) return { applied: 0, mode: "noop", parts };
    await Risuai.setChatToIndex(slot.characterIndex, slot.chatIndex, next);
    return { applied, mode: mode2, parts };
  }
  async function saveAsCopy(slot, update, name) {
    const fresh = await readChat(slot);
    const char = await readCharacter(slot.characterIndex);
    const chats = Array.isArray(char.chats) ? char.chats.slice() : [];
    const copy = {
      ...fresh,
      ...update.memory ?? {},
      id: cryptoRandomId(),
      name,
      ...update.messages ? { message: update.messages } : {},
      ...update.localLore ? { localLore: update.localLore } : {}
    };
    chats.unshift(copy);
    await Risuai.setCharacterToIndex(slot.characterIndex, { ...char, chats });
    return 0;
  }
  async function writeCharacter(characterIndex, seenChaId, update) {
    if ("chats" in update || "chatPage" in update) {
      throw new HostError("failed", "\uCE74\uB4DC \uBC18\uC601\uC774 chats \uB97C \uAC74\uB4DC\uB9AC\uB824 \uD588\uC2B5\uB2C8\uB2E4 - \uBC84\uADF8\uC785\uB2C8\uB2E4");
    }
    const fresh = await readCharacter(characterIndex);
    if (seenChaId && fresh.chaId && fresh.chaId !== seenChaId) {
      throw new HostError("changed", "\uC120\uD0DD\uB41C \uBD07\uC774 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uBD07 \uC120\uD0DD \uD0ED\uC5D0\uC11C \uB2E4\uC2DC \uBD88\uB7EC\uC640 \uC8FC\uC138\uC694");
    }
    const next = { ...fresh };
    const parts = [];
    let applied = 0;
    const liveValue = (field) => {
      if (field === "characterVersion") {
        const add = fresh["additionalData"];
        const v = add && typeof add === "object" ? add["character_version"] : void 0;
        return String(v ?? fresh["characterVersion"] ?? "");
      }
      return String(fresh[field] ?? "");
    };
    for (const e of update.fields ?? []) {
      if (liveValue(e.field) !== e.before) {
        throw new HostError("changed", `RisuAI \uCABD\uC5D0\uC11C \uCE74\uB4DC\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4 (${e.field}). \uB2E4\uC2DC \uBD88\uB7EC\uC640 \uC8FC\uC138\uC694`);
      }
    }
    const LIST_LABEL = {
      alternateGreetings: "\uB300\uCCB4 \uC778\uC0AC\uB9D0",
      globalLore: "\uBD07 \uB85C\uC5B4\uBD81",
      customscript: "Regex",
      triggerscript: "\uD2B8\uB9AC\uAC70",
      additionalAssets: "\uC5D0\uC14B",
      emotionImages: "\uAC10\uC815 \uC774\uBBF8\uC9C0",
      ccAssets: "\uC5D0\uC14B"
    };
    for (const [key, label] of Object.entries(LIST_LABEL)) {
      const wanted = update[key];
      const before = update.before?.[key];
      if (wanted && before !== void 0) checkList(label, fresh[key], before);
    }
    for (const e of update.fields ?? []) {
      if (e.field === "characterVersion") {
        const add = { ...fresh["additionalData"] ?? {} };
        add["character_version"] = e.after;
        next["additionalData"] = add;
      }
      next[e.field] = e.after;
      applied += 1;
      parts.push(e.field);
    }
    if (update.alternateGreetings) {
      next.alternateGreetings = update.alternateGreetings;
      parts.push("alternateGreetings");
    }
    if (update.globalLore) {
      next.globalLore = update.globalLore;
      parts.push("globalLore");
    }
    if (update.customscript) {
      next["customscript"] = update.customscript;
      parts.push("customscript");
    }
    if (update.triggerscript) {
      next["triggerscript"] = update.triggerscript;
      parts.push("triggerscript");
    }
    for (const k of ["additionalAssets", "emotionImages", "ccAssets"]) {
      if (update[k]) {
        next[k] = update[k];
        parts.push(k);
      }
    }
    if (!parts.length) return { applied: 0, mode: "noop", parts };
    next.chats = fresh.chats;
    next.chatPage = fresh.chatPage;
    await Risuai.setCharacterToIndex(characterIndex, next);
    return { applied, mode: "edits", parts };
  }
  async function cloneBot(sourceIndex, seenChaId, name, update, familyKey = "") {
    const src = await readCharacter(sourceIndex);
    if (seenChaId && src.chaId && src.chaId !== seenChaId) {
      throw new HostError("changed", "\uBD07\uC774 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uBD07 \uC120\uD0DD \uD0ED\uC5D0\uC11C \uB2E4\uC2DC \uBD88\uB7EC\uC640 \uC8FC\uC138\uC694");
    }
    const copy = structuredClone(src);
    if (familyKey) {
      const ext = { ...copy["extentions"] ?? {} };
      ext["risu_hina"] = { ...ext["risu_hina"] ?? {}, family: familyKey };
      copy["extentions"] = ext;
    }
    for (const e of update.fields ?? []) copy[e.field] = e.after;
    if (update.alternateGreetings) copy.alternateGreetings = update.alternateGreetings;
    if (update.globalLore) copy.globalLore = update.globalLore;
    if (update.customscript) copy["customscript"] = update.customscript;
    if (update.triggerscript) copy["triggerscript"] = update.triggerscript;
    copy.chaId = cryptoRandomId();
    copy.name = name;
    delete copy["realmId"];
    let dbSlice = null;
    try {
      await Risuai.hideContainer();
    } catch {
    }
    try {
      dbSlice = await Risuai.getDatabase(["characters"]);
    } catch (e) {
      throw new HostError("failed", "\uCE90\uB9AD\uD130 \uBAA9\uB85D\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + String(e));
    } finally {
      try {
        await Risuai.showContainer("fullscreen");
      } catch {
      }
    }
    const characters = dbSlice && Array.isArray(dbSlice["characters"]) ? dbSlice["characters"].slice() : null;
    if (!characters) {
      throw new HostError(
        "failed",
        "\uBCF5\uC81C\uC5D0\uB294 'db' \uAD8C\uD55C\uC774 \uD544\uC694\uD569\uB2C8\uB2E4. RisuAI\uAC00 \uB744\uC6B4 \uAD8C\uD55C \uC694\uCCAD\uC744 \uD5C8\uC6A9\uD558\uACE0 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694"
      );
    }
    const srcDb = characters.find((c) => c.chaId && c.chaId === src.chaId) ?? characters[sourceIndex];
    const srcChats = Array.isArray(srcDb?.chats) ? srcDb.chats : [];
    const real = srcChats.filter((c) => c && Array.isArray(c["message"]));
    if (real.length) {
      copy.chats = structuredClone(real).map((c) => c["id"] ? { ...c, id: cryptoRandomId() } : c);
      const page = Number(srcDb?.chatPage ?? src.chatPage ?? 0);
      copy.chatPage = Number.isFinite(page) ? Math.max(0, Math.min(page, real.length - 1)) : 0;
    } else {
      copy.chats = [{ message: [], note: "", name: "Chat 1", localLore: [] }];
      copy.chatPage = 0;
    }
    characters.push(copy);
    await Risuai.setDatabase({ characters });
    try {
      await Risuai.checkCharOrder?.();
    } catch {
    }
    return copy.chaId ?? "";
  }
  function cryptoRandomId() {
    try {
      return crypto.randomUUID();
    } catch {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : r & 3 | 8).toString(16);
      });
    }
  }
  function download(filename, text2, mime = "text/plain;charset=utf-8") {
    downloadBlob(filename, new Blob([text2], { type: mime }));
  }
  function downloadBytes(filename, bytes, mime = "application/octet-stream") {
    const buf = new Uint8Array(bytes.byteLength);
    buf.set(bytes);
    downloadBlob(filename, new Blob([buf], { type: mime }));
  }
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 4e3);
  }
  function copyToClipboard(text2) {
    const ta = document.createElement("textarea");
    ta.value = text2;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  // src/state.ts
  var AppState = class {
    health = null;
    connectError = "";
    slot = null;
    slotError = "";
    character = null;
    liveChat = null;
    workspace = null;
    /** What the last upload's merge did, until the shell has announced it. */
    lastMerge = null;
    /** Which half of the panel is open ('chat' | 'bot'); the shell keeps it current, the agent is told. */
    editMode = "bot";
    activeChatKey = "";
    botChanges = null;
    /**
     * The background asset importer's progress for the live bot, or null before
     * it has started. The bot bar's 반영 gate and the picker's bot card both
     * read it; `syncAssets` drives it.
     */
    assetSync = null;
    assetSyncCtl = null;
    assetSyncEmitAt = 0;
    turns = [];
    totalTurns = 0;
    warnings = [];
    changes = null;
    /**
     * out/ files the agent made that the files tab has not shown yet. The tab
     * button wears the count as a badge; opening the tab clears it.
     */
    unseenOutputs = [];
    /** A file the user asked to see (from an agent log line); the files tab opens it. */
    openFileRequest = null;
    /** A tab an approved agent proposal asked for; the shell moves there. */
    openTabRequest = null;
    /** Bumped when the workspace listing changed; the files tab reloads when it moved. */
    filesRev = 0;
    /**
     * Bumped whenever the working state changed underneath the tabs - a
     * restore, a reset, a commit, an approved proposal. Tabs that cache what
     * they show (lorebook, memory) compare it to the value they last rendered
     * and reload when it moved, instead of each tab having to know every path
     * that can change its data.
     */
    epoch = 0;
    listeners = /* @__PURE__ */ new Set();
    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit() {
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch (e) {
          console.log("[risu-hina] listener failed", e);
        }
      }
    }
    get activeChat() {
      return this.workspace?.chats.find((c) => c.chatKey === this.activeChatKey) ?? null;
    }
    /** The workspace is per bot, so file and upload calls address the character. */
    get activeCharKey() {
      return this.workspace?.charKey ?? "";
    }
    /**
     * What the bot tabs address. Always the live workspace: the panel's
     * standing premise is "select the bot in RisuAI, then open the plugin" -
     * other bots are not writable anyway (mainline silently drops writes to a
     * non-selected character), so there is no browsing of other workspaces.
     */
    get botKey() {
      return this.activeCharKey;
    }
    /** Whether a live, writable bot is behind the bot tabs right now. */
    get isLiveBot() {
      return !!this.activeCharKey && !!this.character;
    }
    // --- connection ---------------------------------------------------------
    async connect() {
      this.connectError = "";
      try {
        this.health = await transport.connect();
        return true;
      } catch (e) {
        this.health = null;
        this.connectError = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        this.emit();
      }
    }
    // --- host ---------------------------------------------------------------
    /** Read the selected character and its chats from RisuAI. */
    async readHost() {
      this.slotError = "";
      try {
        this.slot = await currentSlot();
        this.character = await readCharacter(this.slot.characterIndex);
        this.liveChat = await readChat(this.slot);
        return true;
      } catch (e) {
        this.slot = null;
        this.character = null;
        this.liveChat = null;
        this.slotError = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        this.emit();
      }
    }
    /**
     * Upload the character's chats to the backend.
     *
     * Only the currently open chat is sent by default. A 394-turn chat is several
     * megabytes, and sending every chat of a character on every panel open would
     * make the common case pay for the rare one.
     */
    async upload(opts = {}) {
      if (!this.slot || !this.character) throw new Error("\uD638\uC2A4\uD2B8 \uC0C1\uD0DC\uB97C \uBA3C\uC800 \uC77D\uC5B4\uC57C \uD569\uB2C8\uB2E4");
      const chats = Array.isArray(this.character.chats) ? this.character.chats : [];
      const payload = {
        charId: this.character.chaId ?? "",
        characterIndex: this.slot.characterIndex,
        card: cardOf(this.character),
        // The card is the full character now (minus chats); the backend records
        // this and refuses card write-backs built on whitelist-era uploads.
        cardFull: true,
        force: Boolean(opts.force),
        // Scoped re-reads after a write-back: the card half or the chat half,
        // never both, so writing one does not discard edits pending in the other.
        cardReset: Boolean(opts.cardReset),
        chatReset: Boolean(opts.chatReset)
      };
      if (opts.allChats) {
        payload.chats = chats.map((c, i) => ({ chat: c, chatIndex: i }));
      } else {
        payload.chats = [{ chat: this.liveChat, chatIndex: this.slot.chatIndex }];
      }
      const res = await transport.upload("/workspace", payload);
      this.workspace = res.workspace;
      this.lastMerge = res.workspace.merge ?? null;
      if (!this.activeChatKey || !this.workspace.chats.some((c) => c.chatKey === this.activeChatKey)) {
        this.activeChatKey = this.workspace.chats[0]?.chatKey ?? "";
      }
      this.emit();
      void this.refreshBotChanges();
      void this.syncAssets();
      return res.workspace;
    }
    // --- assets (background importer) ----------------------------------------
    /**
     * Start (or restart) the asset sync for the live bot. A run already going
     * for the same bot is left alone unless `force`; a run for another bot is
     * cancelled first. Progress lands in `assetSync` and is emitted at most a
     * few times a second - the picker re-renders on every emit.
     */
    syncAssets(force = false) {
      const ck = this.activeCharKey;
      const char = this.character;
      if (!ck || !char) return;
      if (this.assetSync && this.assetSync.charKey === ck && syncBusy(this.assetSync) && !force) return;
      this.cancelAssetSync();
      const web = transport.hostPlatform === "web";
      this.assetSyncCtl = syncAssets(char, ck, {
        hubPull: web,
        concurrency: web ? 4 : 6
      }, (p) => {
        this.assetSync = p;
        const now = Date.now();
        const settled = !syncBusy(p);
        if (settled || now - this.assetSyncEmitAt > 400) {
          this.assetSyncEmitAt = now;
          this.emit();
        }
      });
      this.assetSync = null;
      void this.assetSyncCtl.done.then((p) => {
        if (p.phase === "error") void clientLog("warn", "asset sync failed", { error: p.error, charKey: ck });
      });
    }
    cancelAssetSync() {
      if (this.assetSyncCtl) {
        this.assetSyncCtl.cancel();
        this.assetSyncCtl = null;
      }
    }
    /** Why 반영 has to wait for the assets, or null when it need not. */
    get assetGateReason() {
      const p = this.assetSync;
      if (!p || p.charKey !== this.activeCharKey) return null;
      if (syncBusy(p)) return describeSync(p) + " \u2014 \uB05D\uB098\uBA74 \uBC18\uC601\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4";
      if (p.phase === "error") return describeSync(p) + " \u2014 \uBD07 \uCE74\uB4DC\uC5D0\uC11C \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD574 \uC8FC\uC138\uC694";
      if (p.phase === "cancelled") return "\uC5D0\uC14B \uC784\uD3EC\uD2B8\uAC00 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uBD07 \uCE74\uB4DC\uC5D0\uC11C \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD574 \uC8FC\uC138\uC694";
      return null;
    }
    // --- turns --------------------------------------------------------------
    async loadTurns(chatKey = this.activeChatKey, start = 0, limit = 2e3) {
      if (!chatKey) return;
      const res = await transport.get(
        "/turns",
        { chatKey, start, limit }
      );
      this.activeChatKey = chatKey;
      this.turns = res.turns;
      this.totalTurns = res.total;
      this.emit();
      void this.refreshChanges();
    }
    /**
     * Refresh the pending-change summary for the active chat.
     *
     * Cheap on the server (counts only) and called after anything that can
     * change it, so the shared bar never shows a count that is one save behind.
     * A failure here is not worth surfacing - the next call fixes it.
     */
    async refreshChanges() {
      if (!this.activeChatKey) {
        this.changes = null;
        this.emit();
        return null;
      }
      try {
        this.changes = await transport.get("/changes", { chatKey: this.activeChatKey });
      } catch {
        this.changes = null;
      }
      this.emit();
      return this.changes;
    }
    /** The working state changed underneath the tabs; tell them to reload. */
    bump() {
      this.epoch += 1;
      this.emit();
    }
    /** The workspace listing changed (a file was made, uploaded or deleted). */
    touchFiles(newOutputs = []) {
      for (const p of newOutputs) if (!this.unseenOutputs.includes(p)) this.unseenOutputs.push(p);
      this.filesRev += 1;
      this.emit();
    }
    requestOpenFile(path) {
      this.openFileRequest = path;
      this.emit();
    }
    /** The files tab is showing; whatever was unseen has now been seen. */
    markOutputsSeen() {
      if (!this.unseenOutputs.length) return;
      this.unseenOutputs = [];
      this.emit();
    }
    /**
     * Edit one turn and patch it locally instead of reloading everything.
     *
     * A 394-turn chat's /turns response was measured at 3.4MB. Refetching it
     * after every single-turn save made each keystroke-to-saved round trip cost
     * megabytes, which is most of why the editor felt sluggish. The server
     * already told us the write succeeded and we know both sides of the text, so
     * the one row that changed is updated in place.
     */
    async editTurn(msgId, before, after) {
      await transport.post("/turn", { chatKey: this.activeChatKey, msgId, before, after });
      const t = this.turns.find((x) => x.msgId === msgId);
      if (t) {
        if (t.original === null || t.original === void 0) t.original = before;
        t.body = after;
        t.changed = !t.isNew && t.original !== after;
        this.emit();
        void this.refreshChanges();
      } else {
        await this.loadTurns();
      }
    }
    async bulk(params) {
      return await transport.post("/turn/bulk", { chatKey: this.activeChatKey, ...params });
    }
    async deleteRange(fromSeq, toSeq) {
      await transport.post("/turn/delete", { chatKey: this.activeChatKey, fromSeq, toSeq });
      await this.loadTurns();
    }
    async patch() {
      return await transport.get("/patch", { chatKey: this.activeChatKey });
    }
    /**
     * Make the current state the new baseline, after RisuAI confirmed the write.
     *
     * Called only on success, so a failed write-back leaves the diff intact and
     * the retry meaningful.
     */
    /**
     * The chat landed in RisuAI: snapshot it, then re-read what RisuAI now
     * holds. See `rereadCard` for why the working copy is not kept.
     */
    async commit(label) {
      const r = await transport.post(
        "/commit",
        { chatKey: this.activeChatKey, label }
      );
      await this.rereadChat();
      this.bump();
      return r;
    }
    async reset() {
      await transport.post("/reset", { chatKey: this.activeChatKey });
      await this.loadTurns();
      this.bump();
    }
    async checkpoint(label) {
      await transport.post("/checkpoint", { chatKey: this.activeChatKey, label });
    }
    async checkpoints() {
      const res = await transport.get("/checkpoints", { chatKey: this.activeChatKey });
      return res.checkpoints ?? [];
    }
    async renameCheckpoint(id, label) {
      await transport.post("/checkpoint/rename", { chatKey: this.activeChatKey, id, label });
    }
    async deleteCheckpoint(id) {
      await transport.post("/checkpoint/delete", { chatKey: this.activeChatKey, id });
    }
    /** Delete this chat's snapshots, keeping the `keep` newest. */
    async clearCheckpoints(keep = 0) {
      const r = await transport.post("/checkpoint/clear", { chatKey: this.activeChatKey, keep });
      return r.deleted;
    }
    async restore(id) {
      const r = await transport.post(
        "/checkpoint/restore",
        { chatKey: this.activeChatKey, id }
      );
      await this.loadTurns();
      this.bump();
      return r;
    }
    // --- write back ---------------------------------------------------------
    /**
     * Push the working state into RisuAI - turns, this chat's lorebook and its
     * memory - in one host write.
     *
     * Which path the turns take is decided by the backend's `structural` flag,
     * not by inspecting the lists: once turns were inserted, deleted or
     * reordered, a per-turn patch cannot express the result and the whole array
     * has to go. Lorebook and memory are sent whole whenever anything in them
     * differs from the baseline; the host write replaces the field either way.
     */
    async writeBack() {
      if (!this.slot) throw new Error("\uD638\uC2A4\uD2B8 \uC0C1\uD0DC\uB97C \uBA3C\uC800 \uC77D\uC5B4\uC57C \uD569\uB2C8\uB2E4");
      const patch = await this.patch();
      const update = this.updateFrom(patch, false);
      if (!update) return { mode: "noop", applied: 0, lore: 0, memory: 0, warnings: patch.warnings };
      const r = await writeChat(this.slot, this.liveChat?.id, update);
      return {
        mode: r.mode,
        applied: r.applied,
        lore: patch.lore?.changed ?? 0,
        memory: patch.memory?.changed ?? 0,
        warnings: patch.warnings
      };
    }
    /**
     * The host update a patch calls for, or null when nothing differs.
     *
     * `whole` asks for every part regardless of whether it changed - a copy has
     * to carry the working state in full, not only the parts that moved.
     */
    updateFrom(patch, whole) {
      const update = {};
      if (patch.structural) {
        if (!patch.messages) throw new Error("\uAD6C\uC870 \uBCC0\uACBD\uC778\uB370 \uBC31\uC5D4\uB4DC\uAC00 \uBA54\uC2DC\uC9C0 \uBC30\uC5F4\uC744 \uC8FC\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4");
        update.messages = patch.messages;
      } else if (patch.edits.length) {
        update.edits = patch.edits;
      }
      if (patch.lore && (whole || patch.lore.changed)) update.localLore = patch.lore.localLore;
      if (patch.memory && (whole || patch.memory.changed)) update.memory = patch.memory.data;
      if (!whole) {
        if (update.messages) update.beforeTurns = patch.beforeTurns;
        if (update.localLore) update.loreBefore = patch.lore?.before;
      }
      return Object.keys(update).length ? update : null;
    }
    async saveCopy(name) {
      if (!this.slot) throw new Error("\uD638\uC2A4\uD2B8 \uC0C1\uD0DC\uB97C \uBA3C\uC800 \uC77D\uC5B4\uC57C \uD569\uB2C8\uB2E4");
      const patch = await this.patch();
      const update = this.updateFrom(patch, true) ?? {};
      if (!update.messages) update.messages = await this.messagesFromExport() ?? void 0;
      delete update.edits;
      await saveAsCopy(this.slot, update, name);
    }
    async messagesFromExport() {
      const res = await transport.get(
        "/export/risuchat",
        { chatKey: this.activeChatKey }
      );
      return res.envelope?.data?.message ?? null;
    }
    // --- exports ------------------------------------------------------------
    async exportMarkdown() {
      return await transport.get("/export/md", { chatKey: this.activeChatKey });
    }
    async exportRisuchat() {
      return await transport.get("/export/risuchat", { chatKey: this.activeChatKey });
    }
    // --- agent --------------------------------------------------------------
    sessionId = "";
    async agentSession(sessionId) {
      const r = await transport.get("/session", {
        chatKey: this.activeChatKey,
        sessionId: sessionId || void 0
      });
      this.sessionId = r.session?.sessionId ?? "";
      return r;
    }
    async agentSessions() {
      const r = await transport.get("/sessions", {
        chatKey: this.activeChatKey
      });
      return r.sessions ?? [];
    }
    /** Start a fresh conversation; the previous one stays in the history list. */
    async newAgentSession() {
      const r = await transport.post("/session", { chatKey: this.activeChatKey });
      this.sessionId = r.sessionId;
    }
    /**
     * Send one instruction, yielding NDJSON events as they arrive.
     *
     * A session is created lazily so opening the tab costs nothing; only actually
     * talking to the agent creates one.
     */
    async *agentChat(prompt, signal) {
      if (!this.sessionId) {
        const r = await transport.post("/session", { chatKey: this.activeChatKey });
        this.sessionId = r.sessionId;
      }
      yield* transport.stream("/chat", { sessionId: this.sessionId, prompt, mode: this.editMode }, signal);
    }
    // --- merge conflicts ------------------------------------------------------
    /** Rows where our copy and RisuAI's both moved since the last open. */
    async conflicts(scope = "both") {
      const q = {};
      if (scope !== "card" && this.activeChatKey) q.chatKey = this.activeChatKey;
      if (scope !== "chat" && this.activeCharKey) q.charKey = this.activeCharKey;
      if (!Object.keys(q).length) return [];
      const r = await transport.get("/conflicts", q);
      return r.conflicts ?? [];
    }
    async resolveConflict(kind, id, choice) {
      await transport.post("/conflict/resolve", { kind, id, choice });
      await this.afterResolve();
    }
    async resolveAllConflicts(choice, scope) {
      const r = await transport.post("/conflict/resolve", {
        all: true,
        choice,
        ...scope === "chat" ? { chatKey: this.activeChatKey } : { charKey: this.activeCharKey }
      });
      await this.afterResolve();
      return r.resolved ?? 0;
    }
    async afterResolve() {
      if (this.activeChatKey) await this.loadTurns();
      await this.refreshChanges();
      await this.refreshBotChanges();
      this.epoch += 1;
      this.emit();
    }
    async stagedEdits() {
      const r = await transport.get("/staged", { chatKey: this.activeChatKey });
      return r.staged ?? [];
    }
    async approveStaged(approve) {
      const r = await transport.post(
        "/approve",
        { chatKey: this.activeChatKey, all: true, approve }
      );
      void this.refreshChanges();
      return r;
    }
    // --- settings -----------------------------------------------------------
    async getConfig() {
      return await transport.get("/config");
    }
    async setConfig(patch) {
      await transport.post("/config", { config: patch });
    }
    async testAgent(kind = "general") {
      return await transport.post("/config/test", { section: kind === "search" ? "agent_search" : "agent" }, 24e4);
    }
    // --- web search provider (what the search agent searches with) ------------
    async websearch() {
      return await transport.get("/websearch");
    }
    async saveWebsearch(patch) {
      await transport.post("/config", { config: { websearch: patch } });
    }
    /** One real search in the configured mode. Native mode probes several
     *  shapes at up to a minute each, so the wait is generous. */
    async testWebsearch(query) {
      return await transport.post("/websearch/test", { query }, 33e4);
    }
    // --- diagnostics ----------------------------------------------------------
    async logs(limit = 300, level = "") {
      return await transport.get(
        `/logs?limit=${limit}` + (level ? "&level=" + encodeURIComponent(level) : "")
      );
    }
    async diagnostics() {
      return await transport.get("/diag");
    }
    // --- backend update -------------------------------------------------------
    async updateCheck() {
      return await transport.post("/update/check", {}, 45e3);
    }
    /**
     * Install and restart.
     *
     * The backend replies and then exits on a timer, so the connection this
     * request rode in on is the last one that version answers. Polling /health
     * afterwards is how the panel finds out it came back - and finding out is
     * the point, because a restart that fails looks exactly like a slow one.
     */
    async updateApply() {
      return await transport.post("/update/apply", {}, 3e5);
    }
    async waitForBackend(seconds = 60) {
      const deadline = Date.now() + seconds * 1e3;
      let lastError = "";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2e3));
        try {
          const h = await transport.connect();
          this.health = h;
          this.emit();
          return h.version;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      throw new Error("\uBC31\uC5D4\uB4DC\uAC00 \uB2E4\uC2DC \uC62C\uB77C\uC624\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: " + lastError);
    }
    // --- workspace files ------------------------------------------------------
    //
    // Scoped to the character, not the chat: the workspace is per bot, and its
    // uploads and outputs are shared across that bot's chats.
    /** Save a workspace file to the user's disk through the browser. */
    async downloadFile(path) {
      const bytes = await transport.postBinary("/files/download", { charKey: this.activeCharKey, path });
      const name = path.split("/").pop() || "file";
      downloadBytes(name, bytes, name.endsWith(".charx") ? "application/zip" : "application/octet-stream");
      return bytes.byteLength;
    }
    // --- charx ------------------------------------------------------------------
    async charxPreview() {
      return await transport.get("/charx/preview", { charKey: this.botKey });
    }
    /** Build out/<name>.charx on the backend from the working card + store. */
    async charxBuild(opts = {}) {
      const r = await transport.post("/charx/build", {
        charKey: this.botKey,
        allowMissing: !!opts.allowMissing,
        name: opts.name || ""
      }, 6e5);
      this.touchFiles([r.path]);
      return r;
    }
    async files() {
      return await transport.get("/files?charKey=" + encodeURIComponent(this.activeCharKey));
    }
    async readFile(path) {
      return await transport.get("/files/read?charKey=" + encodeURIComponent(this.activeCharKey) + "&path=" + encodeURIComponent(path));
    }
    async uploadFile(name, content, base64 = false, dir = "", extract = false) {
      return await transport.upload("/files/upload", base64 ? { charKey: this.activeCharKey, name, base64: content, dir, extract } : { charKey: this.activeCharKey, name, text: content, dir });
    }
    /**
     * A batch of files as one binary body: [u32 header length][JSON header][bytes…].
     * `entries[i].bytes` go in order; the header carries name, rel (subfolder
     * under `dir`) and size for each.
     */
    async uploadBatch(dir, entries, extract = false) {
      const header = new TextEncoder().encode(JSON.stringify({
        charKey: this.activeCharKey,
        dir,
        extract,
        files: entries.map((e) => ({ name: e.name, rel: e.rel, size: e.bytes.byteLength }))
      }));
      const total = 4 + header.byteLength + entries.reduce((n, e) => n + e.bytes.byteLength, 0);
      const body = new Uint8Array(total);
      new DataView(body.buffer).setUint32(0, header.byteLength);
      body.set(header, 4);
      let at = 4 + header.byteLength;
      for (const e of entries) {
        body.set(e.bytes, at);
        at += e.bytes.byteLength;
      }
      return await transport.postBytes("/files/upload-many", body);
    }
    /** Several files or a folder as one zip, handed to the browser to save. */
    async downloadZip(paths, name) {
      const bytes = await transport.postBinary("/files/zip", { charKey: this.activeCharKey, paths, name });
      downloadBytes(name.endsWith(".zip") ? name : name + ".zip", bytes, "application/zip");
      return bytes.byteLength;
    }
    /** Raw bytes of a workspace file (an image preview, a thumbnail). POST: see tab-assets. */
    async fileBytes(path) {
      return await transport.postBinary("/files/download", { charKey: this.activeCharKey, path });
    }
    async mkdirFile(path) {
      await transport.post("/files/mkdir", { charKey: this.activeCharKey, path });
    }
    async moveFile(from, to) {
      return await transport.post("/files/move", { charKey: this.activeCharKey, from, to });
    }
    async deleteFile(path) {
      await transport.post("/files/delete", { charKey: this.activeCharKey, path });
    }
    async cleanFiles(areas) {
      return await transport.post("/files/clean", { charKey: this.activeCharKey, areas });
    }
    // --- agent presets --------------------------------------------------------
    async presets() {
      return await transport.get("/presets");
    }
    providerCache = null;
    /** Provider profiles (cached for the panel's lifetime - they are code, not data). */
    async providers() {
      if (this.providerCache) return this.providerCache;
      const r = await transport.get("/catalog/providers");
      this.providerCache = r.providers ?? [];
      return this.providerCache;
    }
    /** Make a preset the one the agent runs. Writes through to the live config. */
    async selectPreset(id) {
      const r = await transport.post("/presets/select", { id });
      return r.selected;
    }
    async savePreset(name, values, id) {
      const r = await transport.post("/presets/save", { name, values, id });
      return r.preset;
    }
    async capturePreset(name) {
      const r = await transport.post("/presets/capture", { name });
      return r.preset;
    }
    async applyPreset(id) {
      const r = await transport.post("/presets/apply", { id });
      return r.applied;
    }
    async deletePreset(id) {
      await transport.post("/presets/delete", { id });
    }
    /** Only the search agent may run without a preset. */
    async deselectPreset(kind) {
      await transport.post("/presets/deselect", { kind });
    }
    // --- API keys ---------------------------------------------------------------
    async apiKeys() {
      return await transport.get("/keys");
    }
    async saveApiKey(values, id) {
      const r = await transport.post("/keys/save", { values, id });
      return r.key;
    }
    async deleteApiKey(id) {
      await transport.post("/keys/delete", { id });
    }
    /** models.dev, through the backend's daily cache. */
    async modelCatalog(q, provider = "", refresh8 = false) {
      return await transport.get("/models/catalog", { q, provider, refresh: refresh8 ? "1" : "" });
    }
    // --- OpenAI subscription (codex) login -----------------------------------------
    async codexStatus() {
      return await transport.get("/codex/status");
    }
    async codexLoginStart() {
      return await transport.post("/codex/login/start", {});
    }
    async codexLoginStatus(state2) {
      return await transport.get("/codex/login/status", { state: state2 });
    }
    async codexLoginComplete(redirect, state2 = "") {
      return await transport.post("/codex/login/complete", { redirect, state: state2 });
    }
    async codexLogout() {
      await transport.post("/codex/logout", {});
    }
    // --- permission prompts (shell / pip while a turn runs) --------------------------
    async permits() {
      if (!this.sessionId) return [];
      const r = await transport.get("/permits", { sessionId: this.sessionId });
      return r.pending ?? [];
    }
    async decidePermit(id, allow, always = false) {
      await transport.post("/permits/decide", { id, allow, always });
    }
    // --- skills ---------------------------------------------------------------
    async skills() {
      return await transport.get("/skills");
    }
    async skill(id) {
      const r = await transport.get("/skills/get", { id });
      return r.skill;
    }
    async saveSkill(v) {
      const r = await transport.post("/skills/save", v);
      return r.skill;
    }
    /** A file inside a skill folder. Binary-safe: everything goes as base64. */
    async putSkillFile(id, path, file) {
      const body = await fileBase64(file);
      return await transport.post("/skills/file", { id, path, body, base64: true });
    }
    async deleteSkillFile(id, path) {
      await transport.post("/skills/file/delete", { id, path });
    }
    /** Register a file as a skill. The extension decides whether it is a script. */
    /** Import a skill from a file: .md/.py become a skill of their own, .zip is a whole folder. */
    async uploadSkill(file) {
      const zip = /\.zip$/i.test(file.name);
      const payload = zip ? { filename: file.name, body: await fileBase64(file), base64: true } : { filename: file.name, body: await file.text() };
      const r = await transport.post("/skills/upload", payload);
      return r.skill;
    }
    async toggleSkill(id, enabled) {
      await transport.post("/skills/toggle", { id, enabled });
    }
    async deleteSkill(id) {
      await transport.post("/skills/delete", { id });
    }
    async skillPrompt() {
      return await transport.get("/skills/preview");
    }
    // --- the approval queue ----------------------------------------------------
    async actions() {
      const r = await transport.get(
        "/actions?chatKey=" + encodeURIComponent(this.activeChatKey)
      );
      return r.actions;
    }
    /**
     * Approve or reject one proposal, and carry it out if it is ours to do.
     *
     * The backend runs what it can and hands back a `host` block for what it
     * cannot - writing to the live chat and saving a copy both need APIs that
     * only exist inside this iframe. The result is reported back either way, so
     * a failure here does not leave a queue entry claiming success.
     */
    async decideAction(id, approve) {
      const r = await transport.post("/actions/decide", {
        chatKey: this.activeChatKey,
        id,
        approve
      });
      if (!r.approved) return "\uAC70\uC808\uD588\uC2B5\uB2C8\uB2E4.";
      if (!r.host) {
        this.bump();
        void this.refreshChanges();
        return String(r.result ?? "\uC2E4\uD589\uD588\uC2B5\uB2C8\uB2E4.");
      }
      try {
        let detail = "";
        if (r.host.kind === "host_writeback") {
          const out = await this.writeBack();
          detail = `${out.applied}\uAC74\uC744 RisuAI\uC5D0 \uBC18\uC601\uD588\uC2B5\uB2C8\uB2E4.`;
        } else if (r.host.kind === "host_save_copy") {
          const name = String(r.host.args?.name || "") || "\uC0AC\uBCF8";
          await this.saveCopy(name);
          detail = `\u201C${name}\u201D \uC73C\uB85C \uBCF5\uC0AC\uBCF8\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.`;
        } else if (r.host.kind === "host_card_writeback") {
          const out = await this.cardWriteBack();
          detail = out.mode === "noop" ? "\uCE74\uB4DC\uC5D0 \uBC18\uC601\uD560 \uBCC0\uACBD\uC774 \uC5C6\uC5C8\uC2B5\uB2C8\uB2E4." : `\uCE74\uB4DC \uBCC0\uACBD ${out.applied}\uAC74\uC744 RisuAI\uC5D0 \uBC18\uC601\uD588\uC2B5\uB2C8\uB2E4.`;
        } else if (r.host.kind === "host_clone_bot") {
          const name = String(r.host.args?.name || "") || "\uBCF5\uC81C \uBD07";
          await this.cloneBot(name);
          detail = `\uBCF5\uC81C \uBD07 \u201C${name}\u201D \uC744 \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4. RisuAI \uBAA9\uB85D\uC5D0\uC11C \uD655\uC778\uD574 \uC8FC\uC138\uC694.`;
        } else if (r.host.kind === "host_open_tab") {
          const tab = String(r.host.args?.tab || "");
          this.openTabRequest = tab;
          this.emit();
          detail = "\uD0ED\uC744 \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.";
        } else if (r.host.kind === "host_asset_add" || r.host.kind === "host_asset_replace") {
          detail = await this.applyAssetAction(r.host.kind, r.host.args ?? {});
        } else {
          throw new Error("\uD50C\uB7EC\uADF8\uC778\uC774 \uBAA8\uB974\uB294 \uC791\uC5C5\uC785\uB2C8\uB2E4: " + r.host.kind);
        }
        await transport.post("/actions/complete", { chatKey: this.activeChatKey, id, ok: true, detail });
        return detail;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        await transport.post("/actions/complete", {
          chatKey: this.activeChatKey,
          id,
          ok: false,
          detail: why
        });
        throw e;
      }
    }
    // --- lorebook -------------------------------------------------------------
    async lore(scope) {
      const q = "/lore?charKey=" + encodeURIComponent(this.activeCharKey) + (scope ? "&scope=" + scope : "");
      const r = await transport.get(q);
      return r.lore;
    }
    async saveLore(id, entry) {
      await transport.post("/lore/update", { charKey: this.activeCharKey, id, entry });
      void this.refreshChanges();
    }
    async addLore(entry, scope) {
      const r = await transport.post("/lore", {
        charKey: this.activeCharKey,
        entry,
        scope,
        chatKey: scope === "local" ? this.activeChatKey : void 0
      });
      void this.refreshChanges();
      return r.id;
    }
    async deleteLore(id) {
      await transport.post("/lore/delete", { charKey: this.activeCharKey, id });
      void this.refreshChanges();
    }
    async moveLore(id, toSeq) {
      await transport.post("/lore/move", { charKey: this.activeCharKey, id, toSeq });
      void this.refreshChanges();
      void this.refreshBotChanges();
    }
    // --- long-term memory -----------------------------------------------------
    async memory() {
      return await transport.get("/memory?chatKey=" + encodeURIComponent(this.activeChatKey));
    }
    async saveMemory(id, body, title) {
      const r = await transport.post("/memory/update", {
        chatKey: this.activeChatKey,
        id,
        body,
        title
      });
      void this.refreshChanges();
      return r.item;
    }
    async addMemory(kind, body, title = "") {
      const r = await transport.post("/memory/add", {
        chatKey: this.activeChatKey,
        kind,
        body,
        title
      });
      void this.refreshChanges();
      return r.item;
    }
    async deleteMemory(id) {
      await transport.post("/memory/delete", { chatKey: this.activeChatKey, id });
      void this.refreshChanges();
    }
    // --- the card (bot editing) -----------------------------------------------
    //
    // The char-key twins of the chat calls above, addressed by `botKey`. Editing
    // works on any workspace the backend knows; only 반영/복제 touch RisuAI and
    // carry the isLiveBot gate.
    /** Same contract as refreshChanges, for the bot bar. */
    async refreshBotChanges() {
      if (!this.botKey) {
        this.botChanges = null;
        this.emit();
        return null;
      }
      try {
        this.botChanges = await transport.get("/card/changes", { charKey: this.botKey });
      } catch {
        this.botChanges = null;
      }
      this.emit();
      return this.botChanges;
    }
    /** The store's view of the bot's assets: the manifest with state and size. */
    async assetList() {
      return await transport.get("/assets/list", { charKey: this.botKey });
    }
    async cardFields() {
      return await transport.get("/card", { charKey: this.botKey });
    }
    async cardScripts(kind) {
      const r = await transport.get("/card/scripts", { charKey: this.botKey, kind });
      return r.items ?? [];
    }
    async saveCardField(id, body) {
      const r = await transport.post("/card/field", { charKey: this.botKey, id, body });
      void this.refreshBotChanges();
      return r.item;
    }
    async addGreeting(body) {
      const r = await transport.post("/card/greeting", { charKey: this.botKey, body });
      void this.refreshBotChanges();
      return r.item;
    }
    async deleteGreeting(id) {
      await transport.post("/card/greeting/delete", { charKey: this.botKey, id });
      void this.refreshBotChanges();
    }
    async saveScript(id, entry) {
      await transport.post("/card/script", { charKey: this.botKey, id, entry });
      void this.refreshBotChanges();
    }
    async addScript(kind, entry) {
      const r = await transport.post("/card/script/add", { charKey: this.botKey, kind, entry });
      void this.refreshBotChanges();
      return r.id;
    }
    async deleteScript(id) {
      await transport.post("/card/script/delete", { charKey: this.botKey, id });
      void this.refreshBotChanges();
    }
    async moveScript(id, toSeq) {
      await transport.post("/card/script/move", { charKey: this.botKey, id, toSeq });
    }
    async cardPatch() {
      return await transport.get("/card/patch", { charKey: this.botKey });
    }
    async cardCommit(label) {
      await transport.post("/card/commit", { charKey: this.botKey, label });
      this.bump();
      void this.refreshBotChanges();
    }
    async cardReset() {
      await transport.post("/card/reset", { charKey: this.botKey });
      this.bump();
      void this.refreshBotChanges();
    }
    async cardCheckpoint(label) {
      await transport.post("/card/checkpoint", { charKey: this.botKey, label });
    }
    async cardCheckpoints() {
      const r = await transport.get("/card/checkpoints", { charKey: this.botKey });
      return r.checkpoints ?? [];
    }
    async renameCardCheckpoint(id, label) {
      await transport.post("/card/checkpoint/rename", { charKey: this.botKey, id, label });
    }
    async deleteCardCheckpoint(id) {
      await transport.post("/card/checkpoint/delete", { charKey: this.botKey, id });
    }
    async clearCardCheckpoints(keep = 0) {
      const r = await transport.post("/card/checkpoint/clear", { charKey: this.botKey, keep });
      return r.deleted;
    }
    async cardRestore(id) {
      await transport.post("/card/checkpoint/restore", { charKey: this.botKey, id });
      this.bump();
      void this.refreshBotChanges();
    }
    /** The host update a card patch calls for, or null when nothing differs. */
    cardUpdateFrom(patch, whole) {
      const update = {};
      if (patch.fields.length) update.fields = patch.fields;
      if (whole || patch.alternateGreetings.changed) update.alternateGreetings = patch.alternateGreetings.list;
      if (whole || patch.globalLore.changed) update.globalLore = patch.globalLore.list;
      if (whole || patch.customscript.changed) update.customscript = patch.customscript.list;
      if (whole || patch.triggerscript.changed) update.triggerscript = patch.triggerscript.list;
      if (patch.assets && (whole || patch.assets.changed)) {
        update.emotionImages = patch.assets.emotionImages;
        update.additionalAssets = patch.assets.additionalAssets;
        update.ccAssets = patch.assets.ccAssets;
      }
      if (!whole) {
        update.before = {
          alternateGreetings: patch.alternateGreetings.before,
          globalLore: patch.globalLore.before,
          customscript: patch.customscript.before,
          triggerscript: patch.triggerscript.before,
          emotionImages: patch.assets?.before?.emotionImages,
          additionalAssets: patch.assets?.before?.additionalAssets,
          ccAssets: patch.assets?.before?.ccAssets
        };
      }
      return Object.keys(update).length ? update : null;
    }
    /**
     * Push the working card into RisuAI and, on success, move the baseline.
     *
     * Unlike the chat flow (where the bar orchestrates write → commit), the
     * whole sequence lives here because two callers need it - the bot bar and
     * an approved host_card_writeback - and they must not drift apart.
     */
    async cardWriteBack() {
      if (!this.isLiveBot) {
        throw new Error("\uBC18\uC601\uC740 RisuAI\uC5D0\uC11C \uC774 \uBD07\uC774 \uC120\uD0DD\uB418\uC5B4 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4. RisuAI\uC5D0\uC11C \uBD07\uC744 \uC120\uD0DD\uD55C \uB4A4 \uD328\uB110\uC744 \uB2E4\uC2DC \uC5F4\uC5B4 \uC8FC\uC138\uC694");
      }
      const slot = await currentSlot();
      const patch = await this.cardPatch();
      if (!patch.full) {
        throw new Error("\uAD6C\uBC84\uC804 \uC5C5\uB85C\uB4DC \uC0C1\uD0DC\uC758 \uCE74\uB4DC\uB77C \uBC18\uC601\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD328\uB110\uC744 \uB2EB\uC558\uB2E4 \uB2E4\uC2DC \uC5F4\uC5B4 \uC8FC\uC138\uC694");
      }
      const update = this.cardUpdateFrom(patch, false);
      if (!update) return { applied: 0, mode: "noop" };
      const r = await writeCharacter(slot.characterIndex, patch.chaId, update);
      await this.cardCommit("\uBC18\uC601 \uC9C1\uC804");
      await this.rereadCard();
      return { applied: r.applied, mode: r.mode };
    }
    /**
     * The card landed in RisuAI, so stop holding a copy of it.
     *
     * The old flow moved the baseline onto the working copy and kept both. The
     * diff went to zero and our copy stayed behind, and from that moment it
     * drifted from RisuAI again - which is what made a later re-open show
     * untouched rows as edits. Re-reading is the whole fix: after this the
     * working copy IS RisuAI's current card, with no history to go stale.
     *
     * Scoped to the card: a chat's pending edits are none of this write's
     * business and must not be discarded with it.
     */
    async rereadCard() {
      await this.readHost();
      if (this.slot && this.character) await this.upload({ cardReset: true });
      this.epoch += 1;
      this.emit();
    }
    /** The chat twin of rereadCard. */
    async rereadChat() {
      await this.readHost();
      if (this.slot && this.character) await this.upload({ chatReset: true });
      if (this.activeChatKey) await this.loadTurns();
      this.epoch += 1;
      this.emit();
    }
    /**
     * An approved asset proposal: bytes from the workspace -> RisuAI's asset
     * store (saveAsset, which names the key) -> the live card's reference
     * list -> the backend store under that key. Written to RisuAI at once,
     * unlike text: binary material has no working copy to stage in, and the
     * card re-upload afterwards makes the new reference the baseline.
     */
    async applyAssetAction(kind, args) {
      if (!this.isLiveBot || !this.slot) {
        throw new Error("\uC5D0\uC14B\uC744 \uB123\uC73C\uB824\uBA74 RisuAI\uC5D0\uC11C \uC774 \uBD07\uC774 \uC120\uD0DD\uB418\uC5B4 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4");
      }
      const name = String(args.name || "").trim();
      const path = String(args.path || "");
      const field = String(args.field || "additional");
      if (!name || !path) throw new Error("\uC5D0\uC14B \uC774\uB984\uACFC \uD30C\uC77C \uACBD\uB85C\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4");
      const bytes = await transport.getBinary("/files/download", { charKey: this.activeCharKey, path });
      if (!(bytes[0] === 137 && bytes[1] === 80)) throw new Error("PNG \uD30C\uC77C\uB9CC \uC5D0\uC14B\uC73C\uB85C \uB123\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4");
      const key = await Risuai.saveAsset(bytes);
      if (!key || typeof key !== "string") throw new Error("RisuAI \uAC00 \uC5D0\uC14B \uD0A4\uB97C \uB3CC\uB824\uC8FC\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4");
      const slot = await currentSlot();
      const fresh = await readCharacter(slot.characterIndex);
      const update = {};
      let placed = "";
      if (kind === "host_asset_add") {
        if (field === "emotion") {
          const list2 = Array.isArray(fresh["emotionImages"]) ? [...fresh["emotionImages"]] : [];
          list2.push([name, key]);
          update.emotionImages = list2;
          placed = "\uAC10\uC815 \uC774\uBBF8\uC9C0";
        } else {
          const list2 = Array.isArray(fresh["additionalAssets"]) ? [...fresh["additionalAssets"]] : [];
          list2.push([name, key, "png"]);
          update.additionalAssets = list2;
          placed = "\uCD94\uAC00 \uC5D0\uC14B";
        }
      } else {
        let hits = 0;
        const swap = (arr, at) => {
          if (!Array.isArray(arr)) return null;
          const next = arr.map((e) => {
            if (Array.isArray(e) && String(e[0]) === name) {
              hits += 1;
              const c = [...e];
              c[at] = key;
              return c;
            }
            return e;
          });
          return next;
        };
        const emo = swap(fresh["emotionImages"], 1);
        const add = swap(fresh["additionalAssets"], 1);
        const cc = Array.isArray(fresh["ccAssets"]) ? fresh["ccAssets"].map((c) => {
          if (c && typeof c === "object" && String(c.name) === name) {
            hits += 1;
            return { ...c, uri: key };
          }
          return c;
        }) : null;
        if (!hits) throw new Error(`\uC774\uB984\uC774 \u201C${name}\u201D \uC778 \uC5D0\uC14B\uC774 \uCE74\uB4DC\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4`);
        if (emo) update.emotionImages = emo;
        if (add) update.additionalAssets = add;
        if (cc) update.ccAssets = cc;
        placed = `${hits}\uACF3 \uAD50\uCCB4`;
      }
      await writeCharacter(slot.characterIndex, fresh.chaId, update);
      try {
        await transport.post("/assets/adopt", { charKey: this.activeCharKey, key, path, name, field });
      } catch (e) {
        void clientLog("warn", "assets/adopt failed", { error: String(e) });
      }
      await this.readHost();
      await this.upload();
      return `\uC5D0\uC14B \u201C${name}\u201D \uC744 RisuAI \uC5D0 \uC800\uC7A5\uD558\uACE0 \uCE74\uB4DC\uC5D0 \uBD99\uC600\uC2B5\uB2C8\uB2E4 (${placed}, ${key}).`;
    }
    /**
     * 새 봇으로 저장: keep editing this bot, and keep what it was.
     *
     * The bot as RisuAI holds it now - the baseline, untouched by the working
     * copy - is cloned first as "<name> (백업)", chats included. Then the
     * working copy is written into the live bot and becomes its baseline, so
     * the workspace, snapshots and conversation carry on where they are. The
     * opposite (clone the edited card, leave the original) put the user in a
     * new bot with an empty workspace and the old one still pending.
     */
    async saveAsNewBot(backupName) {
      if (!this.slot) throw new Error("\uD638\uC2A4\uD2B8 \uC0C1\uD0DC\uB97C \uBA3C\uC800 \uC77D\uC5B4\uC57C \uD569\uB2C8\uB2E4");
      const patch = await this.cardPatch();
      if (!patch.full) {
        throw new Error("\uAD6C\uBC84\uC804 \uC5C5\uB85C\uB4DC \uC0C1\uD0DC\uC758 \uCE74\uB4DC\uB77C \uC800\uC7A5\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD328\uB110\uC744 \uB2EB\uC558\uB2E4 \uB2E4\uC2DC \uC5F4\uC5B4 \uC8FC\uC138\uC694");
      }
      const family = this.workspace?.familyKey || this.activeCharKey;
      const backupChaId = await cloneBot(this.slot.characterIndex, patch.chaId, backupName, {}, family);
      const r = await this.cardWriteBack();
      return { backupChaId, applied: r.applied, mode: r.mode };
    }
    /** Create a clone bot in RisuAI carrying the working card. */
    async cloneBot(name) {
      if (!this.slot) throw new Error("\uD638\uC2A4\uD2B8 \uC0C1\uD0DC\uB97C \uBA3C\uC800 \uC77D\uC5B4\uC57C \uD569\uB2C8\uB2E4");
      const patch = await this.cardPatch();
      if (!patch.full) {
        throw new Error("\uAD6C\uBC84\uC804 \uC5C5\uB85C\uB4DC \uC0C1\uD0DC\uC758 \uCE74\uB4DC\uB77C \uBCF5\uC81C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD328\uB110\uC744 \uB2EB\uC558\uB2E4 \uB2E4\uC2DC \uC5F4\uC5B4 \uC8FC\uC138\uC694");
      }
      const update = this.cardUpdateFrom(patch, true) ?? {};
      const family = this.workspace?.familyKey || this.activeCharKey;
      const chaId = await cloneBot(this.slot.characterIndex, patch.chaId, name, update, family);
      await this.cardCommit("\uBCF5\uC81C \uC9C1\uC804");
      return chaId;
    }
  };
  async function fileBase64(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 32768) {
      bin += String.fromCharCode(...buf.subarray(i, i + 32768));
    }
    return btoa(bin);
  }
  var state = new AppState();

  // src/ui/tab-chats.ts
  function botSnapshots(editBot) {
    const wrap = el("div");
    if (!state.activeCharKey) return wrap;
    void (async () => {
      let cps = [];
      try {
        cps = await state.cardCheckpoints();
      } catch {
        return;
      }
      if (!cps.length) return;
      wrap.appendChild(el("div", { class: "sectionline" }));
      wrap.appendChild(el("div", { class: "sectiontitle", text: `\uBD07 \uC2A4\uB0C5\uC0F7 ${cps.length}\uAC1C` }));
      const list2 = el("div", { class: "chatlist snaplist" });
      const redraw = () => wrap.replaceWith(botSnapshots(editBot));
      for (const c of cps.slice(0, 8)) {
        const edit = el("button", { class: "ghost tiny", text: "\uD3B8\uC9D1" });
        edit.title = "\uC791\uC5C5\uBCF8\uC744 \uC774 \uC2DC\uC810\uC73C\uB85C \uB418\uB3CC\uB9B0 \uB4A4 \uBD07 \uD3B8\uC9D1\uC73C\uB85C \uB4E4\uC5B4\uAC11\uB2C8\uB2E4 (\uC9C1\uC804 \uC0C1\uD0DC\uB3C4 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uB0A8\uC2B5\uB2C8\uB2E4)";
        edit.addEventListener("click", async () => {
          edit.disabled = true;
          try {
            await state.cardRestore(c.id);
            setEditMode("bot", "meta");
          } catch (e) {
            flash(wrap, "\uBCF5\uC6D0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + (e instanceof Error ? e.message : String(e)));
            edit.disabled = false;
          }
        });
        const row = el("div", { class: "chatitem" });
        const del = el("button", { class: "ghost tiny", title: "\uC774 \uC2A4\uB0C5\uC0F7 \uC0AD\uC81C" });
        armed(del, "\u2715", "\uC0AD\uC81C \uD655\uC778", async () => {
          row.classList.add("deleting");
          del.disabled = true;
          edit.disabled = true;
          try {
            await state.deleteCardCheckpoint(c.id);
            redraw();
          } catch (e) {
            row.classList.remove("deleting");
            del.disabled = false;
            edit.disabled = false;
            flash(wrap, "\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + (e instanceof Error ? e.message : String(e)));
          }
        });
        row.append(
          el("span", { class: "grow", text: c.label || "(\uBB34\uC81C)" }),
          el("span", { class: "n", text: fmtTime(c.created_at * 1e3) }),
          edit,
          del
        );
        list2.appendChild(row);
      }
      if (cps.length > 8) list2.appendChild(el("div", { class: "hint", style: { padding: "4px 0" }, text: `\uADF8 \uC678 ${cps.length - 8}\uAC1C \u2014 \uBD07 \uD3B8\uC9D1 \u2192 \u{1F558} \uBC84\uC804\uC5D0\uC11C \uC804\uBD80 \uBD05\uB2C8\uB2E4` }));
      wrap.appendChild(list2);
    })();
    return wrap;
  }
  function assetSyncLine() {
    const p = state.assetSync;
    const wrap = el("div", { class: "assetsync" });
    if (!p) {
      wrap.appendChild(el("div", { class: "hint", text: state.activeCharKey ? "\uC5D0\uC14B \uB3D9\uAE30\uD654 \uB300\uAE30 \uC911" : "" }));
      return wrap;
    }
    const busy = syncBusy(p);
    const text2 = el("span", { class: "hint", text: describeSync(p) });
    const tone = p.phase === "error" ? " err" : p.phase === "done" && p.failed ? " warn" : "";
    const line = el("div", { class: "row assetline" + tone }, [text2]);
    if (busy) {
      const cancel = el("button", { class: "ghost tiny", text: "\uC911\uB2E8" });
      cancel.addEventListener("click", () => {
        state.cancelAssetSync();
      });
      line.appendChild(cancel);
      let ratio = -1;
      if (p.phase === "pulling" && p.pull && p.pull.total) ratio = p.pull.done / p.pull.total;
      else if (p.phase === "pushing" && p.toPush) ratio = (p.read + p.readFailed) / p.toPush;
      const bar3 = el("div", { class: "assetbar" + (ratio < 0 ? " indeterminate" : "") });
      const fill = el("div", { class: "assetfill" });
      if (ratio >= 0) fill.style.width = Math.round(Math.min(1, ratio) * 100) + "%";
      bar3.appendChild(fill);
      wrap.appendChild(line);
      wrap.appendChild(bar3);
    } else {
      if (p.phase === "error" || p.phase === "cancelled" || p.failed) {
        const again = el("button", { class: "ghost tiny", text: "\uB2E4\uC2DC \uB3D9\uAE30\uD654" });
        again.title = "\uC5D0\uC14B \uBAA9\uB85D\uC744 \uB2E4\uC2DC \uB300\uC870\uD558\uACE0, \uBE60\uC9C4 \uAC83\uB9CC \uAC00\uC838\uC635\uB2C8\uB2E4";
        again.addEventListener("click", () => {
          state.syncAssets(true);
        });
        line.appendChild(again);
      }
      wrap.appendChild(line);
    }
    return wrap;
  }
  var portraitUrl = "";
  var filterText = "";
  function renderChatsTab(mount) {
    clear(mount);
    const pad = el("div", { class: "pad" });
    mount.appendChild(pad);
    if (state.connectError) {
      const go = el("button", { class: "primary tiny", text: "\uC124\uC815\uC73C\uB85C \uC774\uB3D9" });
      go.addEventListener("click", () => setTab("settings"));
      pad.appendChild(el("div", { class: "notice err" }, [
        el("div", { text: "\uBC31\uC5D4\uB4DC\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." }),
        el("div", { class: "hint", text: state.connectError }),
        // Measured on web RisuAI (risuai.xyz): the first connection after
        // opening can take a couple of minutes while the host falls back from
        // its proxy route to a direct one. The panel keeps retrying meanwhile.
        transport.hostPlatform === "web" ? el("div", { class: "hint", style: { marginTop: "4px" }, text: "\uC6F9 RisuAI(risuai.xyz)\uC5D0\uC11C\uB294 \uCD5C\uCD08 \uC5F0\uACB0\uAE4C\uC9C0 3\uBD84 \uC815\uB3C4 \uAC78\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4 (\uD504\uB85D\uC2DC \u2192 \uC9C1\uC811 \uC5F0\uACB0 \uD3F4\uBC31\uC5D0 \uAC78\uB9AC\uB294 \uC2DC\uAC04). \uD328\uB110\uC774 30\uCD08\uB9C8\uB2E4 \uC790\uB3D9\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uB2C8 \uADF8\uB300\uB85C \uB450\uC154\uB3C4 \uB429\uB2C8\uB2E4." }) : null,
        el("div", { class: "row", style: { marginTop: "6px" } }, [
          el("span", { class: "hint", text: "\uC124\uC815 \u2192 \uC5F0\uACB0\uC5D0\uC11C URL\uACFC \uD1A0\uD070\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694." }),
          go
        ])
      ]));
    }
    if (state.slotError) {
      pad.appendChild(el("div", { class: "notice" }, [
        el("div", { text: "\uCE90\uB9AD\uD130\uAC00 \uC120\uD0DD\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }),
        el("div", { class: "hint", text: state.slotError })
      ]));
      return;
    }
    const char = state.character;
    if (!char) {
      pad.appendChild(el("div", { class: "empty", text: "\uCE90\uB9AD\uD130\uB97C \uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      return;
    }
    const liveChats = Array.isArray(char.chats) ? char.chats : [];
    const folders = Array.isArray(char.chatFolders) ? char.chatFolders : [];
    const editBot = el("button", { class: "primary tiny", text: "\uBD07 \uD3B8\uC9D1" });
    editBot.addEventListener("click", () => {
      if (!state.activeCharKey) {
        flash(pad, "\uBC31\uC5D4\uB4DC\uC5D0 \uBD07\uC774 \uC544\uC9C1 \uC62C\uB77C\uAC00\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
        return;
      }
      setEditMode("bot", "meta");
    });
    const portrait = el("div", { class: "botinitials", text: initials(String(char.name || "?")) });
    pad.appendChild(el("div", { class: "botcard" }, [
      portrait,
      el("div", { class: "grow" }, [
        el("div", { class: "botname", text: String(char.name || "(\uC774\uB984 \uC5C6\uC74C)") }),
        el("div", { class: "hint", text: `\uCC57 ${liveChats.length}\uAC1C` + (folders.length ? ` \xB7 \uD3F4\uB354 ${folders.length}\uAC1C` : "") }),
        assetSyncLine(),
        el("div", { class: "row", style: { marginTop: "8px" } }, [editBot]),
        el("div", { class: "hint", style: { marginTop: "6px" } }, [
          "\uB2E4\uB978 \uBD07\uC744 \uD3B8\uC9D1\uD558\uC2DC\uB824\uBA74 RisuAI\uC5D0\uC11C \uADF8 \uBD07\uC744 \uC5F4\uACE0 \u{1F504} \uB97C \uB20C\uB7EC \uC8FC\uC138\uC694."
        ])
      ])
    ]));
    void loadPortrait(char.image, portrait);
    pad.appendChild(botSnapshots(editBot));
    pad.appendChild(el("div", { class: "sectionline" }));
    pad.appendChild(el("div", { class: "sectiontitle", text: "\uCC57 \uC120\uD0DD" }));
    const ws = state.workspace;
    const loadedFor = (c) => ws?.chats.find((w) => w.chatId === (c.id ?? ""));
    if (liveChats.length > 6) {
      setToolbarSearch(filterText, (v) => {
        filterText = v;
        renderChatsTab(mount);
        refocusSearch(null);
      }, "\uCC57 \uCC3E\uAE30");
    }
    const needle = filterText.trim().toLowerCase();
    const rows = liveChats.map((c, i) => ({ chat: c, index: i })).filter((r) => !needle || String(r.chat.name ?? "").toLowerCase().includes(needle));
    const grouped = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const key = String(r.chat.folderId ?? "");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    const makeItem = (r) => {
      const loaded = loadedFor(r.chat);
      const isCurrent = r.index === state.slot?.chatIndex;
      const edit = el("button", { class: "ghost tiny", text: "\uCC57 \uD3B8\uC9D1" });
      const item = el("div", {
        class: "chatitem" + (loaded && loaded.chatKey === state.activeChatKey ? " current" : "")
      }, [
        el("span", { class: "grow", text: String(r.chat.name || `(\uCC57 ${r.index})`) }),
        el("span", { class: "n", text: `${(r.chat.message ?? []).length}\uD134` }),
        edit
      ]);
      const enter = async () => {
        if (loaded) {
          await state.loadTurns(loaded.chatKey);
          setEditMode("chat", "editor");
          return;
        }
        if (!isCurrent) {
          flash(pad, "RisuAI\uC5D0\uC11C \uADF8 \uCC57\uC744 \uBA3C\uC800 \uC5F0 \uB2E4\uC74C \u{1F504} \uB97C \uB20C\uB7EC \uC8FC\uC138\uC694.");
          return;
        }
        await state.upload({});
        await state.loadTurns();
        setEditMode("chat", "editor");
      };
      item.addEventListener("click", () => void enter());
      edit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void enter();
      });
      return item;
    };
    const loose = grouped.get("") ?? [];
    if (loose.length) {
      const list2 = el("div", { class: "chatlist" });
      for (const r of loose) list2.appendChild(makeItem(r));
      pad.appendChild(list2);
    }
    for (const f of folders) {
      const items5 = grouped.get(String(f.id)) ?? [];
      if (!items5.length) continue;
      const body = el("div", { class: "folderbody" });
      for (const r of items5) body.appendChild(makeItem(r));
      const caret = el("span", { text: "\u25B8" });
      const head = el("button", { class: "folderhead" }, [
        caret,
        el("span", { class: "folderdot", style: f.color ? { background: String(f.color) } : {} }),
        el("span", { class: "grow", text: String(f.name || "\uD3F4\uB354") }),
        el("span", { text: `${items5.length}` })
      ]);
      head.addEventListener("click", () => {
        const open4 = body.classList.toggle("open");
        caret.textContent = open4 ? "\u25BE" : "\u25B8";
      });
      pad.appendChild(el("div", { class: "folder" }, [head, body]));
    }
    const known = new Set(folders.map((f) => String(f.id)));
    const orphans = [...grouped.entries()].filter(([k]) => k !== "" && !known.has(k)).flatMap(([, v]) => v);
    if (orphans.length) {
      const list2 = el("div", { class: "chatlist" });
      for (const r of orphans) list2.appendChild(makeItem(r));
      pad.appendChild(el("div", { class: "sectiontitle", style: { marginTop: "10px" }, text: "\uD3F4\uB354 \uC5C6\uC74C" }));
      pad.appendChild(list2);
    }
    pad.appendChild(el("div", { class: "row", style: { marginTop: "12px" } }, [
      buildUploadAll(),
      el("span", { class: "hint", text: "\uAE30\uBCF8\uC801\uC73C\uB85C \uD604\uC7AC \uC5F4\uB824 \uC788\uB294 \uCC57\uB9CC \uC62C\uB9BD\uB2C8\uB2E4." })
    ]));
  }
  function initials(name) {
    const t = name.trim();
    if (!t) return "?";
    return /[가-힣]/.test(t[0]) ? t.slice(0, 1) : t.slice(0, 2).toUpperCase();
  }
  async function loadPortrait(path, mount) {
    if (!path) return;
    try {
      const bytes = await Risuai.readImage(path);
      if (!bytes || !bytes.byteLength) return;
      if (portraitUrl) URL.revokeObjectURL(portraitUrl);
      const view2 = bytes;
      const buf = new Uint8Array(view2.byteLength);
      buf.set(view2);
      portraitUrl = URL.createObjectURL(new Blob([buf]));
      const img = el("img", { class: "botportrait", src: portraitUrl, alt: "" });
      img.addEventListener("error", () => img.replaceWith(mount));
      mount.replaceWith(img);
    } catch {
    }
  }
  function buildUploadAll() {
    const b = el("button", { text: "\uC774 \uBD07\uC758 \uBAA8\uB4E0 \uCC57 \uBD88\uB7EC\uC624\uAE30" });
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "\uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4\u2026";
      try {
        await state.upload({ allChats: true });
        if (state.activeChatKey) await state.loadTurns();
      } catch (e) {
        console.log("[risu-hina] upload all failed", e);
      } finally {
        b.disabled = false;
        b.textContent = "\uC774 \uBD07\uC758 \uBAA8\uB4E0 \uCC57 \uBD88\uB7EC\uC624\uAE30";
      }
    });
    return b;
  }
  function flash(pad, text2) {
    const n = el("div", { class: "notice", text: text2 });
    pad.insertBefore(n, pad.firstChild);
    setTimeout(() => n.remove(), 5e3);
  }

  // src/ui/explorer.ts
  var GROUP = 50;
  var Explorer = class {
    constructor(opts) {
      this.opts = opts;
      this.root = el("div", { class: "explorer" });
    }
    root;
    turns = [];
    activeStart = -1;
    setTurns(turns) {
      this.turns = turns;
      this.render();
    }
    /** Highlight the group containing the turn currently at the top of the view. */
    setVisible(seq) {
      const start = Math.floor(seq / GROUP) * GROUP;
      if (start === this.activeStart) return;
      this.activeStart = start;
      for (const b of Array.from(this.root.querySelectorAll(".expgroup"))) {
        b.classList.toggle("on", Number(b.dataset.start) === start);
      }
    }
    render() {
      clear(this.root);
      if (!this.turns.length) {
        this.root.appendChild(el("div", { class: "hint", style: { padding: "8px" }, text: "\uD134 \uC5C6\uC74C" }));
        return;
      }
      const preview2 = this.opts.preview();
      const deleting2 = this.opts.deleting();
      const last = this.turns[this.turns.length - 1].seq;
      for (let start = 0; start <= last; start += GROUP) {
        const end = start + GROUP - 1;
        const inGroup = this.turns.filter((t) => t.seq >= start && t.seq <= end);
        if (!inGroup.length) continue;
        const changed = inGroup.filter((t) => t.changed || t.isNew).length;
        const pending = preview2 ? inGroup.filter((t) => preview2.has(t.msgId)).length : 0;
        const doomed = deleting2 ? inGroup.filter((t) => deleting2.has(t.msgId)).length : 0;
        const marks = [];
        if (changed) marks.push(`\u270E${changed}`);
        if (pending) marks.push(`\u25C6${pending}`);
        if (doomed) marks.push(`\u2715${doomed}`);
        const b = el("button", {
          class: "expgroup" + (start === this.activeStart ? " on" : ""),
          dataset: { start: String(start) },
          title: `\uD134 ${start}\u2013${Math.min(end, last)} (${inGroup.length}\uAC1C)`
        }, [
          el("span", { text: `${start}\u2013${Math.min(end, last)}` }),
          marks.length ? el("span", { class: "expmark", text: marks.join(" ") }) : null
        ]);
        b.addEventListener("click", () => this.opts.onJump(start));
        this.root.appendChild(b);
      }
    }
  };

  // src/ui/splitter.ts
  function splitter(opts) {
    const gutter = el("div", { class: "gutter" + (opts.side === "left" ? " leftside" : ""), title: "\uB4DC\uB798\uADF8\uD574\uC11C \uD328\uB110 \uD06C\uAE30\uB97C \uC870\uC808\uD569\uB2C8\uB2E4" });
    const vertical = () => {
      const dir = getComputedStyle(opts.container).flexDirection;
      return dir === "column" || dir === "column-reverse";
    };
    const apply = (px) => {
      const down = vertical();
      const min = down ? 160 : opts.min ?? 250;
      const keep = down ? 140 : 320;
      const span = down ? opts.container.clientHeight : opts.container.clientWidth;
      const size = Math.round(Math.min(Math.max(min, span - keep), Math.max(min, px)));
      opts.target.style.flexBasis = size + "px";
      return size;
    };
    if (opts.storageKey) {
      void Risuai.pluginStorage.getItem(opts.storageKey).then((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) apply(n);
      }).catch(() => {
      });
    }
    let dragging = false;
    gutter.addEventListener("pointerdown", (e) => {
      const ev = e;
      dragging = true;
      gutter.classList.add("dragging");
      gutter.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    gutter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const ev = e;
      const rect = opts.container.getBoundingClientRect();
      const left = opts.side === "left";
      apply(vertical() ? left ? ev.clientY - rect.top : rect.bottom - ev.clientY : left ? ev.clientX - rect.left : rect.right - ev.clientX);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      gutter.classList.remove("dragging");
      try {
        gutter.releasePointerCapture(e.pointerId);
      } catch {
      }
      if (opts.storageKey) {
        const w = parseInt(opts.target.style.flexBasis || "0", 10);
        if (w > 0) void Risuai.pluginStorage.setItem(opts.storageKey, w).catch(() => void 0);
      }
    };
    gutter.addEventListener("pointerup", end);
    gutter.addEventListener("pointercancel", end);
    gutter.addEventListener("dblclick", () => {
      const back = apply(opts.side === "left" ? 210 : vertical() ? 360 : Math.round(opts.container.clientWidth / 2));
      if (opts.storageKey) void Risuai.pluginStorage.setItem(opts.storageKey, back).catch(() => void 0);
    });
    return gutter;
  }

  // src/ui/panes.ts
  function threePane(leftNode) {
    const left = leftNode ?? el("div", { class: "explorer" });
    const centre = el("div", { class: "left" });
    const right = el("div", { class: "right" }, [el("div", { class: "right-inner" })]);
    const root = el("div", { class: "split" }, [left]);
    root.appendChild(splitter({ target: left, container: root, storageKey: "treeWidth", side: "left", min: 120 }));
    root.appendChild(centre);
    root.appendChild(splitter({ target: right, container: root, storageKey: "panelWidth2" }));
    root.appendChild(right);
    root.insertBefore(mobileBar(root), root.firstChild);
    return { root, left, centre, right };
  }
  var VIEW_KEY = "hina.mobileView";
  var mobileView = "agent";
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "centre" || v === "agent") mobileView = v;
  } catch {
  }
  var toggles = /* @__PURE__ */ new Map();
  function syncAll() {
    for (const [root, t] of [...toggles]) {
      if (!root.isConnected && toggles.size > 1) {
        toggles.delete(root);
        continue;
      }
      t();
    }
  }
  var mobileList = false;
  function mobileBar(root) {
    const editBtn = el("button", { text: "\u{1F4C4} \uD3B8\uC9D1", title: "\uD3B8\uC9D1 \uD654\uBA74 (\uBAA8\uBC14\uC77C)" });
    const agentBtn = el("button", { text: "\u{1F4AC} AI \uCC57", title: "AI \uCC57 (\uBAA8\uBC14\uC77C)" });
    const listBtn = el("button", { class: "ghost tiny mlist", title: "\uC67C\uCABD \uBAA9\uB85D\uC744 \uD3BC\uCE58\uAC70\uB098 \uC811\uC2B5\uB2C8\uB2E4" });
    const bar3 = el("div", { class: "mbar" }, [el("div", { class: "mseg" }, [editBtn, agentBtn]), listBtn]);
    const sync = () => {
      root.classList.toggle("m-agent", mobileView === "agent");
      root.classList.toggle("m-centre", mobileView === "centre");
      root.classList.toggle("m-list", mobileList);
      editBtn.classList.toggle("on", mobileView === "centre");
      agentBtn.classList.toggle("on", mobileView === "agent");
      listBtn.textContent = mobileList ? "\u2630 \uBAA9\uB85D \uC811\uAE30" : "\u2630 \uBAA9\uB85D \uD3BC\uCE58\uAE30";
      listBtn.style.display = root.querySelector(".explorer .tree") ? "" : "none";
    };
    const pick2 = (v) => {
      if (mobileView === v) return;
      mobileView = v;
      try {
        localStorage.setItem(VIEW_KEY, mobileView);
      } catch {
      }
      syncAll();
    };
    editBtn.addEventListener("click", () => pick2("centre"));
    agentBtn.addEventListener("click", () => pick2("agent"));
    listBtn.addEventListener("click", () => {
      mobileList = !mobileList;
      syncAll();
    });
    toggles.set(root, sync);
    sync();
    setTimeout(sync, 0);
    return bar3;
  }

  // src/ui/markdown.ts
  function renderMarkdown(text2) {
    const frag = document.createDocumentFragment();
    const lines = text2.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        const pre = el("pre", { class: "md-code" }, [el("code", { text: body.join("\n") })]);
        if (lang) pre.dataset.lang = lang;
        frag.appendChild(pre);
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        frag.appendChild(el("hr", { class: "md-hr" }));
        i++;
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const level = Math.min(4, heading[1].length);
        const h = el("div", { class: "md-h md-h" + level });
        h.appendChild(inline(heading[2]));
        frag.appendChild(h);
        i++;
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          body.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        const q = el("div", { class: "md-quote" });
        q.appendChild(renderMarkdown(body.join("\n")));
        frag.appendChild(q);
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const t = c.trim();
          return t.startsWith(":") && t.endsWith(":") ? "mid" : t.endsWith(":") ? "num" : "";
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const cellClass = (j) => aligns[j] || "";
        const thead = el("thead", {}, [el("tr", {}, header.map((h, j) => {
          const th = el("th", { class: cellClass(j) });
          th.appendChild(inline(h.trim()));
          return th;
        }))]);
        const tbody = el("tbody", {}, rows.map((r) => el("tr", {}, header.map((_, j) => {
          const td = el("td", { class: cellClass(j) });
          td.appendChild(inline((r[j] ?? "").trim()));
          return td;
        }))));
        frag.appendChild(el("div", { class: "md-tablewrap" }, [el("table", { class: "md-table" }, [thead, tbody])]));
        continue;
      }
      const bullet = line.match(/^\s*([-*+]|\d+\.)\s+/);
      if (bullet) {
        const ordered = /\d/.test(bullet[1]);
        const list2 = el(ordered ? "ol" : "ul", { class: "md-list" });
        while (i < lines.length) {
          const m = lines[i].match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
          if (!m) break;
          const li = el("li");
          li.appendChild(inline(m[1]));
          list2.appendChild(li);
          i++;
        }
        frag.appendChild(list2);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes("|") && isTableSeparator(lines[i + 1] ?? ""))) {
        para.push(lines[i]);
        i++;
      }
      const p = el("div", { class: "md-p" });
      p.appendChild(inline(para.join("\n")));
      frag.appendChild(p);
    }
    return frag;
  }
  function isTableSeparator(line) {
    const cells2 = splitRow(line);
    return cells2.length > 0 && cells2.every((c) => /^\s*:?-{1,}:?\s*$/.test(c)) && /-{2,}/.test(line);
  }
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|"));
  }
  function isBlockStart(line) {
    return /^\s*```/.test(line) || /^#{1,4}\s/.test(line) || /^\s*>/.test(line) || /^\s*(?:[-*+]|\d+\.)\s/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line);
  }
  var INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;
  function inline(text2) {
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(text2)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text2.slice(last, m.index)));
      frag.appendChild(token(m[0]));
      last = INLINE_RE.lastIndex;
    }
    if (last < text2.length) frag.appendChild(document.createTextNode(text2.slice(last)));
    return frag;
  }
  function token(tok) {
    if (tok.startsWith("**") || tok.startsWith("__")) {
      return el("strong", { text: tok.slice(2, -2) });
    }
    if (tok.startsWith("`")) {
      return el("code", { class: "md-inline-code", text: tok.slice(1, -1) });
    }
    if (tok.startsWith("[")) {
      const m = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (m) {
        const href = /^https?:\/\//i.test(m[2]) ? m[2] : "";
        return href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", text: m[1] }) : document.createTextNode(m[1]);
      }
    }
    return el("em", { text: tok.slice(1, -1) });
  }

  // src/ui/agent.ts
  var AgentPanel = class {
    constructor(hooks2) {
      this.hooks = hooks2;
      this.log = el("div", { class: "agentlog" });
      this.stagedBox = el("div", { class: "stagedbox" });
      this.actionBox = el("div", { class: "stagedbox" });
      this.status = el("div", { class: "hint grow" });
      const fresh = el("button", {
        class: "ghost tiny",
        title: "\uC9C0\uAE08 \uB300\uD654\uB97C \uC811\uACE0 \uC0C8 \uB300\uD654\uB97C \uC2DC\uC791\uD569\uB2C8\uB2E4",
        text: "\uC0C8 \uB300\uD654"
      });
      fresh.addEventListener("click", () => void this.newConversation());
      this.historyBtn = el("button", {
        class: "ghost tiny",
        title: "\uC774\uC804 \uB300\uD654 \uBAA9\uB85D",
        text: "\uC774\uC804 \uB300\uD654"
      });
      this.historyBtn.addEventListener("click", () => void this.openHistory());
      this.input = el("textarea", {
        class: "agentinput",
        placeholder: "\uCC57\uC5D0\uC11C \uC218\uC815\uC774\uB098 \uC870\uC815\uC774 \uD544\uC694\uD55C \uBD80\uBD84\uC744 \uB9D0\uC500\uD558\uC138\uC694. \uAD81\uAE08\uD55C \uC810\uC774 \uC788\uB2E4\uBA74 \uBB34\uC5C7\uC774\uB4E0 \uBB3C\uC5B4\uBCF4\uC138\uC694."
      });
      this.input.addEventListener("keydown", (e) => {
        const ev = e;
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          void this.submit();
        }
      });
      this.send = el("button", { class: "primary sendbtn", title: "\uBCF4\uB0B4\uAE30 (Enter)", html: PAPER_PLANE });
      this.send.addEventListener("click", () => void this.submit());
      this.picker = el("input", { type: "file", multiple: true, style: { display: "none" } });
      this.picker.addEventListener("change", () => {
        void this.attachAll(Array.from(this.picker.files ?? []));
        this.picker.value = "";
      });
      const clip = el("button", {
        class: "ghost attachbtn",
        title: "\uD30C\uC77C \uCCA8\uBD80 \u2014 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC5D0 \uC62C\uB77C\uAC11\uB2C8\uB2E4",
        html: ICON.clip
      });
      clip.addEventListener("click", () => this.picker.click());
      this.input.addEventListener("paste", (e) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        void this.attachAll(files);
      });
      for (const kind of ["dragover", "dragenter"]) {
        this.input.addEventListener(kind, (e) => {
          e.preventDefault();
          this.input.classList.add("dropping");
        });
      }
      for (const kind of ["dragleave", "drop"]) {
        this.input.addEventListener(kind, () => this.input.classList.remove("dropping"));
      }
      this.input.addEventListener("drop", (e) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        void this.attachAll(files);
      });
      this.root = el("div", { class: "agentpanel" }, [
        el("div", { class: "agenthead" }, [this.status, fresh, this.historyBtn]),
        this.log,
        this.stagedBox,
        this.actionBox,
        this.attachBar,
        // The two buttons stack beside the box, attach above send: the box is
        // two lines tall anyway, and a clip on the far left read as a third
        // control competing with the text rather than an option on sending.
        el("div", { class: "agentcompose" }, [this.input, el("div", { class: "agentbtns" }, [clip, this.send]), this.picker])
      ]);
    }
    root;
    log;
    stagedBox;
    input;
    send;
    status;
    historyBtn;
    busy = false;
    loaded = false;
    picker;
    /** Workspace paths uploaded for the message being composed. */
    attached = [];
    attachBar = el("div", { class: "attachbar", style: { display: "none" } });
    actionBox;
    /** out/ paths already offered, so the card does not churn every refresh. */
    outSeen = "";
    outPrimed = false;
    /**
     * Upload files and remember them until the next message goes out.
     *
     * Uploaded immediately rather than on send: the user should be able to see
     * that it worked, and a failure should surface while they are still looking
     * at the file rather than after they have written a paragraph about it.
     */
    async attachAll(files) {
      for (const file of files) {
        const chip = el("span", { class: "attachchip" }, [
          el("span", { text: file.name }),
          el("span", { class: "hint", text: "\uC62C\uB9AC\uB294 \uC911\u2026" })
        ]);
        this.attachBar.appendChild(chip);
        this.attachBar.style.display = "flex";
        try {
          const isText = /[.](md|txt|json|jsonl|csv|py|html?|css|js|ya?ml|xml|log|sql)$/i.test(file.name);
          let saved;
          if (isText) {
            saved = await state.uploadFile(file.name, await file.text());
          } else {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
            saved = await state.uploadFile(file.name, btoa(bin), true);
          }
          this.attached.push(saved.path);
          clear(chip);
          const drop = el("button", { class: "ghost tiny", text: "\xD7", title: "\uC774 \uBA54\uC2DC\uC9C0\uC5D0\uC11C \uBE7C\uAE30" });
          drop.addEventListener("click", () => {
            this.attached = this.attached.filter((p) => p !== saved.path);
            chip.remove();
            if (!this.attachBar.children.length) this.attachBar.style.display = "none";
          });
          chip.appendChild(el("span", { text: saved.path }));
          chip.appendChild(drop);
        } catch (e) {
          clear(chip);
          chip.classList.add("bad");
          chip.appendChild(el("span", { text: `${file.name} \u2014 ${msg(e)}` }));
        }
      }
    }
    clearAttachments() {
      this.attached = [];
      clear(this.attachBar);
      this.attachBar.style.display = "none";
    }
    /** Load once per chat; re-entering the tab must not re-fetch the transcript. */
    async load(force = false) {
      if (this.loaded && !force) return;
      this.loaded = true;
      await this.render();
    }
    invalidate() {
      this.loaded = false;
    }
    async render(sessionId) {
      clear(this.log);
      try {
        const s = await state.agentSession(sessionId);
        if (!s.agentReady) {
          this.status.textContent = "";
          this.log.appendChild(el("div", { class: "notice" }, [
            el("div", { text: "\uC5D0\uC774\uC804\uD2B8 \uC790\uACA9\uC99D\uBA85\uC774 \uC544\uC9C1 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4." }),
            el("div", {
              class: "hint",
              text: "\uC624\uB978\uCABD \uC704 \u2699 \u2192 \uC5D0\uC774\uC804\uD2B8\uC5D0\uC11C Base URL \xB7 Model \xB7 API Key\uB97C \uB123\uACE0 \uC5F0\uACB0 \uD14C\uC2A4\uD2B8\uB97C \uD574 \uC8FC\uC138\uC694."
            })
          ]));
          this.send.disabled = true;
          return;
        }
        this.send.disabled = false;
        this.status.textContent = s.session ? "" : "\uC0C8 \uB300\uD654";
        for (const m of s.messages) {
          if (m.role === "user") this.addBubble("user", String(m.content ?? ""));
          else if (m.role === "assistant") {
            this.addBubble("assistant", String(m.content ?? ""), m.usage ?? void 0, m.cost);
          }
        }
        if (!s.messages.length) this.log.appendChild(this.welcome());
        this.setStaged(s.staged ?? []);
        void this.refreshActions();
        void this.refreshOutputs();
        this.scroll();
      } catch (e) {
        this.status.textContent = e instanceof Error ? e.message : String(e);
      }
    }
    /**
     * What an empty conversation says.
     *
     * A blank panel with a cursor asks "what can this do?" and answers nothing.
     * The three examples are the three sizes of job this tool was built for -
     * one turn, many turns, and restructuring the whole chat - so they double as
     * a description of the tool. Clicking one fills the box rather than sending
     * it: they are starting points to edit, not commands.
     */
    welcome() {
      const bot = currentMode() === "bot";
      const examples = bot ? [
        "\uBD07 \uB85C\uC5B4\uBD81\uC744 \uD6D1\uC5B4\uC11C \uACB9\uCE58\uAC70\uB098 \uBE48 \uD56D\uBAA9\uC744 \uC815\uB9AC\uD558\uACE0 \uD3F4\uB354\uB85C \uBB36\uC5B4\uC918",
        "\uD37C\uC2A4\uD2B8 \uBA54\uC2DC\uC9C0\uC640 \uB300\uCCB4 \uC778\uC0AC\uB9D0\uC758 \uB9D0\uD22C\uB97C \uC124\uBA85(desc)\uACFC \uB9DE\uCDB0\uC918",
        "\uC5D0\uC14B \uC774\uB984 \uB05D\uC758 \uD655\uC7A5\uC790\uB97C \uB5BC\uACE0, \uAC10\uC815 \uC774\uBBF8\uC9C0 \uC774\uB984\uC744 \uAC10\uC815 \uB2E8\uC5B4\uB85C \uD1B5\uC77C\uD574\uC918"
      ] : [
        "\uB300\uD654\uC5D0\uC11C \uD398\uB974\uC18C\uB098\uB97C \uC870\uAE08 \uB354 \uCC29\uD55C \uC0AC\uB78C\uC73C\uB85C \uC870\uC815\uD574\uC918",
        "{{char}}\uC5D0\uAC8C \uACE0\uBC31\uD55C \uC77C\uC744 \uC5C6\uB358 \uAC78\uB85C \uD574\uC918",
        "\uCC57 \uC774\uC0AC\uAC00\uACE0 \uC2F6\uC5B4. \uC804\uCCB4 \uD56D\uBAA9\uC744 \uCCB4\uACC4\uC801\uC73C\uB85C \uC694\uC57D\uD574\uC11C \uCC57 \uB85C\uC5B4\uBD81\uC5D0 \uB123\uACE0, 10\uD134\uB9CC \uB0A8\uACA8\uC918"
      ];
      const box = el("div", { class: "welcome" }, [
        el("div", { class: "welcome-title", text: bot ? "\uBD07(\uCE74\uB4DC)\uC5D0\uC11C \uC870\uC815\uD560 \uD56D\uBAA9\uC744 \uC0C1\uB2F4\uD558\uC138\uC694" : "\uC870\uC815\uD574\uC57C \uD560 \uD56D\uBAA9\uC744 \uC0C1\uB2F4\uD558\uC138\uC694" }),
        el("div", {
          class: "hint",
          text: "\uACE0\uCE60 \uACF3\uC744 \uB9D0\uC500\uD558\uC2DC\uBA74 \uD6D1\uC5B4\uBCF4\uACE0 \uC81C\uC548\uC744 \uB9CC\uB4E4\uC5B4 \uC635\uB2C8\uB2E4. \uBC18\uC601\uC740 \uC2B9\uC778\uD558\uC2E0 \uB4A4\uC5D0 \uC774\uB8E8\uC5B4\uC9D1\uB2C8\uB2E4."
        }),
        el("div", {
          class: "hint",
          text: "AI \uC5D0\uC774\uC804\uD2B8\uB294 \uD604\uC7AC \uD0ED\uBFD0\uB9CC \uC544\uB2C8\uB77C \uC120\uD0DD\uB41C \uBD07 \uBC0F \uCC57\uC758 \uC804\uBC18\uC801\uC778 \uC815\uBCF4\uB97C \uBAA8\uB450 \uC54C\uACE0 \uC788\uC2B5\uB2C8\uB2E4."
        })
      ]);
      for (const text2 of examples) {
        const b = el("button", { class: "exbtn" }, [
          el("span", { class: "exmark", text: "\u2192" }),
          el("span", { text: text2 })
        ]);
        b.addEventListener("click", () => {
          this.input.value = text2;
          this.input.focus();
        });
        box.appendChild(b);
      }
      box.appendChild(el("div", {
        class: "hint welcome-foot",
        text: "\uD30C\uC77C\uC740 \uC544\uB798 \uD074\uB9BD \uBC84\uD2BC\uC774\uB098 \uBD99\uC5EC\uB123\uAE30\xB7\uB04C\uC5B4\uB193\uAE30\uB85C \uC62C\uB9AC\uC2E4 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
      }));
      return box;
    }
    /**
     * Files the agent left in out/ since the last look.
     *
     * Each new file gets one line in the log, where the conversation is, and
     * that line opens the file in the files tab. There used to be a pinned card
     * listing every output with a download button; it sat between the log and
     * the input and grew with every file, so after a long session it took more
     * of the panel than the conversation did. The files tab is the place that
     * lists files; the log only has to say that one appeared.
     */
    async refreshOutputs() {
      try {
        const listing = await state.files();
        const out = listing.areas.find((a) => a.area === "out");
        const files = out?.files ?? [];
        const stamp = files.map((f) => `${f.path}:${f.size}:${f.modified}`).join("|");
        if (!this.outPrimed) {
          this.outPrimed = true;
          this.outSeen = stamp;
          return;
        }
        if (stamp === this.outSeen) return;
        const before = new Set(this.outSeen.split("|").map((s) => s.split(":")[0]));
        this.outSeen = stamp;
        const fresh = files.filter((f) => !before.has(f.path));
        if (!fresh.length) return;
        state.touchFiles(fresh.map((f) => f.path));
        for (const f of fresh) {
          const line = el("button", { class: "outline", title: "\uD30C\uC77C \uD0ED\uC5D0\uC11C \uC5FD\uB2C8\uB2E4" }, [
            el("span", { class: "glyph", text: "\u{1F4C4}" }),
            el("span", { class: "grow", text: `${f.name} \xB7 ${fmtSize(f.size)} \u2014 out/ \uC5D0 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uD30C\uC77C \uD0ED\uC5D0\uC11C \uC5F4\uAE30 \u2192` })
          ]);
          line.addEventListener("click", () => state.requestOpenFile(f.path));
          this.log.appendChild(line);
        }
        this.scroll();
      } catch {
      }
    }
    /** Proposals that are not transcript edits - lorebook, memory, snapshots. */
    async refreshActions() {
      try {
        this.setActions(await state.actions());
      } catch {
      }
    }
    setActions(items5) {
      clear(this.actionBox);
      if (!items5.length) return;
      const decideOne = async (a, approve, quiet = false) => {
        try {
          const said = await state.decideAction(a.id, approve);
          if (!quiet) this.hooks.notice(said, approve ? "ok" : "");
          this.note(
            (approve ? "\u2714 \uC2B9\uC778\xB7\uC2E4\uD589: " : "\u2716 \uAC70\uC808: ") + a.summary + (said ? " \u2014 " + said : ""),
            approve ? "ok" : ""
          );
          return true;
        } catch (e) {
          if (!quiet) this.hooks.notice("\uC2E4\uD589\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg(e), "err");
          this.note("\u2716 \uC2E4\uD589 \uC2E4\uD328: " + a.summary + " \u2014 " + msg(e), "err");
          return false;
        }
      };
      const rows = items5.map((a) => {
        const yes = el("button", { class: "primary tiny", text: a.byHost ? "\uC2B9\uC778\xB7\uC2E4\uD589" : "\uC2B9\uC778" });
        const no = el("button", { class: "ghost tiny", text: "\uAC70\uC808" });
        const busy = el("span", { class: "hint", text: "" });
        const decide = async (approve) => {
          yes.disabled = true;
          no.disabled = true;
          busy.textContent = approve ? "\uC2E4\uD589 \uC911\u2026" : "\uAC70\uC808 \uC911\u2026";
          const ok = await decideOne(a, approve);
          if (ok) {
            await this.refreshActions();
            if (approve) await this.hooks.onApplied();
          } else {
            busy.textContent = "";
            yes.disabled = false;
            no.disabled = false;
          }
        };
        yes.addEventListener("click", () => void decide(true));
        no.addEventListener("click", () => void decide(false));
        return el("div", { class: "stagedrow" }, [
          // Host actions touch the live RisuAI chat rather than our working copy,
          // which is a different kind of consequence and says so.
          a.byHost ? el("span", { class: "badge err", text: "RisuAI" }) : null,
          el("span", { class: "grow", text: a.summary }),
          busy,
          yes,
          no
        ]);
      });
      const progress = el("span", { class: "hint", text: "" });
      const allYes = el("button", { class: "primary tiny", text: `\uC804\uCCB4 \uC2B9\uC778\xB7\uC2E4\uD589 (${items5.length})` });
      const allNo = el("button", { class: "ghost tiny", text: "\uC804\uCCB4 \uAC70\uC808" });
      const decideAll = async (approve) => {
        allYes.disabled = allNo.disabled = true;
        for (const b of Array.from(this.actionBox.querySelectorAll(".stagedrow button"))) b.disabled = true;
        let done = 0;
        let failed = false;
        for (const a of items5) {
          progress.textContent = `${approve ? "\uC2E4\uD589" : "\uAC70\uC808"} \uC911 ${done + 1}/${items5.length}\u2026`;
          const ok = await decideOne(a, approve, true);
          if (!ok) {
            failed = true;
            break;
          }
          done += 1;
        }
        const said = approve ? `\uC2B9\uC778 \uC694\uCCAD ${done}\uAC74\uC744 \uC2E4\uD589\uD588\uC2B5\uB2C8\uB2E4.` + (failed ? " \uC2E4\uD328\uD55C \uD56D\uBAA9\uC5D0\uC11C \uBA48\uCDC4\uC2B5\uB2C8\uB2E4." : "") : `\uC2B9\uC778 \uC694\uCCAD ${done}\uAC74\uC744 \uAC70\uC808\uD588\uC2B5\uB2C8\uB2E4.`;
        this.hooks.notice(said, failed ? "err" : "ok");
        await this.refreshActions();
        if (approve && done) await this.hooks.onApplied();
      };
      allYes.addEventListener("click", () => void decideAll(true));
      allNo.addEventListener("click", () => void decideAll(false));
      const FOLD = 6;
      const shown = rows.slice(0, FOLD);
      const rest = rows.slice(FOLD);
      const restBox = el("div", { style: { display: "none" } }, rest);
      const unfold = rest.length ? el("button", { class: "ghost tiny", text: `\uADF8 \uC678 ${rest.length}\uAC74 \uBCF4\uAE30` }) : null;
      unfold?.addEventListener("click", () => {
        const open4 = restBox.style.display === "none";
        restBox.style.display = open4 ? "" : "none";
        unfold.textContent = open4 ? "\uC811\uAE30" : `\uADF8 \uC678 ${rest.length}\uAC74 \uBCF4\uAE30`;
      });
      this.actionBox.appendChild(el("div", { class: "card staged" }, [
        el("h2", { text: `\uC2B9\uC778 \uC694\uCCAD ${items5.length}\uAC74` }),
        el("div", { class: "hint", text: "\uC2B9\uC778\uD574\uC57C \uC2E4\uD589\uB429\uB2C8\uB2E4. \uC804\uC0AC \uC218\uC815\uC774 \uC544\uB2CC \uBCC0\uACBD\uC785\uB2C8\uB2E4." }),
        items5.length > 1 ? el("div", { class: "row", style: { margin: "6px 0" } }, [allYes, allNo, progress]) : null,
        ...shown,
        restBox,
        unfold
      ]));
    }
    async newConversation() {
      if (this.busy) return;
      try {
        await state.newAgentSession();
        await this.render();
        this.hooks.notice("\uC0C8 \uB300\uD654\uB97C \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.", "ok");
      } catch (e) {
        this.hooks.notice("\uC0C8 \uB300\uD654\uB97C \uC2DC\uC791\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg(e), "err");
      }
    }
    async openHistory() {
      const body = el("div", {}, [el("div", { class: "hint", text: "\uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" })]);
      const close = popover(this.historyBtn, body);
      try {
        const sessions = await state.agentSessions();
        clear(body);
        if (!sessions.length) {
          body.appendChild(el("div", { class: "hint", text: "\uC774\uC804 \uB300\uD654\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." }));
          return;
        }
        for (const s of sessions) {
          const row = el("div", { class: "sessrow" }, [
            el("div", { class: "grow" }, [
              el("div", { text: s.title }),
              el("div", {
                class: "hint",
                text: `${s.turns}\uD134` + (s.cost != null ? ` \xB7 $${Number(s.cost).toFixed(4)}` : "")
              })
            ])
          ]);
          row.addEventListener("click", async () => {
            close();
            await this.render(s.sessionId);
          });
          body.appendChild(row);
        }
      } catch (e) {
        clear(body);
        body.appendChild(el("div", { class: "hint", text: msg(e) }));
      }
    }
    /** Interval id for the elapsed clock, so a teardown can stop it. */
    timer = null;
    clearTimer() {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
    addBubble(role, text2, usage, cost) {
      const body = el("div", { class: "bubble-body" });
      if (role === "assistant") setMarkdown(body, text2);
      else body.textContent = text2;
      const node = el("div", { class: `bubble ${role}` }, [body]);
      if (role === "assistant") node.appendChild(this.costLine(usage, cost));
      this.log.appendChild(node);
      return body;
    }
    /** A one-line event in the conversation (an approval ran, a run was stopped). */
    note(text2, kind = "") {
      this.log.appendChild(el("div", { class: "bubble note" + (kind ? " " + kind : ""), text: text2 }));
      this.scroll();
    }
    costLine(usage, cost) {
      const bits = [];
      if (cost !== null && cost !== void 0) {
        bits.push("$" + Number(cost).toFixed(4));
      } else if (usage) {
        bits.push("\uAC00\uACA9 \uBBF8\uC124\uC815");
      }
      if (usage) {
        const i = usage.input, o = usage.output, t = usage.toolCalls;
        if (i != null || o != null) bits.push(`${fmtTok(i)}\u2191 / ${fmtTok(o)}\u2193`);
        if (t) bits.push(`\uD234 ${t}\uD68C`);
      }
      return el("div", { class: "costline", text: bits.join(" \xB7 ") });
    }
    async submit() {
      const typed = this.input.value.trim();
      if (!typed && !this.attached.length || this.busy) return;
      const files = this.attached.slice();
      const prompt = files.length ? (typed ? typed + "\n\n" : "") + "\uCCA8\uBD80\uD55C \uD30C\uC77C: " + files.join(", ") + "\n(\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC5D0 \uC62C\uB824 \uB480\uC2B5\uB2C8\uB2E4. read_file \uB85C \uC77D\uC5B4 \uC8FC\uC138\uC694.)" : typed;
      this.busy = true;
      this.input.value = "";
      this.clearAttachments();
      this.send.disabled = true;
      const empty = this.log.querySelector(".empty");
      if (empty) empty.remove();
      this.addBubble("user", prompt);
      const bubble = el("div", { class: "bubble assistant" });
      this.log.appendChild(bubble);
      const elapsed = el("span", { class: "elapsed", text: "0m 0s" });
      const thinkingText = el("span", { class: "thinkingtext", text: "\uC0DD\uAC01\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" });
      const abort = new AbortController();
      const stopBtn = el("button", { class: "ghost tiny stopbtn", text: "\uC911\uB2E8", title: "\uC774 \uD134\uC744 \uC911\uB2E8\uD569\uB2C8\uB2E4" });
      stopBtn.addEventListener("click", () => {
        abort.abort();
        stopBtn.disabled = true;
      });
      const thinking = el("div", { class: "thinking" }, [
        el("span", { class: "dots" }, [el("i"), el("i"), el("i")]),
        thinkingText,
        elapsed,
        stopBtn
      ]);
      bubble.appendChild(thinking);
      const startedAt = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - startedAt) / 1e3);
        elapsed.textContent = `${Math.floor(s / 60)}m ${s % 60}s`;
      };
      this.clearTimer();
      this.timer = setInterval(tick, 1e3);
      const setThinking = (on, label) => {
        thinking.style.display = on ? "flex" : "none";
        if (label) thinkingText.textContent = label;
      };
      const finish = (label) => {
        stopBtn.style.display = "none";
        this.clearTimer();
        tick();
        elapsed.classList.add("done");
        thinking.style.display = "flex";
        thinkingText.textContent = label;
        thinking.querySelector(".dots")?.classList.add("stopped");
      };
      let textNode = null;
      let textAcc = "";
      let tracker = null;
      const proseSegment = () => {
        if (!textNode) {
          textNode = el("div", { class: "bubble-body" });
          bubble.insertBefore(textNode, thinking);
          textAcc = "";
          tracker = null;
        }
        return textNode;
      };
      const traceSegment = () => {
        if (!tracker) {
          const strip2 = el("div", { class: "trace" });
          bubble.insertBefore(strip2, thinking);
          tracker = new TraceTracker(strip2);
          textNode = null;
        }
        return tracker;
      };
      this.scroll();
      const shown = /* @__PURE__ */ new Set();
      const askPermit = (p) => {
        const card = el("div", { class: "permit" });
        const decide = async (allow2, always2) => {
          for (const b of Array.from(card.querySelectorAll("button"))) b.disabled = true;
          try {
            await state.decidePermit(p.id, allow2, always2);
            card.classList.add(allow2 ? "allowed" : "denied");
            card.appendChild(el("div", { class: "hint", text: allow2 ? always2 ? "\uD5C8\uC6A9 (\uC774\uBC88 \uD134 \uB3D9\uC548 \uACC4\uC18D \uD5C8\uC6A9)" : "\uD5C8\uC6A9" : "\uAC70\uBD80" }));
          } catch (e) {
            card.appendChild(el("div", { class: "notice err", text: msg(e) }));
          }
        };
        const allow = el("button", { class: "primary tiny", text: "\uD5C8\uC6A9" });
        const deny = el("button", { class: "ghost tiny", text: "\uAC70\uBD80" });
        const always = el("button", { class: "ghost tiny", text: "\uC774\uBC88 \uD134 \uD56D\uC0C1 \uD5C8\uC6A9", title: "\uC774 \uD134\uC774 \uB05D\uB0A0 \uB54C\uAE4C\uC9C0 \uAC19\uC740 \uC885\uB958\uC758 \uC694\uCCAD\uC744 \uBB3B\uC9C0 \uC54A\uACE0 \uD5C8\uC6A9\uD569\uB2C8\uB2E4" });
        allow.addEventListener("click", () => void decide(true, false));
        deny.addEventListener("click", () => void decide(false, false));
        always.addEventListener("click", () => void decide(true, true));
        card.appendChild(el("div", { class: "permit-title", text: (p.kind === "pip" ? "\uD328\uD0A4\uC9C0 \uC124\uCE58 \uD5C8\uC6A9?" : "\uC178 \uBA85\uB839 \uC2E4\uD589 \uD5C8\uC6A9?") + " " + p.summary }));
        card.appendChild(el("pre", { class: "mono", text: p.detail }));
        card.appendChild(el("div", { class: "row" }, [allow, deny, always]));
        bubble.insertBefore(card, thinking);
        textNode = null;
        tracker = null;
        this.scroll();
      };
      const permitPoll = setInterval(async () => {
        try {
          for (const p of await state.permits()) {
            if (shown.has(p.id)) continue;
            shown.add(p.id);
            askPermit(p);
          }
        } catch {
        }
      }, 1500);
      try {
        for await (const ev of state.agentChat(prompt, abort.signal)) {
          const e = ev;
          switch (e.type) {
            case "text": {
              const node = proseSegment();
              textAcc += String(e.text ?? "");
              setThinking(false);
              setMarkdown(node, textAcc);
              this.scroll();
              break;
            }
            case "tool": {
              const name = String(e.name ?? "?");
              const detail = name === "load_skill" ? skillArg(e.args) : "";
              traceSegment().push(name, detail);
              setThinking(true, (TOOL_GLYPH[name]?.[1] ?? name) + (detail ? `: ${detail}` : "") + " \uC911\uC785\uB2C8\uB2E4\u2026");
              this.scroll();
              break;
            }
            case "done": {
              setThinking(true, "\uC81C\uC548\xB7\uBCC0\uACBD \uCE74\uB4DC\uB97C \uC815\uB9AC\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026");
              await this.refreshStaged();
              finish("\uC644\uB8CC");
              bubble.appendChild(this.costLine(
                e.usage,
                e.cost ?? null
              ));
              const more = el("button", { class: "ghost tiny continuebtn", text: "\uACC4\uC18D \uC774\uC5B4\uC11C", title: "\uBC29\uAE08 \uD134\uC5D0\uC11C \uB05D\uB0B4\uC9C0 \uBABB\uD55C \uC791\uC5C5\uC744 \uC774\uC5B4\uAC11\uB2C8\uB2E4" });
              more.addEventListener("click", () => {
                more.remove();
                this.input.value = "\uC774\uC5B4\uC11C \uC9C4\uD589\uD574 \uC8FC\uC138\uC694. \uBC29\uAE08 \uD134\uC5D0\uC11C \uB05D\uB0B4\uC9C0 \uBABB\uD55C \uC791\uC5C5\uC774 \uC788\uC73C\uBA74 \uB9C8\uC800 \uD574 \uC8FC\uC138\uC694.";
                void this.submit();
              });
              bubble.appendChild(el("div", { class: "row", style: { marginTop: "4px" } }, [more]));
              if (typeof e.total === "number") {
                this.status.textContent = `\uC774 \uB300\uD654 \uB204\uC801 $${e.total.toFixed(4)}`;
              }
              break;
            }
            case "error":
              finish("\uC911\uB2E8\uB428");
              bubble.appendChild(
                el("div", { class: "notice err", text: String(e.error ?? "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4") })
              );
              void clientLog("error", "agent stream error", { error: e.error });
              break;
          }
        }
      } catch (e) {
        finish("\uC911\uB2E8\uB428");
        bubble.appendChild(el("div", { class: "notice err", text: msg(e) }));
        void clientLog("error", "agent chat failed", { error: String(e) });
      } finally {
        clearInterval(permitPoll);
        if (this.timer !== null) finish("\uC885\uB8CC");
        this.busy = false;
        this.send.disabled = false;
        this.scroll();
      }
    }
    async refreshStaged() {
      try {
        this.setStaged(await state.stagedEdits());
        await this.refreshActions();
        await this.refreshOutputs();
      } catch {
      }
    }
    setStaged(items5) {
      clear(this.stagedBox);
      this.hooks.onStagedChanged(items5);
      if (!items5.length) return;
      const label = (op) => op === "edit" ? "\uC218\uC815" : op === "delete" ? "\uC0AD\uC81C" : "\uC0BD\uC785";
      const byOp = items5.reduce((a, i) => {
        a[i.op] = (a[i.op] ?? 0) + 1;
        return a;
      }, {});
      const summary = Object.entries(byOp).map(([op, n]) => `${label(op)} ${n}`).join(" \xB7 ");
      const approve = el("button", { class: "primary", text: "\uC804\uCCB4 \uC2B9\uC778\uD558\uACE0 \uC801\uC6A9" });
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        const was = approve.textContent;
        approve.textContent = "\uC801\uC6A9 \uC911\u2026";
        try {
          const r = await state.approveStaged(true);
          const said = `\uC81C\uC548 ${r.decided}\uAC74\uC744 \uC2B9\uC778\uD574 ${r.applied}\uAC74\uC744 \uC801\uC6A9\uD588\uC2B5\uB2C8\uB2E4.`;
          this.hooks.notice(said, "ok");
          this.note("\u2714 " + said, "ok");
          await this.refreshStaged();
          await this.hooks.onApplied();
        } catch (e) {
          this.hooks.notice("\uC801\uC6A9\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg(e), "err");
          this.note("\u2716 \uC801\uC6A9 \uC2E4\uD328: " + msg(e), "err");
        } finally {
          approve.disabled = false;
          approve.textContent = was;
        }
      });
      const reject = el("button", { class: "ghost", text: "\uC804\uCCB4 \uAC70\uBD80" });
      reject.addEventListener("click", async () => {
        reject.disabled = true;
        try {
          await state.approveStaged(false);
          this.hooks.notice("\uC81C\uC548\uC744 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4.", "ok");
          await this.refreshStaged();
        } catch (e) {
          this.hooks.notice("\uAC70\uBD80\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg(e), "err");
        } finally {
          reject.disabled = false;
        }
      });
      this.stagedBox.appendChild(el("div", { class: "card staged" }, [
        el("h2", { text: `\uC2B9\uC778 \uB300\uAE30 ${items5.length}\uAC74` }),
        el("div", { class: "hint", text: summary + " \u2014 \uC67C\uCABD \uD328\uB110\uC5D0 \uBBF8\uB9AC\uBCF4\uAE30\uB85C \uD45C\uC2DC\uD588\uC2B5\uB2C8\uB2E4." }),
        ...items5.slice(0, 8).map((i) => el("div", { class: "stagedrow" }, [
          el("span", { class: "badge warn", text: label(i.op) }),
          el("span", { class: "grow hint", text: `#${i.seq ?? "?"} ${i.reason || ""}` })
        ])),
        items5.length > 8 ? el("div", { class: "hint", text: `\uADF8 \uC678 ${items5.length - 8}\uAC74` }) : null,
        el("div", { class: "row", style: { marginTop: "8px" } }, [approve, reject])
      ]));
    }
    scroll() {
      this.log.scrollTop = this.log.scrollHeight;
    }
  };
  var TraceTracker = class {
    constructor(mount) {
      this.mount = mount;
    }
    lastName = "";
    count = 0;
    chip = null;
    push(name, detail = "") {
      if (name === this.lastName && this.chip && !detail) {
        this.count += 1;
        const x = this.chip.querySelector(".tx");
        if (x) x.textContent = `\xD7${this.count}`;
        else this.chip.appendChild(el("span", { class: "tx", text: `\xD7${this.count}` }));
        return;
      }
      const [glyph, label] = TOOL_GLYPH[name] ?? ["\u{1F527}", name];
      this.chip = el("span", { class: "tchip" + (detail ? " skill" : ""), title: name + (detail ? ` ${detail}` : "") }, [
        el("span", { text: glyph }),
        el("span", { text: detail ? `${label}: ${detail}` : label })
      ]);
      this.mount.appendChild(this.chip);
      this.lastName = name;
      this.count = 1;
    }
  };
  function skillArg(args) {
    if (!args) return "";
    try {
      const v = typeof args === "string" ? JSON.parse(args) : args;
      const name = v?.name;
      return typeof name === "string" ? name.slice(0, 40) : "";
    } catch {
      const m = /"name"\s*:\s*"([^"]{1,40})/.exec(String(args));
      return m ? m[1] : "";
    }
  }
  function setMarkdown(node, text2) {
    clear(node);
    node.appendChild(renderMarkdown(text2));
  }
  function fmtSize(n) {
    if (!n) return "0B";
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }
  function msg(e) {
    return e instanceof Error ? e.message : String(e);
  }
  function fmtTok(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "?";
    return n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  }

  // src/ui/agentpane.ts
  var panel = null;
  var hooks = {
    onStagedChanged: () => {
    },
    onApplied: () => {
    },
    notice: () => {
    }
  };
  function agentPanel() {
    if (!panel) {
      panel = new AgentPanel({
        onStagedChanged: (s) => hooks.onStagedChanged(s),
        onApplied: () => hooks.onApplied(),
        notice: (t, k) => hooks.notice(t, k)
      });
    }
    return panel;
  }
  function bindAgent(next) {
    hooks = { ...hooks, ...next };
  }
  function mountAgent(into) {
    const p = agentPanel();
    if (p.root.parentElement !== into) {
      const log = p.root.querySelector(".agentlog");
      const top = log?.scrollTop ?? 0;
      const atBottom = !!log && log.scrollHeight - log.scrollTop - log.clientHeight < 4;
      into.appendChild(p.root);
      if (log) {
        const restore = () => {
          log.scrollTop = atBottom ? log.scrollHeight : top;
        };
        restore();
        requestAnimationFrame(restore);
      }
    }
    void p.load();
  }

  // src/ui/render.ts
  var THINK_TAGS = ["thoughts", "think", "thinking", "reasoning", "scratchpad", "plan"];
  var THINK_RE = new RegExp(
    `<(${THINK_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`,
    "gi"
  );
  var TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  var PANEL_RE = /```[\s\S]*?```/g;
  var DEFAULT_RENDER = {
    stripThinking: true,
    stripTags: true,
    stripPanels: false,
    markdown: true,
    quotes: true
  };
  var SPEECH_RE = /[\u201C"][^\u201D"\n]*[\u201D"]/;
  var THOUGHT_RE = /[\u2018'][^\u2019'\n]*[\u2019']/;
  function toDisplayText(raw, opts) {
    let out = raw;
    if (opts.stripThinking) out = out.replace(THINK_RE, "");
    if (opts.stripPanels) out = out.replace(PANEL_RE, "");
    if (opts.stripTags) {
      out = out.replace(TAG_RE, (m, name) => String(name).toLowerCase() === "img" ? m : "");
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }
  function renderBody(raw, mode2, opts) {
    if (mode2 !== "clean") {
      return el("div", { class: "turn-body raw", text: raw });
    }
    const text2 = toDisplayText(raw, opts);
    const box = el("div", { class: "turn-body" });
    if (!text2) {
      box.appendChild(el("span", { class: "hint", text: "(\uC815\uB9AC\uD558\uACE0 \uB098\uB2C8 \uB0B4\uC6A9\uC774 \uBE44\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uC6D0\uBB38 \uBCF4\uAE30\uB85C \uD655\uC778\uD574 \uC8FC\uC138\uC694)" }));
      return box;
    }
    for (const piece of splitImages(text2)) {
      if (piece.kind === "img") {
        const img = el("img", { class: "turn-img", src: piece.src, alt: piece.alt || "image" });
        img.addEventListener("error", () => {
          img.replaceWith(el("span", { class: "hint", text: `[\uC774\uBBF8\uC9C0: ${piece.alt || piece.src}]` }));
        });
        box.appendChild(img);
      } else {
        appendMarkdown(box, piece.text, opts);
      }
    }
    return box;
  }
  function splitImages(text2) {
    const out = [];
    const re = /<img\b([^>]*)>/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text2)) !== null) {
      if (m.index > last) out.push({ kind: "text", text: text2.slice(last, m.index) });
      const attrs = m[1] || "";
      out.push({
        kind: "img",
        src: (attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim(),
        alt: (attrs.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim()
      });
      last = re.lastIndex;
    }
    if (last < text2.length) out.push({ kind: "text", text: text2.slice(last) });
    return out;
  }
  function appendMarkdown(box, text2, opts) {
    const parts = [];
    if (opts.markdown) parts.push("\\*\\*[^*\n]+\\*\\*", "\\*[^*\n]+\\*", "`[^`\n]+`");
    if (opts.quotes) parts.push(SPEECH_RE.source, THOUGHT_RE.source);
    if (!parts.length) {
      box.appendChild(document.createTextNode(text2));
      return;
    }
    const re = new RegExp("(" + parts.join("|") + ")", "g");
    let last = 0;
    let m;
    while ((m = re.exec(text2)) !== null) {
      if (m.index > last) box.appendChild(document.createTextNode(text2.slice(last, m.index)));
      box.appendChild(inlineToken(m[0], opts));
      last = re.lastIndex;
    }
    if (last < text2.length) box.appendChild(document.createTextNode(text2.slice(last)));
  }
  function inlineToken(tok, opts) {
    if (opts.markdown) {
      if (tok.startsWith("**")) return el("strong", { text: tok.slice(2, -2) });
      if (tok.startsWith("`")) return el("code", { text: tok.slice(1, -1) });
      if (tok.startsWith("*")) return el("em", { text: tok.slice(1, -1) });
    }
    if (opts.quotes) {
      const head = tok[0];
      if (head === '"' || head === "\u201C") return el("span", { class: "speech", text: tok });
      if (head === "'" || head === "\u2018") return el("span", { class: "thought", text: tok });
    }
    return document.createTextNode(tok);
  }

  // src/ui/conflicts.ts
  var REASON = {
    "both-moved": "\uC591\uCABD\uC5D0\uC11C \uC218\uC815\uB428",
    "deleted-upstream": "RisuAI\uC5D0\uC11C \uC0AD\uC81C\uB428",
    "weak-match": "\uC9DD\uC744 \uD655\uC2E0\uD560 \uC218 \uC5C6\uC74C"
  };
  var KIND = {
    turn: "\uD134",
    lore: "\uB85C\uC5B4\uBD81",
    card_field: "\uCE74\uB4DC",
    card_script: "\uC2A4\uD06C\uB9BD\uD2B8",
    memory: "\uC7A5\uAE30\uAE30\uC5B5"
  };
  function text(v) {
    if (v === null || v === void 0) return "";
    if (typeof v === "string") return v;
    return JSON.stringify(v, null, 2);
  }
  function conflictBadge() {
    return el("span", {
      class: "badge conflict",
      text: "\u26A0 \uCDA9\uB3CC",
      title: "RisuAI \uCABD\uC5D0\uC11C\uB3C4 \uC774 \uD56D\uBAA9\uC774 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uC5B4\uB290 \uCABD\uC744 \uB0A8\uAE38\uC9C0 \uACE8\uB77C \uC8FC\uC138\uC694"
    });
  }
  function conflictBox(item, onDone) {
    const out = el("div", { class: "outbox" });
    const mine = text(item.mine);
    const theirs = text(item.theirs);
    const decide = async (choice) => {
      clear(out);
      out.appendChild(el("div", { class: "hint", text: "\uC815\uB9AC\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        await state.resolveConflict(item.kind, item.id, choice);
        onDone();
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: e instanceof Error ? e.message : String(e) }));
      }
    };
    const keep = el("button", { class: "primary tiny", text: "\uB0B4 \uAC83 \uC720\uC9C0" });
    keep.addEventListener("click", () => void decide("mine"));
    const take = el("button", { class: "ghost tiny", text: item.theirs === null ? "RisuAI\uB300\uB85C \uC0AD\uC81C" : "RisuAI \uAC83\uC73C\uB85C" });
    take.addEventListener("click", () => void decide("theirs"));
    return el("div", { class: "conflictbox" }, [
      el("div", { class: "conflicthead" }, [
        el("span", { class: "badge conflict", text: "\u26A0 \uCDA9\uB3CC" }),
        el("span", { class: "hint", text: `${KIND[item.kind] ?? item.kind} \xB7 ${REASON[item.reason] ?? item.reason}` }),
        el("span", { class: "spacer" }),
        keep,
        take
      ]),
      item.theirs === null ? el("div", { class: "hint", text: "RisuAI \uCABD\uC5D0\uC11C\uB294 \uC774 \uD56D\uBAA9\uC774 \uC0AC\uB77C\uC84C\uC2B5\uB2C8\uB2E4. \uC5EC\uAE30\uC11C \uD3B8\uC9D1 \uC911\uC774\uB77C \uB0A8\uACA8 \uB450\uC5C8\uC2B5\uB2C8\uB2E4." }) : diffView(mine, theirs, { context: 3 }),
      out
    ]);
  }
  function openConflicts(scope, onDone) {
    const body = el("div");
    const out = el("div", { class: "outbox" });
    const render = async () => {
      clear(body);
      body.appendChild(el("div", { class: "hint", text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      let items5 = [];
      try {
        items5 = await state.conflicts(scope);
      } catch (e) {
        clear(body);
        body.appendChild(el("div", { class: "notice err", text: e instanceof Error ? e.message : String(e) }));
        return;
      }
      clear(body);
      if (!items5.length) {
        body.appendChild(el("div", { class: "empty", text: "\uB0A8\uC740 \uCDA9\uB3CC\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." }));
        onDone();
        return;
      }
      const all = (choice) => async () => {
        clear(out);
        out.appendChild(el("div", { class: "hint", text: "\uC815\uB9AC\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
        try {
          const n = await state.resolveAllConflicts(choice, scope);
          clear(out);
          out.appendChild(el("div", { class: "notice ok", text: `${n}\uAC74\uC744 \uC815\uB9AC\uD588\uC2B5\uB2C8\uB2E4.` }));
          await render();
        } catch (e) {
          clear(out);
          out.appendChild(el("div", { class: "notice err", text: e instanceof Error ? e.message : String(e) }));
        }
      };
      const mineAll = el("button", { class: "ghost tiny", text: "\uC804\uBD80 \uB0B4 \uAC83 \uC720\uC9C0" });
      mineAll.addEventListener("click", all("mine"));
      const theirsAll = el("button", { class: "ghost tiny", text: "\uC804\uBD80 RisuAI \uAC83\uC73C\uB85C" });
      theirsAll.addEventListener("click", all("theirs"));
      body.appendChild(el("div", { class: "row", style: { marginBottom: "8px" } }, [
        el("span", { class: "hint", text: `${items5.length}\uAC74` }),
        el("span", { class: "spacer" }),
        mineAll,
        theirsAll
      ]));
      for (const it of items5) {
        body.appendChild(el("div", { class: "conflictrow" }, [
          el("div", { class: "conflictname", text: `${KIND[it.kind] ?? it.kind} \xB7 ${it.label}` }),
          conflictBox(it, () => void render())
        ]));
      }
      onDone();
    };
    void render();
    modal("\uCDA9\uB3CC \uC815\uB9AC", el("div", {}, [
      el("div", {
        class: "hint",
        style: { marginBottom: "8px" },
        text: "\uD328\uB110\uC5D0\uC11C \uD3B8\uC9D1\uD55C \uD56D\uBAA9\uC744 RisuAI \uCABD\uC5D0\uC11C\uB3C4 \uBC14\uAFE8\uC2B5\uB2C8\uB2E4. \uC5B4\uB290 \uCABD\uC744 \uB0A8\uAE38\uC9C0 \uACE0\uB974\uBA74 \uBC18\uC601\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
      }),
      body,
      out
    ]), { wide: true });
  }

  // src/ui/turnlist.ts
  var ESTIMATED_ROW = 92;
  var OVERSCAN = 6;
  var TurnList = class {
    constructor(opts) {
      this.opts = opts;
      this.topSpacer = el("div", { class: "spacerTop" });
      this.bottomSpacer = el("div", { class: "spacerBottom" });
      this.body = el("div");
      this.scroller = el("div", { class: "scroller" }, [this.topSpacer, this.body, this.bottomSpacer]);
      this.root = this.scroller;
      this.scroller.addEventListener("scroll", () => this.schedule());
      window.addEventListener("resize", () => this.schedule());
    }
    root;
    scroller;
    topSpacer;
    bottomSpacer;
    body;
    /** Called with the seq of the turn currently at the top of the viewport. */
    onVisible = null;
    turns = [];
    heights = /* @__PURE__ */ new Map();
    raf = 0;
    setTurns(turns) {
      this.turns = turns;
      const live = new Set(turns.map((t) => t.msgId));
      for (const k of [...this.heights.keys()]) if (!live.has(k)) this.heights.delete(k);
      this.render();
    }
    scrollToSeq(seq) {
      let y = 0;
      for (const t of this.turns) {
        if (t.seq >= seq) break;
        y += this.heights.get(t.msgId) ?? ESTIMATED_ROW;
      }
      this.scroller.scrollTop = y;
      this.schedule();
    }
    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.render();
      });
    }
    heightOf(t) {
      return this.heights.get(t.msgId) ?? ESTIMATED_ROW;
    }
    render() {
      const viewTop = this.scroller.scrollTop;
      const viewH = this.scroller.clientHeight || 600;
      let first = 0;
      let acc = 0;
      while (first < this.turns.length && acc + this.heightOf(this.turns[first]) < viewTop) {
        acc += this.heightOf(this.turns[first]);
        first++;
      }
      const topPad = acc;
      let last = first;
      let visible = 0;
      while (last < this.turns.length && visible < viewH + ESTIMATED_ROW * OVERSCAN) {
        visible += this.heightOf(this.turns[last]);
        last++;
      }
      first = Math.max(0, first - OVERSCAN);
      last = Math.min(this.turns.length, last + OVERSCAN);
      let padTop = 0;
      for (let i = 0; i < first; i++) padTop += this.heightOf(this.turns[i]);
      let padBottom = 0;
      for (let i = last; i < this.turns.length; i++) padBottom += this.heightOf(this.turns[i]);
      this.topSpacer.style.height = padTop + "px";
      this.bottomSpacer.style.height = padBottom + "px";
      if (this.onVisible && this.turns.length) {
        const top = this.turns[Math.min(first + OVERSCAN, this.turns.length - 1)];
        if (top) this.onVisible(top.seq);
      }
      clear(this.body);
      for (let i = first; i < last; i++) {
        this.body.appendChild(this.renderTurn(this.turns[i]));
      }
      requestAnimationFrame(() => {
        let dirty = false;
        for (const child of Array.from(this.body.children)) {
          const id = child.dataset.msgid;
          if (!id) continue;
          const h = child.getBoundingClientRect().height;
          if (h > 0 && Math.abs((this.heights.get(id) ?? 0) - h) > 1) {
            this.heights.set(id, h);
            dirty = true;
          }
        }
        if (dirty) this.schedule();
      });
    }
    /**
     * Edit one turn, in a window big enough to read it in.
     *
     * This was an inline textarea inside the row. A turn here is routinely a
     * screen or two of prose, and editing it through a box a few lines tall
     * meant scrolling inside a scroll - the transcript moving underneath while
     * you worked. The modal takes the height it needs and the list holds still.
     *
     * Ctrl+Enter saves, Escape closes. Escape is the modal's own, so an
     * accidental one loses the edit - which is why the button is right there and
     * the box is large enough that nobody reaches for the keyboard to escape a
     * cramped one.
     */
    openEditor(t) {
      const box = el("textarea", { class: "turnedit", value: t.body });
      const count = el("span", { class: "hint" });
      const out = el("div");
      const sync = () => {
        const n = box.value.length;
        count.textContent = n === t.body.length ? `${n.toLocaleString()}\uC790` : `${n.toLocaleString()}\uC790 (${n > t.body.length ? "+" : ""}${n - t.body.length})`;
      };
      box.addEventListener("input", sync);
      sync();
      const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
      const cancel = el("button", { class: "ghost", text: "\uCDE8\uC18C" });
      const body = el("div", { class: "turneditwrap" }, [
        el("div", { class: "row", style: { marginBottom: "6px" } }, [
          el("span", { class: `turn-role ${t.role === "user" ? "user" : "char"}`, text: t.role }),
          t.time ? el("span", { class: "hint", text: fmtTime(t.time) }) : null,
          el("span", { class: "spacer" }),
          count
        ]),
        box,
        out,
        el("div", { class: "row", style: { marginTop: "8px" } }, [save, cancel])
      ]);
      if (t.changed && t.original != null) {
        const revert = el("button", { class: "ghost tiny", text: "\uC6D0\uBCF8\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30" });
        revert.addEventListener("click", () => {
          box.value = t.original;
          sync();
        });
        body.appendChild(el("div", { class: "card", style: { marginTop: "10px" } }, [
          el("h2", {}, [el("span", { text: "\uC6D0\uBCF8" }), el("span", { class: "spacer" }), revert]),
          el("pre", { class: "mono filepreview", text: t.original })
        ]));
      }
      const close = modal(`\uD134 ${t.seq} \uD3B8\uC9D1`, body, { wide: true });
      cancel.addEventListener("click", close);
      const commit = async () => {
        if (box.value === t.body) {
          close();
          return;
        }
        save.disabled = true;
        try {
          await this.opts.onEdit(t, box.value);
          close();
        } catch (e) {
          clear(out);
          out.appendChild(el("div", {
            class: "notice err",
            text: e instanceof Error ? e.message : String(e)
          }));
        } finally {
          save.disabled = false;
        }
      };
      save.addEventListener("click", () => void commit());
      box.addEventListener("keydown", (e) => {
        const ev = e;
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          void commit();
        }
      });
    }
    renderTurn(t) {
      const doomed = this.opts.deleting()?.has(t.msgId) ?? false;
      const cls = [
        "turn",
        t.changed ? "changed" : "",
        t.isNew ? "isnew" : "",
        doomed ? "doomed" : ""
      ].filter(Boolean).join(" ");
      const node = el("div", { class: cls, dataset: { msgid: t.msgId } });
      const startEdit = () => this.openEditor(t);
      const editBtn = el("button", {
        class: "iconbtn tiny",
        html: ICON.pencil,
        title: "\uC774 \uD134 \uD3B8\uC9D1"
      });
      editBtn.addEventListener("click", startEdit);
      node.appendChild(el("div", { class: "turn-head" }, [
        // The number leads the row. It is how every other control in this panel
        // addresses a turn - 찾기 ranges, 삭제 ranges, the range filter, and the
        // agent's own tool calls all speak in seq - so it has to be readable at a
        // glance rather than sitting mid-row in the same grey as the timestamp.
        el("span", { class: "turn-no", text: String(t.seq), title: `\uD134 ${t.seq}` }),
        el("span", { class: `turn-role ${t.role === "user" ? "user" : "char"}`, text: t.role }),
        t.time ? el("span", { text: fmtTime(t.time) }) : null,
        t.conflict ? conflictBadge() : null,
        t.changed && !t.conflict ? el("span", { class: "badge warn", text: "\uC218\uC815\uB428" }) : null,
        t.isNew ? el("span", { class: "badge ok", text: "\uCD94\uAC00\uB428" }) : null,
        doomed ? el("span", { class: "badge err", text: "\uC0AD\uC81C \uC608\uC815" }) : null,
        el("span", { class: "spacer" }),
        editBtn
      ]));
      node.addEventListener("dblclick", startEdit);
      const pendingAfter = this.opts.preview()?.get(t.msgId);
      if (pendingAfter !== void 0) {
        const { before, after } = diffFragments(t.body, pendingAfter);
        node.classList.add("preview");
        node.appendChild(el("div", { class: "before-label", text: "\uBBF8\uB9AC\uBCF4\uAE30 \u2014 \uC801\uC6A9 \uC804" }));
        node.appendChild(elWith("turn-body", before));
        node.appendChild(el("div", { class: "before-label", text: "\uC801\uC6A9 \uD6C4" }));
        node.appendChild(elWith("turn-body", after));
        return node;
      }
      const mode2 = this.opts.viewMode();
      const showDiff = t.changed && t.original != null && this.opts.showOriginal();
      if (showDiff) {
        const { before, after } = diffFragments(t.original, t.body);
        node.appendChild(el("div", { class: "before-label", text: "\uC774\uC804" }));
        node.appendChild(elWith("turn-body", before));
        node.appendChild(el("div", { class: "before-label", text: "\uC774\uD6C4" }));
        node.appendChild(elWith("turn-body", after));
      } else {
        node.appendChild(renderBody(t.body, mode2, this.opts.renderOptions()));
      }
      return node;
    }
  };
  function elWith(cls, frag) {
    const box = el("div", { class: cls });
    box.appendChild(frag);
    return box;
  }

  // src/ui/tab-editor.ts
  var list = null;
  var rightMount = null;
  var optionMount = null;
  var agentMount = null;
  var noticeMount = null;
  var countEl = null;
  var toolbarEl = null;
  var optTabBtn = null;
  var agentTabBtn = null;
  var activeTool = null;
  var showOriginal = true;
  var viewMode = "clean";
  var renderOpts = { ...DEFAULT_RENDER };
  var range = null;
  var filterBar = null;
  var preview = null;
  var deleting = null;
  var explorer = null;
  function renderEditorTab(mount) {
    if (!state.activeChatKey) {
      clear(mount);
      setToolbar(null);
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \u201C\uCC57 \uC120\uD0DD\u201D \uD0ED\uC5D0\uC11C \uCC57\uC744 \uACE8\uB77C \uC8FC\uC138\uC694." })
      ]));
      return;
    }
    if (!list || !mount.querySelector(".split")) {
      clear(mount);
      list = new TurnList({
        showOriginal: () => showOriginal,
        viewMode: () => viewMode,
        renderOptions: () => renderOpts,
        preview: () => preview,
        deleting: () => deleting,
        onEdit: async (t, next) => {
          try {
            await state.editTurn(t.msgId, t.body, next);
          } catch (e) {
            notice("\uC218\uC815\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg2(e), "err");
            void clientLog("error", "turn edit failed", { msgId: t.msgId, error: msg2(e) });
          }
        }
      });
      noticeMount = el("div");
      filterBar = el("div", { class: "filterbar", style: { display: "none" } });
      rightMount = el("div", { class: "right-inner" });
      explorer = new Explorer({
        onJump: (seq) => list?.scrollToSeq(seq),
        preview: () => preview,
        deleting: () => deleting
      });
      list.onVisible = (seq) => explorer?.setVisible(seq);
      buildToolbar();
      const pane = threePane(explorer.root);
      pane.centre.appendChild(filterBar);
      pane.centre.appendChild(noticeMount);
      pane.centre.appendChild(list.root);
      rightMount = pane.right.querySelector(".right-inner");
      mount.appendChild(pane.root);
      buildRight();
    }
    bindAgent({ onStagedChanged, onApplied, notice });
    if (agentMount) mountAgent(agentMount);
    if (toolbarEl) setToolbar(toolbarEl);
    refreshList();
  }
  function toolButton(id, glyph, label, title) {
    const b = el("button", { class: "tool", dataset: { tool: id }, title }, [
      el("span", { class: "glyph", text: glyph }),
      el("span", { class: "tool-label", text: label })
    ]);
    b.addEventListener("click", () => selectTool(id));
    return b;
  }
  function buildToolbar() {
    countEl = el("span", { class: "dim" });
    toolbarEl = el("div", { class: "toolrow" }, [
      toolButton("view", TOOL.view, "\uBCF4\uAE30", "\uC6D0\uBB38 / \uC815\uB9AC\uD574\uC11C \uBCF4\uAE30 / \uB80C\uB354\uB9C1"),
      toolButton("find", TOOL.find, "\uCC3E\uAE30", "\uCC3E\uAE30\xB7\uBC14\uAFB8\uAE30"),
      toolButton("cut", TOOL.cut, "\uC0AD\uC81C", "\uD134 \uBC94\uC704 \uC77C\uAD04 \uC0AD\uC81C"),
      toolButton("export", TOOL.export, "\uB0B4\uBCF4\uB0B4\uAE30", "md \xB7 risuChat \xB7 \uD074\uB9BD\uBCF4\uB4DC"),
      el("span", { class: "spacer" }),
      countEl
    ]);
    return toolbarEl;
  }
  function selectTool(id) {
    activeTool = activeTool === id ? null : id;
    for (const b of Array.from(toolbarEl?.querySelectorAll(".tool") ?? [])) {
      b.classList.toggle("on", b.dataset.tool === activeTool);
    }
    showTab("options");
    renderOptions();
  }
  function visibleSeq(seq) {
    if (!range || seq == null) return !range;
    return seq >= range.from && seq <= range.to;
  }
  function refreshToolbar() {
    if (!countEl) return;
    const changed = state.turns.filter((t) => t.changed).length;
    const added = state.turns.filter((t) => t.isNew).length;
    const bits = [`${state.totalTurns}\uD134`];
    if (range) bits.push(`\uD45C\uC2DC ${visibleTurns().length}`);
    if (changed) bits.push(`\uC218\uC815 ${changed}`);
    if (added) bits.push(`\uCD94\uAC00 ${added}`);
    if (preview) bits.push(`\uCE58\uD658 \uC608\uC815 ${preview.size}`);
    if (deleting) bits.push(`\uC0AD\uC81C \uC608\uC815 ${deleting.size}`);
    countEl.textContent = bits.join(" \xB7 ");
  }
  function notice(text2, kind = "") {
    if (!noticeMount) return;
    clear(noticeMount);
    noticeMount.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    setTimeout(() => {
      if (noticeMount) clear(noticeMount);
    }, 9e3);
  }
  function msg2(e) {
    return e instanceof Error ? e.message : String(e);
  }
  function visibleTurns() {
    const r = range;
    if (!r) return state.turns;
    return state.turns.filter((t) => t.seq >= r.from && t.seq <= r.to);
  }
  function setRange(next) {
    range = next;
    refreshList();
  }
  function refreshList() {
    list?.setTurns(visibleTurns());
    explorer?.setTurns(state.turns);
    syncFilterBar();
    refreshToolbar();
  }
  function syncFilterBar() {
    if (!filterBar) return;
    clear(filterBar);
    if (!range) {
      filterBar.style.display = "none";
      return;
    }
    filterBar.style.display = "flex";
    const shown = visibleTurns().length;
    const clearBtn = el("button", { class: "ghost tiny", text: "\uC804\uCCB4 \uBCF4\uAE30" });
    clearBtn.addEventListener("click", () => {
      setRange(null);
      renderOptions();
    });
    filterBar.appendChild(el("span", {
      text: `${range.from}\u2013${range.to}\uBC88 \uD134\uB9CC \uBCF4\uACE0 \uC788\uC2B5\uB2C8\uB2E4 \xB7 \uC804\uCCB4 ${state.totalTurns}\uD134 \uC911 ${shown}\uD134`
    }));
    filterBar.appendChild(el("span", { class: "spacer" }));
    filterBar.appendChild(clearBtn);
  }
  function onStagedChanged(items5) {
    const edits = items5.filter((i) => i.op === "edit" && i.after !== null);
    preview = edits.length ? new Map(edits.map((i) => [i.msgId, String(i.after)])) : null;
    const dels = items5.filter((i) => i.op === "delete");
    deleting = dels.length ? new Set(dels.map((i) => i.msgId)) : null;
    if (range && items5.length && !items5.some((i) => visibleSeq(i.seq))) {
      range = null;
      notice("\uC81C\uC548\uB41C \uD134\uC774 \uD45C\uC2DC \uBC94\uC704 \uBC16\uC774\uB77C \uC804\uCCB4 \uBCF4\uAE30\uB85C \uB3CC\uC544\uAC14\uC2B5\uB2C8\uB2E4.");
    }
    refreshList();
    if (edits.length) list?.scrollToSeq(edits[0].seq ?? 0);
  }
  async function onApplied() {
    preview = null;
    deleting = null;
    await state.loadTurns();
  }
  function buildRight() {
    if (!rightMount) return;
    optionMount = el("div", { class: "pad rpanel" });
    agentMount = el("div", { class: "rpanel agentwrap active" });
    optTabBtn = el("button", { class: "rtab", text: "\uC0C1\uC138\uC635\uC158" });
    agentTabBtn = el("button", { class: "rtab active", text: "AI \uC5D0\uC774\uC804\uD2B8" });
    optTabBtn.addEventListener("click", () => showTab("options"));
    agentTabBtn.addEventListener("click", () => showTab("agent"));
    rightMount.appendChild(el("div", { class: "rtabs" }, [optTabBtn, agentTabBtn]));
    rightMount.appendChild(optionMount);
    rightMount.appendChild(agentMount);
    renderOptions();
    showTab("agent");
  }
  function showTab(which) {
    if (which === "agent") void agentPanel().load();
    optionMount?.classList.toggle("active", which === "options");
    agentMount?.classList.toggle("active", which === "agent");
    optTabBtn?.classList.toggle("active", which === "options");
    agentTabBtn?.classList.toggle("active", which === "agent");
  }
  function renderOptions() {
    if (!optionMount) return;
    clear(optionMount);
    switch (activeTool) {
      case "view":
        optionMount.appendChild(buildViewOptions());
        break;
      case "find":
        optionMount.appendChild(buildFind());
        break;
      case "cut":
        optionMount.appendChild(buildCut());
        break;
      case "export":
        optionMount.appendChild(buildExport());
        break;
      default:
        optionMount.appendChild(el("div", {
          class: "empty",
          text: "\uC704 \uB3C4\uAD6C\uB97C \uC120\uD0DD\uD558\uC2DC\uBA74 \uC5EC\uAE30\uC5D0 \uC0C1\uC138 \uC635\uC158\uC774 \uB098\uC635\uB2C8\uB2E4."
        }));
    }
  }
  function buildViewOptions() {
    const modes = [
      ["rendered", "\uB80C\uB354\uB9C1\uD574\uC11C \uBCF4\uAE30", "\uCE74\uB4DC\uC758 editdisplay \uC815\uADDC\uC2DD\uACFC backgroundHTML CSS\uAE4C\uC9C0 \uC801\uC6A9\uD569\uB2C8\uB2E4"],
      ["clean", "\uC815\uB9AC\uD574\uC11C \uBCF4\uAE30", "\uC0AC\uACE0\uC0AC\uC2AC\xB7\uD0DC\uADF8 \uAC19\uC740 \uB178\uC774\uC988\uB9CC \uAC77\uC5B4\uB0C5\uB2C8\uB2E4. RisuAI \uC7AC\uD604\uC740 \uC544\uB2D9\uB2C8\uB2E4"],
      ["raw", "\uC6D0\uBB38 \uBCF4\uAE30", "\uC800\uC7A5\uB41C \uADF8\uB300\uB85C\uC785\uB2C8\uB2E4. \uD3B8\uC9D1\uC740 \uC5B8\uC81C\uB098 \uC774 \uD14D\uC2A4\uD2B8\uB97C \uACE0\uCE69\uB2C8\uB2E4"]
    ];
    const optsBox = el("div", { class: "stripopts" });
    const buttons = [];
    const setMode = (m) => {
      if (m === "rendered") {
        notice("\u201C\uB80C\uB354\uB9C1\uD574\uC11C \uBCF4\uAE30\u201D\uB294 \uC544\uC9C1 \uC900\uBE44 \uC911\uC785\uB2C8\uB2E4. \u201C\uC815\uB9AC\uD574\uC11C \uBCF4\uAE30\u201D\uB85C \uB3CC\uC544\uAC11\uB2C8\uB2E4.");
        m = "clean";
      }
      viewMode = m;
      for (const b of buttons) b.classList.toggle("on", b.dataset.mode === m);
      optsBox.style.display = m === "clean" ? "block" : "none";
      refreshList();
    };
    const rows = modes.map(([m, label, why]) => {
      const b = el("button", { class: "modebtn", dataset: { mode: m } }, [
        el("div", { text: label + (m === "rendered" ? "   (\uCD94\uD6C4 \uAD6C\uD604)" : "") }),
        el("div", { class: "hint", text: why })
      ]);
      if (m === "rendered") b.classList.add("todo");
      b.addEventListener("click", () => setMode(m));
      buttons.push(b);
      return b;
    });
    const toggle = (label, key, title) => {
      const box = el("input", { type: "checkbox", checked: renderOpts[key] });
      box.addEventListener("change", () => {
        renderOpts[key] = box.checked;
        refreshList();
      });
      return el("label", { class: "checkrow", title }, [box, el("span", { text: label })]);
    };
    optsBox.appendChild(el("div", { class: "card" }, [
      el("h2", { text: "\uC815\uB9AC \uC635\uC158" }),
      toggle("\uC0AC\uACE0\uC0AC\uC2AC \uC81C\uAC70", "stripThinking", "<thoughts>, <think> \uAC19\uC740 \uCD94\uB860 \uBE14\uB85D\uC744 \uC228\uAE41\uB2C8\uB2E4"),
      toggle("\uD0DC\uADF8 \uC81C\uAC70", "stripTags", "img\uB97C \uC81C\uC678\uD55C \uBAA8\uB4E0 \uD0DC\uADF8\uB97C \uC228\uAE41\uB2C8\uB2E4"),
      toggle("\uCF54\uB4DC\uBE14\uB85D \uC81C\uAC70", "stripPanels", "```\uB85C \uB458\uB7EC\uC2FC \uD328\uB110\xB7\uC0C1\uD0DC\uCC3D\uC744 \uC228\uAE41\uB2C8\uB2E4"),
      toggle("\uAC15\uC870 \uB80C\uB354", "markdown", "**\uAD75\uAC8C**, *\uAE30\uC6B8\uC784*, `\uCF54\uB4DC`\uB97C \uC2E4\uC81C \uC11C\uC2DD\uC73C\uB85C \uBCF4\uC5EC \uC90D\uB2C8\uB2E4"),
      toggle("\uB300\uC0AC\xB7\uC0DD\uAC01 \uC0C9", "quotes", "\u201C\uD070\uB530\uC634\uD45C\u201D\uB294 \uB300\uC0AC(\uC8FC\uD669), \u2018\uC791\uC740\uB530\uC634\uD45C\u2019\uB294 \uC18D\uB9C8\uC74C(\uD558\uB298\uC0C9)\uC73C\uB85C \uCE60\uD569\uB2C8\uB2E4")
    ]));
    const diffToggle = el("button", { class: "ghost" });
    const syncDiff = () => {
      diffToggle.textContent = `\uC218\uC815\uD55C \uD134 \uC804-\uD6C4 \uBE44\uAD50: ${showOriginal ? "\uCF2C" : "\uB054"}`;
    };
    syncDiff();
    diffToggle.addEventListener("click", () => {
      showOriginal = !showOriginal;
      syncDiff();
      refreshList();
    });
    const jump = el("input", { placeholder: "\uD134 \uBC88\uD638\uB85C \uC774\uB3D9" });
    jump.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const n = Number(jump.value);
      if (Number.isFinite(n)) list?.scrollToSeq(n);
    });
    const root = el("div", {}, [
      el("div", { class: "card" }, [el("h2", { text: "\uBCF4\uAE30 \uBAA8\uB4DC" }), ...rows]),
      optsBox,
      buildRangeCard(),
      el("div", { class: "card" }, [diffToggle, el("div", { style: { marginTop: "8px" } }, [jump])])
    ]);
    setMode(viewMode);
    return root;
  }
  function buildRangeCard() {
    const first = state.turns.length ? state.turns[0].seq : 0;
    const last = state.turns.length ? state.turns[state.turns.length - 1].seq : 0;
    const from = el("input", { placeholder: String(first), value: range ? String(range.from) : "" });
    const to = el("input", { placeholder: String(last), value: range ? String(range.to) : "" });
    const hint = el("div", { class: "hint" });
    const syncHint = () => {
      hint.textContent = range ? `${range.from}\u2013${range.to}\uBC88\uB9CC \uBCF4\uC774\uB294 \uC911\uC785\uB2C8\uB2E4. \uCC3E\uAE30\xB7\uC0AD\uC81C\uB294 \uAC01\uC790 \uBC94\uC704\uB97C \uB530\uB85C \uBC1B\uC73C\uB2C8 \uC774 \uD544\uD130\uC5D0 \uC601\uD5A5\uBC1B\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.` : `\uC804\uCCB4 ${state.totalTurns}\uD134\uC744 \uBCF4\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uBE44\uC6CC \uB450\uC2DC\uBA74 \uCC98\uC74C(${first})\uACFC \uB05D(${last})\uC73C\uB85C \uC7A1\uC2B5\uB2C8\uB2E4.`;
    };
    syncHint();
    const parse = (input, fallback) => {
      const raw = input.value.trim();
      if (!raw) return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const apply = () => {
      const a = parse(from, first);
      const b = parse(to, last);
      if (a === null || b === null) {
        notice("\uD134 \uBC88\uD638\uB294 \uC22B\uC790\uB85C \uB123\uC5B4 \uC8FC\uC138\uC694.", "err");
        return;
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (lo <= first && hi >= last) {
        setRange(null);
        from.value = "";
        to.value = "";
        syncHint();
        return;
      }
      setRange({ from: lo, to: hi });
      from.value = String(lo);
      to.value = String(hi);
      syncHint();
      if (!visibleTurns().length) {
        notice(`${lo}\u2013${hi} \uAD6C\uAC04\uC5D0\uB294 \uD134\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBC94\uC704\uB97C \uB2E4\uC2DC \uC7A1\uC544 \uC8FC\uC138\uC694.`, "err");
      } else {
        list?.scrollToSeq(lo);
      }
    };
    const applyBtn3 = el("button", { class: "primary", text: "\uC801\uC6A9" });
    applyBtn3.addEventListener("click", apply);
    const allBtn = el("button", { class: "ghost", text: "\uC804\uCCB4" });
    allBtn.addEventListener("click", () => {
      from.value = "";
      to.value = "";
      setRange(null);
      syncHint();
    });
    for (const input of [from, to]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
      });
    }
    return el("div", { class: "card" }, [
      el("h2", { text: "\uD45C\uC2DC \uBC94\uC704" }),
      el("div", { class: "rangerow" }, [
        from,
        el("span", { class: "hint", text: "~" }),
        to,
        applyBtn3,
        allBtn
      ]),
      hint
    ]);
  }
  function buildFind() {
    const pattern = el("input", { placeholder: "\uCC3E\uC744 \uBB38\uC790\uC5F4" });
    const replacement = el("input", { placeholder: "\uBC14\uAFC0 \uBB38\uC790\uC5F4" });
    const fromSeq = el("input", { placeholder: "\uC2DC\uC791 \uD134", style: { width: "90px" } });
    const toSeq = el("input", { placeholder: "\uB05D \uD134", style: { width: "90px" } });
    const summary = el("div", { class: "hint" });
    const previewBtn = el("button", { text: "\uBBF8\uB9AC\uBCF4\uAE30" });
    const applyBtn3 = el("button", { class: "primary", text: "\uC801\uC6A9", disabled: true });
    const clearBtn = el("button", { class: "ghost", text: "\uD574\uC81C", disabled: true });
    const params = (apply = false) => ({
      pattern: pattern.value,
      replacement: replacement.value,
      regex: false,
      fromSeq: fromSeq.value.trim() === "" ? void 0 : Number(fromSeq.value),
      toSeq: toSeq.value.trim() === "" ? void 0 : Number(toSeq.value),
      ...apply ? { apply: true } : {}
    });
    const setPreview = (p) => {
      preview = p ? new Map(p.changes.map((c) => [c.msgId, c.after])) : null;
      applyBtn3.disabled = !p || p.matchedTurns === 0;
      clearBtn.disabled = !p;
      summary.textContent = p ? p.matchedTurns ? `${p.matchedTurns}\uAC1C \uD134 \xB7 ${p.totalHits}\uACF3 \u2014 \uC67C\uCABD\uC5D0 \uD45C\uC2DC\uD588\uC2B5\uB2C8\uB2E4` : "\uC77C\uCE58\uD558\uB294 \uD134\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." : "";
      refreshList();
      if (p?.changes.length) list?.scrollToSeq(p.changes[0].seq);
      refreshToolbar();
    };
    previewBtn.addEventListener("click", async () => {
      if (!pattern.value) {
        notice("\uCC3E\uC744 \uBB38\uC790\uC5F4\uC744 \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
        return;
      }
      previewBtn.disabled = true;
      try {
        setPreview(await state.bulk(params()));
      } catch (e) {
        summary.textContent = msg2(e);
        setPreview(null);
      } finally {
        previewBtn.disabled = false;
      }
    });
    applyBtn3.addEventListener("click", async () => {
      applyBtn3.disabled = true;
      try {
        await state.checkpoint("\uCC3E\uAE30\xB7\uBC14\uAFB8\uAE30 \uC9C1\uC804");
        const r = await state.bulk(params(true));
        setPreview(null);
        await state.loadTurns();
        notice(`${r.applied}\uAC1C \uD134\uC744 \uBC14\uAFE8\uC2B5\uB2C8\uB2E4. \uB418\uB3CC\uB9AC\uC2DC\uB824\uBA74 \u{1F558} \uBC84\uC804\uC758 \uC2A4\uB0C5\uC0F7\uC744 \uC4F0\uC2DC\uBA74 \uB429\uB2C8\uB2E4.`, "ok");
      } catch (e) {
        void clientLog("error", "find/replace apply failed", { error: msg2(e) });
        notice("\uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg2(e), "err");
      }
    });
    clearBtn.addEventListener("click", () => setPreview(null));
    return el("div", { class: "card" }, [
      el("h2", { text: "\uCC3E\uAE30 \xB7 \uBC14\uAFB8\uAE30" }),
      el("label", { class: "field" }, [el("span", { text: "\uCC3E\uAE30" }), pattern]),
      el("label", { class: "field" }, [el("span", { text: "\uBC14\uAFB8\uAE30" }), replacement]),
      el("div", { class: "row" }, [fromSeq, el("span", { class: "hint", text: "~" }), toSeq]),
      el("div", { class: "row" }, [previewBtn, applyBtn3, clearBtn]),
      summary,
      el("div", { class: "hint", text: "\uBC94\uC704\uB97C \uBE44\uC6B0\uBA74 \uC804\uCCB4\uAC00 \uB300\uC0C1\uC785\uB2C8\uB2E4. \uC801\uC6A9 \uC9C1\uC804\uC5D0 \uC2A4\uB0C5\uC0F7\uC774 \uC790\uB3D9\uC73C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4." })
    ]);
  }
  function buildCut() {
    const fromSeq = el("input", { placeholder: "\uC2DC\uC791 \uD134", style: { width: "90px" } });
    const toSeq = el("input", { placeholder: "\uB05D \uD134", style: { width: "90px" } });
    const summary = el("div", { class: "hint" });
    const previewBtn = el("button", { text: "\uBBF8\uB9AC\uBCF4\uAE30" });
    const applyBtn3 = el("button", { class: "danger", disabled: true });
    const clearBtn = el("button", { class: "ghost", text: "\uD574\uC81C", disabled: true });
    const range2 = () => {
      if (fromSeq.value.trim() === "" || toSeq.value.trim() === "") return null;
      const a = Number(fromSeq.value);
      const b = Number(toSeq.value);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a) return null;
      return [a, b];
    };
    const setPreview = (ids, label = "") => {
      deleting = ids;
      applyBtn3.disabled = !ids || ids.size === 0;
      clearBtn.disabled = !ids;
      summary.textContent = label;
      refreshList();
      refreshToolbar();
    };
    previewBtn.addEventListener("click", () => {
      const r = range2();
      if (!r) {
        notice("\uC0AD\uC81C\uD560 \uD134 \uBC94\uC704\uB97C \uC62C\uBC14\uB974\uAC8C \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
        return;
      }
      const [a, b] = r;
      const hit = state.turns.filter((t) => t.seq >= a && t.seq <= b);
      setPreview(new Set(hit.map((t) => t.msgId)), `${hit.length}\uAC1C \uD134\uC774 \uC0AD\uC81C\uB429\uB2C8\uB2E4 \u2014 \uC67C\uCABD\uC5D0 \uD45C\uC2DC\uD588\uC2B5\uB2C8\uB2E4`);
      if (hit.length) list?.scrollToSeq(hit[0].seq);
    });
    armed(applyBtn3, "\uC801\uC6A9", "\uC815\uB9D0 \uC0AD\uC81C\uD560\uAE4C\uC694?", async () => {
      const r = range2();
      if (!r) return;
      try {
        await state.checkpoint("\uD134 \uC0AD\uC81C \uC9C1\uC804");
        await state.deleteRange(r[0], r[1]);
        setPreview(null);
        notice(`\uD134 ${r[0]}~${r[1]} \uC744 \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4. \uD558\uC774\uD30C \uC694\uC57D\uC774 \uC9C0\uC6CC\uC9C4 \uD134\uC744 \uC778\uC6A9\uD558\uACE0 \uC788\uC73C\uBA74 \uBC18\uC601\uD560 \uB54C \uC54C\uB824 \uB4DC\uB9BD\uB2C8\uB2E4.`, "ok");
      } catch (e) {
        void clientLog("error", "deleteRange failed", { range: r, error: msg2(e) });
        notice("\uC0AD\uC81C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg2(e), "err");
      }
    });
    clearBtn.addEventListener("click", () => setPreview(null));
    return el("div", { class: "card" }, [
      el("h2", { text: "\uD134 \uC77C\uAD04 \uC0AD\uC81C" }),
      el("div", { class: "row" }, [fromSeq, el("span", { class: "hint", text: "~" }), toSeq]),
      el("div", { class: "row" }, [previewBtn, applyBtn3, clearBtn]),
      summary,
      el("div", { class: "hint", text: "\uC0AD\uC81C \uC9C1\uC804\uC5D0 \uC2A4\uB0C5\uC0F7\uC774 \uC790\uB3D9\uC73C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4." })
    ]);
  }
  function buildExport() {
    const md = el("button", { text: "md \uB0B4\uB824\uBC1B\uAE30" });
    md.addEventListener("click", async () => {
      try {
        const r = await state.exportMarkdown();
        download(r.filename, r.markdown, "text/markdown;charset=utf-8");
      } catch (e) {
        notice("\uB0B4\uBCF4\uB0B4\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg2(e), "err");
      }
    });
    const rc = el("button", { text: "risuChat \uB0B4\uB824\uBC1B\uAE30" });
    rc.addEventListener("click", async () => {
      try {
        const r = await state.exportRisuchat();
        download(r.filename, JSON.stringify(r.envelope), "application/json");
      } catch (e) {
        notice("\uB0B4\uBCF4\uB0B4\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg2(e), "err");
      }
    });
    const cb = el("button", { class: "ghost", text: "md \uD074\uB9BD\uBCF4\uB4DC \uBCF5\uC0AC" });
    cb.addEventListener("click", async () => {
      try {
        const r = await state.exportMarkdown();
        const ok = copyToClipboard(r.markdown);
        notice(ok ? "\uD074\uB9BD\uBCF4\uB4DC\uC5D0 \uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4." : "\uBCF5\uC0AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", ok ? "ok" : "err");
      } catch (e) {
        notice("\uBCF5\uC0AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg2(e), "err");
      }
    });
    return el("div", { class: "card" }, [
      el("h2", { text: "\uB0B4\uBCF4\uB0B4\uAE30" }),
      el("div", { class: "row" }, [md]),
      el("div", { class: "row" }, [rc]),
      el("div", { class: "row" }, [cb]),
      el("div", { class: "hint", text: "risuChat JSON\uC740 RisuAI \uAE30\uBCF8 \uC784\uD3EC\uD130\uAC00 \uADF8\uB300\uB85C \uBC1B\uC544 \uC90D\uB2C8\uB2E4." })
    ]);
  }

  // src/ui/tab-files.ts
  var AREA_LABEL = {
    uploads: ["\uC5C5\uB85C\uB4DC", "\uC9C1\uC811 \uC62C\uB9AC\uC2E0 \uCC38\uACE0 \uD30C\uC77C\uC785\uB2C8\uB2E4. \uC815\uB9AC\uD574\uB3C4 \uB0A8\uC2B5\uB2C8\uB2E4."],
    out: ["\uACB0\uACFC\uBB3C", "AI\uAC00 \uB9CC\uB4E0 \uC0B0\uCD9C\uBB3C\uC785\uB2C8\uB2E4. \uB0B4\uB824\uBC1B\uAE30 \uC804\uC774\uBA74 \uB0A8\uACA8 \uB450\uC138\uC694."],
    original: ["\uC6D0\uBCF8", "\uAC00\uC838\uC628 \uADF8\uB300\uB85C\uC758 \uC2A4\uB0C5\uC0F7\uC785\uB2C8\uB2E4. \uBE44\uAD50 \uAE30\uC900\uC774\uB77C \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."],
    scripts: ["\uC2A4\uD06C\uB9BD\uD2B8", "AI\uAC00 \uC791\uC131\uD574 \uC2E4\uD589\uD55C \uD30C\uC774\uC36C\uC785\uB2C8\uB2E4."],
    skills: ["\uC2A4\uD0AC", "\uCF1C \uB454 \uC2A4\uD06C\uB9BD\uD2B8 \uC2A4\uD0AC\uC774 \uC2E4\uD589 \uB54C\uB9C8\uB2E4 \uC5EC\uAE30\uB85C \uBCF5\uC0AC\uB429\uB2C8\uB2E4."],
    scratch: ["\uC784\uC2DC", "AI\uC758 \uC791\uC5C5\uC6A9 \uD30C\uC77C\uC785\uB2C8\uB2E4. \uC5B8\uC81C \uC9C0\uC6CC\uB3C4 \uB429\uB2C8\uB2E4."],
    ".scratch": ["\uB0B4\uBD80", "\uC2A4\uCF54\uD504 \uC2A4\uB0C5\uC0F7\uACFC \uC81C\uC548 \uD050\uC785\uB2C8\uB2E4. \uB2E4\uC74C \uC2E4\uD589 \uB54C \uB2E4\uC2DC \uB9CC\uB4E4\uC5B4\uC9D1\uB2C8\uB2E4."]
  };
  var USER_AREAS = /* @__PURE__ */ new Set(["uploads", "out"]);
  var SURFACE_FROM = /* @__PURE__ */ new Set(["scratch", "scripts"]);
  var DOCUMENT_EXT = /* @__PURE__ */ new Set([
    "md",
    "markdown",
    "txt",
    "html",
    "htm",
    "csv",
    "tsv",
    "json",
    "yaml",
    "yml",
    "xml",
    "rtf",
    "pdf",
    "docx"
  ]);
  var IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
  var TEXT_UPLOAD_RE = /\.(md|txt|json|jsonl|csv|py|html?|css|js|ya?ml|xml|log|sql)$/i;
  var DOCS_NODE = "@docs";
  function isDocument(f) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    return ext !== f.name.toLowerCase() && DOCUMENT_EXT.has(ext);
  }
  var built = false;
  var seenFilesRev = -1;
  var treeMount = null;
  var viewMount = null;
  var noticeMount2 = null;
  var showInternal = false;
  var lastListing = null;
  var nodes = /* @__PURE__ */ new Map();
  var selectedDir = "uploads";
  var selection = /* @__PURE__ */ new Set();
  var anchorPath = "";
  var previewPath = "";
  var confirmDelete = false;
  var view = "list";
  try {
    if (localStorage.getItem("hina.filesView") === "grid") view = "grid";
  } catch {
  }
  var expanded = /* @__PURE__ */ new Set(["uploads", "out"]);
  var thumbs = /* @__PURE__ */ new Map();
  function renderFilesTab(mount) {
    if (!state.activeCharKey) {
      clear(mount);
      built = false;
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \u201C\uCC57 \uC120\uD0DD\u201D \uD0ED\uC5D0\uC11C \uCC57\uC744 \uACE8\uB77C \uC8FC\uC138\uC694." })
      ]));
      return;
    }
    if (!built || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      treeMount = el("div", { class: "tree filetree" });
      pane.left.appendChild(treeMount);
      noticeMount2 = el("div");
      viewMount = el("div", { class: "pad filepad" });
      pane.centre.appendChild(noticeMount2);
      pane.centre.appendChild(viewMount);
      installDrop(viewMount, () => uploadTarget());
      mount.appendChild(pane.root);
      mountAgent(pane.right.querySelector(".right-inner"));
      built = true;
      seenFilesRev = state.filesRev;
      void refresh();
    } else if (seenFilesRev !== state.filesRev) {
      seenFilesRev = state.filesRev;
      void refresh();
    }
    state.markOutputsSeen();
    bindAgent({ notice: notice2 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function notice2(text2, kind = "") {
    if (!noticeMount2) return;
    clear(noticeMount2);
    noticeMount2.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount2) clear(noticeMount2);
    }, 9e3);
  }
  async function refresh() {
    if (!treeMount) return;
    try {
      const data = await state.files();
      lastListing = data;
      buildNodes(data);
      if (!nodes.has(selectedDir)) selectedDir = nodes.has("uploads") ? "uploads" : nodes.keys().next().value ?? "";
      const alive = new Set(allPaths());
      selection = new Set([...selection].filter((p) => alive.has(p)));
      const want = state.openFileRequest;
      if (want) {
        state.openFileRequest = null;
        const dir = want.includes("/") ? want.slice(0, want.lastIndexOf("/")) : want;
        if (nodes.has(dir)) {
          selectedDir = dir;
          expandTo(dir);
        }
        previewPath = want;
        selection = /* @__PURE__ */ new Set([want]);
      }
      drawTree();
      drawCentre();
    } catch (e) {
      clear(treeMount);
      treeMount.appendChild(el("div", { class: "notice err", text: msg3(e) }));
      void clientLog("error", "files tab refresh failed", {
        error: msg3(e),
        stack: e instanceof Error ? String(e.stack).slice(0, 1500) : ""
      });
    }
  }
  function buildNodes(data) {
    nodes = /* @__PURE__ */ new Map();
    const shown = data.areas.filter((a) => showInternal || USER_AREAS.has(a.area));
    for (const area of shown) {
      const root = { path: area.area, name: AREA_LABEL[area.area]?.[0] ?? area.area, area, kids: [], files: [] };
      nodes.set(root.path, root);
      const ensure = (path) => {
        const have = nodes.get(path);
        if (have) return have;
        const parentPath = path.slice(0, path.lastIndexOf("/"));
        const parent = ensure(parentPath);
        const node = { path, name: path.slice(path.lastIndexOf("/") + 1), area, kids: [], files: [] };
        parent.kids.push(node);
        nodes.set(path, node);
        return node;
      };
      for (const d of area.dirs ?? []) ensure(d);
      for (const f of area.files) {
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : area.area;
        ensure(dir).files.push(f);
      }
      for (const n of nodes.values()) {
        n.kids.sort((a, b) => a.name.localeCompare(b.name));
        n.files.sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    if (!showInternal) {
      const docs = [];
      let anyArea = null;
      for (const area of data.areas) {
        if (!SURFACE_FROM.has(area.area)) continue;
        const mine = area.files.filter(isDocument);
        if (mine.length) {
          docs.push(...mine);
          anyArea = anyArea ?? area;
        }
      }
      if (docs.length && anyArea) {
        nodes.set(DOCS_NODE, {
          path: DOCS_NODE,
          name: "\uC784\uC2DC \uBB38\uC11C",
          area: { ...anyArea, deletable: true },
          kids: [],
          files: docs,
          virtual: true
        });
      }
    }
  }
  function allPaths() {
    const out = [];
    for (const n of nodes.values()) {
      out.push(n.path);
      for (const f of n.files) out.push(f.path);
    }
    return out;
  }
  function expandTo(path) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
  }
  function uploadTarget() {
    const n = nodes.get(selectedDir);
    if (n && !n.virtual && USER_AREAS.has(n.area.area)) return n.path;
    return "uploads";
  }
  function moveTargets() {
    const out = [];
    for (const a of lastListing?.areas ?? []) {
      if (!a.deletable) continue;
      out.push(a.area);
      for (const d of a.dirs ?? []) out.push(d);
    }
    return out;
  }
  function drawTree() {
    if (!treeMount || !lastListing) return;
    clear(treeMount);
    const data = lastListing;
    const filePicker = el("input", { type: "file", multiple: true, style: { display: "none" } });
    filePicker.addEventListener("change", () => {
      const files = Array.from(filePicker.files ?? []).map((file) => ({ file, rel: "" }));
      filePicker.value = "";
      void uploadMany(files, uploadTarget());
    });
    const dirPicker = el("input", { type: "file", multiple: true, style: { display: "none" } });
    dirPicker.setAttribute("webkitdirectory", "");
    dirPicker.addEventListener("change", () => {
      const files = Array.from(dirPicker.files ?? []).map((file) => {
        const rel = String(file.webkitRelativePath || file.name);
        return { file, rel: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "" };
      });
      dirPicker.value = "";
      void uploadMany(files, uploadTarget());
    });
    const uploadBtn = el("button", { class: "primary tiny", text: "\uC62C\uB9AC\uAE30", title: "\uD30C\uC77C\uC744 \uACE8\uB77C \uC9C0\uAE08 \uD3F4\uB354\uC5D0 \uC62C\uB9BD\uB2C8\uB2E4" });
    uploadBtn.addEventListener("click", () => filePicker.click());
    const uploadDirBtn = el("button", { class: "ghost tiny", text: "\uD3F4\uB354 \uC62C\uB9AC\uAE30", title: "\uD3F4\uB354\uC9F8 \uC62C\uB9BD\uB2C8\uB2E4 (\uC548\uC758 \uD3F4\uB354 \uAD6C\uC870 \uC720\uC9C0)" });
    uploadDirBtn.addEventListener("click", () => dirPicker.click());
    const newDir = el("button", { class: "ghost tiny", text: "\uC0C8 \uD3F4\uB354", title: "\uC9C0\uAE08 \uD3F4\uB354 \uC548\uC5D0 \uD3F4\uB354\uB97C \uB9CC\uB4ED\uB2C8\uB2E4" });
    newDir.addEventListener("click", () => {
      const body = el("div", { class: "applypop" });
      const close = popover(newDir, body);
      const where = uploadTarget();
      const name = el("input", { placeholder: "\uD3F4\uB354 \uC774\uB984" });
      const ok = el("button", { class: "primary tiny", text: "\uB9CC\uB4E4\uAE30" });
      ok.addEventListener("click", async () => {
        const n = name.value.trim().replace(/[\\/]+/g, "-");
        if (!n) return;
        try {
          await state.mkdirFile(where + "/" + n);
          close();
          expandTo(where + "/" + n);
          await refresh();
        } catch (e) {
          notice2("\uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg3(e), "err");
        }
      });
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok.click();
      });
      body.appendChild(el("div", { class: "hint", text: `${where}/ \uC548\uC5D0` }));
      body.appendChild(el("div", { class: "row" }, [name, ok]));
      setTimeout(() => name.focus(), 0);
    });
    const reloadBtn = el("button", { class: "ghost tiny", text: "\uC0C8\uB85C\uACE0\uCE68" });
    reloadBtn.addEventListener("click", () => void refresh());
    treeMount.appendChild(el("div", { class: "treehead" }, [uploadBtn, uploadDirBtn, newDir, reloadBtn, filePicker, dirPicker]));
    let any = false;
    const roots = [...nodes.values()].filter((n) => !n.path.includes("/") && n.path !== DOCS_NODE);
    for (const root of roots) {
      if (!root.area.count && !root.kids.length) continue;
      any = true;
      treeMount.appendChild(nodeRow(root, 0));
    }
    const docs = nodes.get(DOCS_NODE);
    if (docs) {
      any = true;
      treeMount.appendChild(nodeRow(docs, 0));
    }
    if (!any) {
      treeMount.appendChild(el("div", {
        class: "hint",
        style: { padding: "8px" },
        text: showInternal ? "\uD30C\uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." : "\uC62C\uB9B0 \uD30C\uC77C\uB3C4 \uACB0\uACFC\uBB3C\uB3C4 \uC544\uC9C1 \uC5C6\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uB04C\uC5B4\uB2E4 \uB193\uC73C\uBA74 \uC62C\uB77C\uAC11\uB2C8\uB2E4."
      }));
    }
    const hidden = data.areas.filter((a) => !USER_AREAS.has(a.area) && a.count > 0);
    const toggle = el("button", {
      class: "ghost tiny",
      text: showInternal ? "\uB0B4\uBD80 \uD30C\uC77C \uC228\uAE30\uAE30" : `\uB0B4\uBD80 \uD30C\uC77C \uBCF4\uAE30 (${hidden.reduce((n, a) => n + a.count, 0)})`
    });
    toggle.addEventListener("click", () => {
      showInternal = !showInternal;
      void refresh();
    });
    const cleanBtn = el("button", { class: "ghost tiny" });
    armed(cleanBtn, "\uC784\uC2DC \uC815\uB9AC", "\uC815\uB9D0 \uC815\uB9AC\uD560\uAE4C\uC694?", async () => {
      try {
        const r = await state.cleanFiles();
        notice2(`${r.removed}\uAC1C\uB97C \uC9C0\uC6CC ${fmtSize2(r.freed)}\uB97C \uBE44\uC6E0\uC2B5\uB2C8\uB2E4.`, "ok");
        await refresh();
      } catch (e) {
        notice2("\uC815\uB9AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg3(e), "err");
      }
    });
    treeMount.appendChild(el("div", { class: "treefoot" }, [
      toggle,
      cleanBtn,
      el("div", { class: "hint", text: `\uC804\uCCB4 ${fmtSize2(data.totalSize)}` })
    ]));
  }
  function nodeRow(n, depth) {
    const isOpen = expanded.has(n.path);
    const caret = el("button", { class: "caret", text: n.kids.length ? isOpen ? "\u25BE" : "\u25B8" : "" });
    const count = n.files.length + n.kids.reduce((s, k) => s + countFiles(k), 0);
    const [, why] = AREA_LABEL[n.area.area] ?? ["", ""];
    const branch = el("button", {
      class: "treebranch" + (n.path === selectedDir ? " on" : ""),
      title: n.virtual ? `${SURFACE_FROM.size ? "scratch/\xB7scripts/" : ""} \uC5D0 \uC788\uB294 \uBB38\uC11C\uC785\uB2C8\uB2E4. \uC5EC\uAE30\uC11C \uBC14\uB85C \uBCFC \uC218 \uC788\uC2B5\uB2C8\uB2E4.` : depth ? n.path : why
    }, [
      el("span", { text: n.virtual ? "\u{1F4C4}" : isOpen && n.kids.length ? "\u{1F4C2}" : "\u{1F4C1}" }),
      el("span", { class: "grow", text: n.name, style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }),
      el("span", { class: "n", text: String(count) })
    ]);
    branch.addEventListener("click", () => {
      selectedDir = n.path;
      previewPath = "";
      selection.clear();
      confirmDelete = false;
      if (n.kids.length) expanded.add(n.path);
      drawTree();
      drawCentre();
    });
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expanded.has(n.path)) expanded.delete(n.path);
      else expanded.add(n.path);
      drawTree();
    });
    if (!n.virtual && USER_AREAS.has(n.area.area)) installDrop(branch, () => n.path);
    const kids = el(
      "div",
      { class: "treekids", style: { display: isOpen ? "" : "none" } },
      n.kids.map((k) => nodeRow(k, depth + 1))
    );
    return el("div", {}, [el("div", { class: "treerow" }, [caret, branch]), kids]);
  }
  function countFiles(n) {
    return n.files.length + n.kids.reduce((s, k) => s + countFiles(k), 0);
  }
  function drawCentre() {
    if (!viewMount) return;
    clear(viewMount);
    const n = nodes.get(selectedDir);
    if (!n) {
      viewMount.appendChild(el("div", { class: "empty", text: "\uC67C\uCABD\uC5D0\uC11C \uD3F4\uB354\uB97C \uACE0\uB974\uC138\uC694." }));
      return;
    }
    if (previewPath) {
      const f = n.files.find((x) => x.path === previewPath) ?? findFile(previewPath);
      if (f) {
        void drawPreview(f, n);
        return;
      }
      previewPath = "";
    }
    const writable = !n.virtual && USER_AREAS.has(n.area.area);
    const deletable = n.area.deletable;
    const hasImages = n.files.some((f) => IMAGE_RE.test(f.name));
    const [, why] = AREA_LABEL[n.area.area] ?? ["", ""];
    const selCount = selection.size;
    const dl = el("button", { class: "ghost tiny", text: selCount > 1 ? `\uB0B4\uB824\uBC1B\uAE30 (${selCount}, zip)` : "\uB0B4\uB824\uBC1B\uAE30", title: "\uB0B4 PC\uC5D0 \uC800\uC7A5\uD569\uB2C8\uB2E4. \uC5EC\uB7EC \uAC1C\uB098 \uD3F4\uB354\uB294 zip \uD558\uB098\uB85C \uBC1B\uC2B5\uB2C8\uB2E4." });
    dl.disabled = !selCount;
    dl.addEventListener("click", () => void downloadSelected(n));
    const mv = el("button", { class: "ghost tiny", text: "\uC774\uB3D9", title: "\uACE0\uB978 \uD56D\uBAA9\uC744 \uB2E4\uB978 \uD3F4\uB354\uB85C \uC62E\uAE41\uB2C8\uB2E4" });
    mv.disabled = !selCount || !deletable;
    mv.addEventListener("click", () => openMove(mv));
    const del = el("button", { class: "ghost tiny", text: selCount ? `\uC0AD\uC81C (${selCount})` : "\uC0AD\uC81C", title: "Delete \uD0A4\uB85C\uB3C4 \uB429\uB2C8\uB2E4" });
    del.disabled = !selCount || !deletable;
    del.addEventListener("click", () => requestDelete());
    const all = el("button", { class: "ghost tiny", text: "\uC804\uCCB4 \uC120\uD0DD", title: "Ctrl+A" });
    all.addEventListener("click", () => {
      selectAll(n);
      drawCentre();
    });
    const viewBtn = el("button", { class: "ghost tiny", text: view === "grid" ? "\uBAA9\uB85D \uBCF4\uAE30" : "\uBBF8\uB9AC\uBCF4\uAE30", title: "\uADF8\uB9BC\uC774 \uC788\uB294 \uD3F4\uB354\uB294 \uC378\uB124\uC77C\uB85C \uBCFC \uC218 \uC788\uC2B5\uB2C8\uB2E4" });
    viewBtn.addEventListener("click", () => {
      view = view === "grid" ? "list" : "grid";
      try {
        localStorage.setItem("hina.filesView", view);
      } catch {
      }
      drawCentre();
    });
    const zipAll = el("button", { class: "ghost tiny", text: "\uD3F4\uB354 zip", title: "\uC774 \uD3F4\uB354 \uC804\uCCB4\uB97C zip \uD558\uB098\uB85C \uBC1B\uC2B5\uB2C8\uB2E4" });
    zipAll.disabled = n.virtual === true || !n.files.length && !n.kids.length;
    zipAll.addEventListener("click", async () => {
      zipAll.disabled = true;
      try {
        const bytes = await state.downloadZip([n.path], n.name);
        notice2(`${fmtSize2(bytes)} zip \uC744 \uBE0C\uB77C\uC6B0\uC800 \uB2E4\uC6B4\uB85C\uB4DC\uB85C \uB118\uACBC\uC2B5\uB2C8\uB2E4.`, "ok");
      } catch (e) {
        notice2("\uBC1B\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg3(e), "err");
      } finally {
        zipAll.disabled = false;
      }
    });
    viewMount.appendChild(el("div", { class: "filebar" }, [
      el("span", { class: "filecrumb", text: n.virtual ? "\uC784\uC2DC \uBB38\uC11C" : n.path + "/" }),
      el("span", { class: "hint", text: `${n.files.length}\uAC1C` + (n.kids.length ? ` \xB7 \uD3F4\uB354 ${n.kids.length}` : "") }),
      el("span", { class: "spacer" }),
      hasImages ? viewBtn : null,
      all,
      dl,
      zipAll,
      mv,
      del
    ]));
    viewMount.appendChild(el("div", { class: "filehint", text: (n.virtual ? "scratch/\xB7scripts/ \uC5D0 AI\uAC00 \uB0A8\uAE34 \uBB38\uC11C\uC785\uB2C8\uB2E4. " : why + " ") + (writable ? "\uD30C\uC77C\uC774\uB098 \uD3F4\uB354\uB97C \uC5EC\uAE30\uC5D0 \uB04C\uC5B4\uB2E4 \uB193\uC73C\uBA74 \uC774 \uD3F4\uB354\uC5D0 \uC62C\uB77C\uAC11\uB2C8\uB2E4 (zip \uC740 \uD480\uC5B4\uC11C \uC62C\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4). " : "") + "\uD074\uB9AD\uC73C\uB85C \uC120\uD0DD, Ctrl\xB7Shift \uB85C \uC5EC\uB7EC \uAC1C, \uB354\uBE14\uD074\uB9AD\xB7Enter \uB85C \uC5F4\uAE30" + (deletable ? ", Delete \uB85C \uC0AD\uC81C." : ".") }));
    const barSlot = el("div", { class: "fileslot" });
    viewMount.appendChild(barSlot);
    if (confirmDelete && selCount && deletable) barSlot.appendChild(confirmBar(n));
    const list2 = el("div", { class: "filelist", tabindex: "0" });
    const entries = [
      ...n.kids.map((k) => ({ path: k.path, name: k.name, node: k })),
      ...n.files.map((f) => ({ path: f.path, name: f.name, file: f }))
    ];
    if (!entries.length) {
      list2.appendChild(el("div", { class: "fempty", text: writable ? "\uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uB04C\uC5B4\uB2E4 \uB193\uAC70\uB098 \uC67C\uCABD \u201C\uC62C\uB9AC\uAE30\u201D\uB97C \uB204\uB974\uC138\uC694." : "\uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." }));
    } else if (view === "grid" && hasImages) {
      const grid = el("div", { class: "fgrid" });
      for (const e of entries) grid.appendChild(gridCell(e, entries, n));
      list2.appendChild(grid);
    } else {
      list2.appendChild(el("div", { class: "frow head" }, [
        el("span"),
        el("span", { text: "\uC774\uB984" }),
        el("span", { class: "fsize", text: "\uD06C\uAE30" }),
        el("span", { class: "ftime", text: "\uC218\uC815" })
      ]));
      for (const e of entries) list2.appendChild(listRow(e, entries, n));
    }
    list2.addEventListener("keydown", (ev) => {
      const e = ev;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (confirmDelete) void runDelete(n);
        else requestDelete();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const first = [...selection][0];
        if (first) openEntry(first, n);
      } else if (e.key === "Escape") {
        selection.clear();
        confirmDelete = false;
        drawCentre();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll(n);
        drawCentre();
      }
    });
    viewMount.appendChild(list2);
  }
  function findFile(path) {
    for (const n of nodes.values()) {
      const f = n.files.find((x) => x.path === path);
      if (f) return f;
    }
    return void 0;
  }
  function selectAll(n) {
    selection = /* @__PURE__ */ new Set([...n.kids.map((k) => k.path), ...n.files.map((f) => f.path)]);
  }
  function pick(path, e, order) {
    if (e.shiftKey && anchorPath) {
      const a = order.findIndex((x) => x.path === anchorPath);
      const b = order.findIndex((x) => x.path === path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) selection.add(order[i].path);
      } else selection.add(path);
    } else if (e.ctrlKey || e.metaKey) {
      if (selection.has(path)) selection.delete(path);
      else selection.add(path);
      anchorPath = path;
    } else {
      selection = /* @__PURE__ */ new Set([path]);
      anchorPath = path;
    }
    confirmDelete = false;
  }
  function openEntry(path, n) {
    const kid = n.kids.find((k) => k.path === path);
    if (kid) {
      selectedDir = kid.path;
      expandTo(kid.path);
      selection.clear();
      drawTree();
      drawCentre();
      return;
    }
    previewPath = path;
    drawCentre();
  }
  function listRow(e, order, n) {
    const box = el("input", { type: "checkbox" });
    box.checked = selection.has(e.path);
    const row = el("div", { class: "frow" + (selection.has(e.path) ? " sel" : ""), title: e.path }, [
      box,
      // A folder glyph for folders; files carry their extension as a small tag
      // instead of a pictogram - the picture glyphs rendered as stray letters
      // on a machine without a colour emoji font.
      el("span", { class: "fname" }, [
        e.node ? el("span", { class: "ficon", text: "\u{1F4C1}" }) : el("span", { class: "ftag", text: extOf(e.name) }),
        el("span", { text: e.name })
      ]),
      el("span", { class: "fsize", text: e.file ? fmtSize2(e.file.size) : `${countFiles(e.node)}\uAC1C` }),
      el("span", { class: "ftime", text: e.file ? fmtWhen(e.file.modified) : "" })
    ]);
    box.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (box.checked) selection.add(e.path);
      else selection.delete(e.path);
      anchorPath = e.path;
      confirmDelete = false;
      drawCentre();
      focusList();
    });
    row.addEventListener("click", (ev) => {
      pick(e.path, ev, order);
      drawCentre();
      focusList();
    });
    row.addEventListener("dblclick", () => openEntry(e.path, n));
    return row;
  }
  function gridCell(e, order, n) {
    const pic = el("div", { class: "assetpic" });
    const cell2 = el("div", { class: "fcell" + (selection.has(e.path) ? " sel" : ""), title: e.path }, [
      pic,
      el("div", { class: "fname", text: e.name }),
      el("div", { class: "fsize", text: e.file ? fmtSize2(e.file.size) : `\uD3F4\uB354 \xB7 ${countFiles(e.node)}\uAC1C` })
    ]);
    if (e.node) pic.appendChild(el("div", { class: "assettype", text: "\u{1F4C1}" }));
    else if (e.file && IMAGE_RE.test(e.name)) void loadThumb(e.file, pic);
    else pic.appendChild(el("div", { class: "assettype", text: (e.name.split(".").pop() || "?").toUpperCase().slice(0, 5) }));
    cell2.addEventListener("click", (ev) => {
      pick(e.path, ev, order);
      drawCentre();
      focusList();
    });
    cell2.addEventListener("dblclick", () => openEntry(e.path, n));
    return cell2;
  }
  function focusList() {
    viewMount?.querySelector(".filelist")?.focus();
  }
  var THUMB_PARALLEL = 6;
  var thumbActive = 0;
  var thumbQueue = [];
  async function loadThumb(f, mount) {
    let url = thumbs.get(f.path + ":" + f.modified) || "";
    if (!url) {
      await new Promise((resolve) => {
        const go = () => {
          thumbActive += 1;
          resolve();
        };
        if (thumbActive < THUMB_PARALLEL) go();
        else thumbQueue.push(go);
      });
      try {
        if (!mount.isConnected) return;
        const bytes = await state.fileBytes(f.path);
        const buf = new Uint8Array(bytes.byteLength);
        buf.set(bytes);
        url = URL.createObjectURL(new Blob([buf]));
        if (thumbs.size > 400) {
          for (const [k, u] of thumbs) {
            URL.revokeObjectURL(u);
            thumbs.delete(k);
            break;
          }
        }
        thumbs.set(f.path + ":" + f.modified, url);
      } catch {
        mount.appendChild(el("div", { class: "assettype", text: "?" }));
        return;
      } finally {
        thumbActive -= 1;
        thumbQueue.shift()?.();
      }
    }
    if (!mount.isConnected) return;
    const img = el("img", { src: url, alt: f.name, loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(el("div", { class: "assettype", text: "IMG" })));
    mount.appendChild(img);
  }
  async function drawPreview(f, n) {
    if (!viewMount) return;
    clear(viewMount);
    const back = el("button", { class: "ghost tiny", text: "\u2039 \uBAA9\uB85D\uC73C\uB85C" });
    back.addEventListener("click", () => {
      previewPath = "";
      drawCentre();
      focusList();
    });
    const save = el("button", { class: "primary tiny", text: "\uB0B4 PC\uC5D0 \uC800\uC7A5" });
    const out = el("span", { class: "hint" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      out.textContent = "\uBC1B\uB294 \uC911\uC785\uB2C8\uB2E4\u2026";
      try {
        const bytes = await state.downloadFile(f.path);
        out.textContent = `${fmtSize2(bytes)} \uB97C \uBE0C\uB77C\uC6B0\uC800 \uB2E4\uC6B4\uB85C\uB4DC\uB85C \uB118\uACBC\uC2B5\uB2C8\uB2E4.`;
      } catch (e) {
        out.textContent = "\uBC1B\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg3(e);
      } finally {
        save.disabled = false;
      }
    });
    const head = el("div", { class: "filebar" }, [
      back,
      el("span", { class: "filecrumb", text: f.path }),
      el("span", { class: "hint", text: `${fmtSize2(f.size)} \xB7 ${fmtWhen(f.modified)} \xB7 ${AREA_LABEL[n.area.area]?.[0] ?? n.area.area}` }),
      el("span", { class: "spacer" }),
      save,
      out
    ]);
    viewMount.appendChild(head);
    const body = el("div", { class: "card fpreview" });
    viewMount.appendChild(body);
    if (IMAGE_RE.test(f.name)) {
      body.appendChild(el("div", { class: "hint", text: "\uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        const bytes = await state.fileBytes(f.path);
        const buf = new Uint8Array(bytes.byteLength);
        buf.set(bytes);
        const url = URL.createObjectURL(new Blob([buf]));
        clear(body);
        const img = el("img", { src: url, alt: f.name });
        img.addEventListener("error", () => {
          clear(body);
          body.appendChild(el("div", { class: "hint", text: "\uC774 \uD638\uC2A4\uD2B8\uC5D0\uC11C\uB294 \uADF8\uB9BC\uC744 \uD45C\uC2DC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB0B4 PC\uC5D0 \uC800\uC7A5\uD574\uC11C \uBCF4\uC138\uC694." }));
        });
        body.appendChild(img);
      } catch (e) {
        clear(body);
        body.appendChild(el("div", { class: "notice err", text: msg3(e) }));
      }
      return;
    }
    if (!f.textual) {
      body.appendChild(el("div", { class: "hint", text: "\uD14D\uC2A4\uD2B8 \uD30C\uC77C\uC774 \uC544\uB2C8\uB77C \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uAC74\uB108\uB701\uB2C8\uB2E4. \uC704 \u201C\uB0B4 PC\uC5D0 \uC800\uC7A5\u201D\uC73C\uB85C \uBC1B\uC73C\uC138\uC694." }));
      if (f.path.endsWith(".charx")) {
        body.appendChild(el("div", { class: "hint", style: { marginTop: "6px" }, text: "\uBC1B\uC740 charx \uB294 RisuAI \uC758 \uCE90\uB9AD\uD130 \uAC00\uC838\uC624\uAE30\uB85C \uB123\uC2B5\uB2C8\uB2E4. 300MB \uAC00 \uB118\uC73C\uBA74 \uBC31\uC5D4\uB4DC PC \uC758 out/ \uD3F4\uB354\uC5D0\uC11C \uC9C1\uC811 \uBCF5\uC0AC\uD558\uB294 \uD3B8\uC774 \uBE60\uB985\uB2C8\uB2E4." }));
      }
      return;
    }
    body.appendChild(el("div", { class: "hint", text: "\uC5EC\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
    try {
      const r = await state.readFile(f.path);
      clear(body);
      if (r.truncated) body.appendChild(el("div", { class: "hint", text: "\uC55E\uBD80\uBD84\uB9CC \uD45C\uC2DC\uD569\uB2C8\uB2E4." }));
      body.appendChild(el("pre", { class: "mono filepreview", text: r.content || r.note || "(\uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4)" }));
    } catch (e) {
      clear(body);
      body.appendChild(el("div", { class: "notice err", text: msg3(e) }));
    }
  }
  function requestDelete() {
    const n = nodes.get(selectedDir);
    if (!n || !selection.size) return;
    if (!n.area.deletable) {
      notice2(`${n.name} \uC548\uC758 \uD30C\uC77C\uC740 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`);
      return;
    }
    confirmDelete = true;
    drawCentre();
    focusList();
  }
  function confirmBar(n) {
    const yes = el("button", { class: "danger tiny", text: "\uC0AD\uC81C" });
    const no = el("button", { class: "ghost tiny", text: "\uCDE8\uC18C" });
    yes.addEventListener("click", () => void runDelete(n));
    no.addEventListener("click", () => {
      confirmDelete = false;
      drawCentre();
      focusList();
    });
    const names = [...selection].map((p) => p.slice(p.lastIndexOf("/") + 1));
    return el("div", { class: "confirmbar" }, [
      el("span", { text: `${selection.size}\uAC1C\uB97C \uC9C0\uC6B8\uAE4C\uC694? ` + names.slice(0, 3).join(", ") + (names.length > 3 ? " \u2026" : "") }),
      el("span", { class: "hint", text: "(Delete \uB97C \uD55C \uBC88 \uB354 \uB204\uB974\uBA74 \uC9C0\uC6C1\uB2C8\uB2E4)" }),
      el("span", { class: "spacer" }),
      yes,
      no
    ]);
  }
  async function runDelete(n) {
    const paths = [...selection];
    confirmDelete = false;
    if (!paths.length) return;
    let done = 0;
    try {
      for (const p of paths) {
        await state.deleteFile(p);
        done += 1;
        if (previewPath === p) previewPath = "";
      }
      notice2(`${done}\uAC1C\uB97C \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4.`, "ok");
    } catch (e) {
      notice2(`${done}\uAC1C\uB97C \uC9C0\uC6B4 \uB4A4 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: ` + msg3(e), "err");
    }
    selection.clear();
    state.touchFiles();
    seenFilesRev = state.filesRev;
    await refresh();
    focusList();
  }
  function openMove(anchor) {
    const paths = [...selection];
    if (!paths.length) return;
    const body = el("div", { class: "applypop" });
    const close = popover(anchor, body);
    body.appendChild(el("div", { class: "hint", text: `${paths.length}\uAC1C\uB97C \uC62E\uAE38 \uACF3:` }));
    for (const target of moveTargets()) {
      if (target === selectedDir) continue;
      const b = el("button", { class: "catrow", text: "\u{1F4C1} " + target });
      b.addEventListener("click", async () => {
        close();
        let done = 0;
        try {
          for (const p of paths) {
            await state.moveFile(p, target);
            done += 1;
          }
          notice2(`${done}\uAC1C\uB97C ${target}/ \uB85C \uC62E\uACBC\uC2B5\uB2C8\uB2E4.`, "ok");
        } catch (e) {
          notice2(`${done}\uAC1C\uB97C \uC62E\uAE34 \uB4A4 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: ` + msg3(e), "err");
        }
        selection.clear();
        previewPath = "";
        state.touchFiles();
        seenFilesRev = state.filesRev;
        await refresh();
      });
      body.appendChild(b);
    }
  }
  async function downloadSelected(n) {
    const paths = [...selection];
    if (!paths.length) return;
    const single = paths.length === 1 ? n.files.find((f) => f.path === paths[0]) : void 0;
    try {
      if (single) {
        const bytes2 = await state.downloadFile(single.path);
        notice2(`${single.name} \xB7 ${fmtSize2(bytes2)} \uB97C \uBE0C\uB77C\uC6B0\uC800 \uB2E4\uC6B4\uB85C\uB4DC\uB85C \uB118\uACBC\uC2B5\uB2C8\uB2E4.`, "ok");
        return;
      }
      const name = paths.length === 1 ? paths[0].slice(paths[0].lastIndexOf("/") + 1) : `${state.workspace?.characterName || "files"}-${n.name}`;
      notice2("zip \uC744 \uB9CC\uB4DC\uB294 \uC911\uC785\uB2C8\uB2E4\u2026");
      const bytes = await state.downloadZip(paths, name);
      notice2(`${paths.length}\uAC1C \xB7 ${fmtSize2(bytes)} zip \uC744 \uBE0C\uB77C\uC6B0\uC800 \uB2E4\uC6B4\uB85C\uB4DC\uB85C \uB118\uACBC\uC2B5\uB2C8\uB2E4.`, "ok");
    } catch (e) {
      notice2("\uBC1B\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg3(e), "err");
    }
  }
  function installDrop(target, into) {
    for (const kind of ["dragover", "dragenter"]) {
      target.addEventListener(kind, (e) => {
        const dt = e.dataTransfer;
        if (!dt || !Array.from(dt.types).includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        target.classList.add("dropping");
      });
    }
    target.addEventListener("dragleave", (e) => {
      if (!target.contains(e.relatedTarget)) target.classList.remove("dropping");
    });
    target.addEventListener("drop", async (e) => {
      const dt = e.dataTransfer;
      target.classList.remove("dropping");
      if (!dt) return;
      e.preventDefault();
      e.stopPropagation();
      const files = await collectDrop(dt);
      if (files.length) void uploadMany(files, into());
    });
  }
  async function collectDrop(dt) {
    const out = [];
    const items5 = Array.from(dt.items ?? []);
    const entries = items5.map((it) => it.webkitGetAsEntry?.() ?? null).filter((x) => !!x);
    if (!entries.length) {
      for (const file of Array.from(dt.files)) out.push({ file, rel: "" });
      return out;
    }
    const walk = async (entry, rel) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, rel });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const sub = rel ? rel + "/" + entry.name : entry.name;
        for (; ; ) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, sub);
        }
      }
    };
    for (const entry of entries) await walk(entry, "");
    return out;
  }
  async function uploadMany(files, into) {
    if (!viewMount) return;
    const zips = files.filter((f) => /\.zip$/i.test(f.file.name));
    const plain = files.filter((f) => !/\.zip$/i.test(f.file.name));
    let extractZips = zips.length ? null : false;
    if (zips.length) {
      extractZips = await new Promise((resolve) => {
        const ask = el("div", { class: "zipask" });
        const unpack = el("button", { class: "primary tiny", text: "\uD480\uC5B4\uC11C \uC62C\uB9AC\uAE30" });
        const keep = el("button", { class: "ghost tiny", text: "zip \uADF8\uB300\uB85C \uC62C\uB9AC\uAE30" });
        const cancel = el("button", { class: "ghost tiny", text: "\uCDE8\uC18C" });
        unpack.addEventListener("click", () => {
          ask.remove();
          resolve(true);
        });
        keep.addEventListener("click", () => {
          ask.remove();
          resolve(false);
        });
        cancel.addEventListener("click", () => {
          ask.remove();
          resolve(null);
        });
        ask.append(
          el("span", { text: `zip ${zips.length}\uAC1C (${zips.map((z) => z.file.name).slice(0, 3).join(", ")}${zips.length > 3 ? " \u2026" : ""}) \u2014` }),
          unpack,
          keep,
          cancel
        );
        (viewMount?.querySelector(".fileslot") ?? viewMount)?.prepend(ask);
      });
      if (extractZips === null && !plain.length) return;
    }
    const todo = extractZips === null ? plain : [...plain, ...zips];
    const prog = el("div", { class: "uploadprog" });
    (viewMount.querySelector(".fileslot") ?? viewMount).prepend(prog);
    let done = 0;
    let failed = 0;
    let extracted = 0;
    const t0 = Date.now();
    const BATCH = 16 * 1024 * 1024;
    const SOLO = 60 * 1024 * 1024;
    const batches = [];
    let cur = [];
    let curSize = 0;
    for (const item of todo) {
      if (item.file.size > SOLO) {
        failed += 1;
        notice2(`${item.file.name}: 60MB \uB97C \uB118\uB294 \uD30C\uC77C\uC740 \uC62C\uB9B4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`, "err");
        continue;
      }
      if (cur.length && curSize + item.file.size > BATCH) {
        batches.push(cur);
        cur = [];
        curSize = 0;
      }
      cur.push(item);
      curSize += item.file.size;
    }
    if (cur.length) batches.push(cur);
    const sendBatch = async (batch) => {
      try {
        const entries = await Promise.all(batch.map(async ({ file, rel }) => ({
          name: file.name,
          rel,
          bytes: new Uint8Array(await file.arrayBuffer())
        })));
        const r = await state.uploadBatch(into, entries, !!extractZips);
        done += r.count;
        extracted += r.extracted;
      } catch (e) {
        for (const { file, rel } of batch) {
          try {
            const r = await uploadOne(file, rel ? into + "/" + rel : into, !!extractZips && /\.zip$/i.test(file.name));
            done += 1;
            if (r.extracted) extracted += r.extracted;
          } catch (e2) {
            failed += 1;
            notice2(`${file.name}: ` + msg3(e2), "err");
          }
        }
      }
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1e3));
      prog.textContent = `\uC62C\uB9AC\uB294 \uC911 ${done + failed}/${todo.length} (${secs}\uCD08)`;
    };
    prog.textContent = `\uC62C\uB9AC\uB294 \uC911 0/${todo.length}`;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) await sendBatch(batches[next++]);
    };
    await Promise.all([worker(), worker()]);
    prog.remove();
    notice2(`${done}\uAC1C\uB97C ${into}/ \uC5D0 \uC62C\uB838\uC2B5\uB2C8\uB2E4.` + (extracted ? ` (zip \uC5D0\uC11C ${extracted}\uAC1C \uD480\uB9BC)` : "") + (failed ? ` \uC2E4\uD328 ${failed}\uAC1C.` : ""), failed ? "err" : "ok");
    if (nodes.has(into)) {
      selectedDir = into;
      expandTo(into);
    }
    state.touchFiles();
    seenFilesRev = state.filesRev;
    await refresh();
  }
  async function uploadOne(file, dir, extract) {
    if (TEXT_UPLOAD_RE.test(file.name)) {
      return await state.uploadFile(file.name, await file.text(), false, dir);
    }
    const b64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
      fr.onerror = () => reject(fr.error ?? new Error("read failed"));
      fr.readAsDataURL(file);
    });
    return await state.uploadFile(file.name, b64, true, dir, extract);
  }
  function extOf(name) {
    const i = name.lastIndexOf(".");
    if (i <= 0 || i === name.length - 1) return "\u2014";
    return name.slice(i + 1).toLowerCase().slice(0, 5);
  }
  function fmtSize2(n) {
    if (!n) return "0B";
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }
  function fmtWhen(sec) {
    const n = Number(sec) * 1e3;
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch {
      return "";
    }
  }
  function msg3(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/lore-view.ts
  function makeLoreTab(opts) {
    let built8 = false;
    let treeMount5 = null;
    let viewMount6 = null;
    let noticeMount10 = null;
    let openId4 = "";
    let entries = [];
    let seenEpoch7 = -1;
    let seenKey5 = "";
    const openFolders = /* @__PURE__ */ new Set();
    let filterText5 = "";
    function render(mount) {
      const key = opts.scope === "global" ? state.botKey : state.activeCharKey;
      if (!key) {
        clear(mount);
        built8 = false;
        mount.appendChild(el("div", { class: "pad" }, [
          el("div", { class: "empty", text: "\uBA3C\uC800 \u201C\uCC57 \uC120\uD0DD\u201D \uD0ED\uC5D0\uC11C \uCC57\uC744 \uACE8\uB77C \uC8FC\uC138\uC694." })
        ]));
        return;
      }
      if (!built8 || !mount.querySelector(".split")) {
        clear(mount);
        const pane = threePane();
        treeMount5 = el("div", { class: "tree" });
        pane.left.appendChild(treeMount5);
        noticeMount10 = el("div");
        viewMount6 = el("div", { class: "pad" });
        pane.centre.appendChild(noticeMount10);
        pane.centre.appendChild(viewMount6);
        mount.appendChild(pane.root);
        built8 = true;
        seenEpoch7 = state.epoch;
        seenKey5 = key;
        void refresh8();
      } else if (seenEpoch7 !== state.epoch || seenKey5 !== key) {
        seenEpoch7 = state.epoch;
        seenKey5 = key;
        openId4 = "";
        if (viewMount6) clear(viewMount6);
        void refresh8();
      }
      bindAgent({ notice: notice9 });
      const inner = mount.querySelector(".right-inner");
      if (inner) mountAgent(inner);
    }
    function notice9(text2, kind = "") {
      if (!noticeMount10) return;
      clear(noticeMount10);
      noticeMount10.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
      setTimeout(() => {
        if (noticeMount10) clear(noticeMount10);
      }, 9e3);
    }
    async function refresh8() {
      if (!treeMount5) return;
      clear(treeMount5);
      treeMount5.appendChild(el("div", { class: "hint", style: { padding: "8px" }, text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        entries = await state.lore(opts.scope);
        if (opts.scope === "local") {
          entries = entries.filter((e) => e.chatKey === state.activeChatKey);
        }
        drawTree5();
      } catch (e) {
        clear(treeMount5);
        treeMount5.appendChild(el("div", { class: "notice err", text: msg4(e) }));
      }
    }
    function drawTree5() {
      if (!treeMount5) return;
      clear(treeMount5);
      const add = el("button", { class: "primary tiny", text: "\uC0C8 \uD56D\uBAA9" });
      add.addEventListener("click", () => void create2());
      const reloadBtn = el("button", { class: "ghost tiny", text: "\uC0C8\uB85C\uACE0\uCE68" });
      reloadBtn.addEventListener("click", () => void refresh8());
      treeMount5.appendChild(el("div", { class: "treehead" }, [add, reloadBtn]));
      if (!entries.length) {
        for (const line of opts.emptyLines) {
          treeMount5.appendChild(el("div", { class: "hint", style: { padding: "4px 8px" }, text: line }));
        }
        return;
      }
      setToolbarSearch(filterText5, (v) => {
        filterText5 = v;
        drawTree5();
        refocusSearch(null);
      }, "\uCC3E\uAE30 (\uC774\uB984\xB7\uB0B4\uC6A9)");
      const needle = filterText5.trim().toLowerCase();
      const hit = (e) => {
        if (!needle) return true;
        const entry = e.entry;
        return [entry.comment, entry.key, entry.content].some((v) => String(v ?? "").toLowerCase().includes(needle));
      };
      const names = folderNames(entries);
      const items5 = entries.filter((e) => !isFolder(e));
      const shown = items5.filter(hit);
      treeMount5.appendChild(el("div", {
        class: "treescope",
        text: `${opts.scopeLabel} \xB7 ${needle ? `${shown.length}/${items5.length}` : items5.length}`
      }));
      const byFolder = /* @__PURE__ */ new Map();
      for (const e of shown) {
        const f = folderOf(e);
        if (!byFolder.has(f)) byFolder.set(f, []);
        byFolder.get(f).push(e);
      }
      const named = [...byFolder.keys()].filter(Boolean);
      for (const [folder, group] of byFolder) {
        if (folder && named.length) {
          const label = names.get(folder) || shortId(folder);
          const isOpen = !!needle || openFolders.has(folder);
          const caret = el("span", { text: isOpen ? "\u25BE" : "\u25B8" });
          const head = el("button", { class: "treebranch", title: folder }, [
            caret,
            el("span", { class: "grow", text: label }),
            el("span", { class: "hint", text: String(group.length) })
          ]);
          const kids = el("div", { class: "treekids" }, group.map((e) => entryRow(e, items5)));
          kids.style.display = isOpen ? "block" : "none";
          head.addEventListener("click", () => {
            if (openFolders.has(folder)) openFolders.delete(folder);
            else openFolders.add(folder);
            const now = openFolders.has(folder);
            kids.style.display = now ? "block" : "none";
            caret.textContent = now ? "\u25BE" : "\u25B8";
          });
          treeMount5.appendChild(el("div", {}, [head, kids]));
        } else {
          for (const e of group) treeMount5.appendChild(entryRow(e, items5));
        }
      }
    }
    function entryRow(e, all) {
      const name = el("button", {
        class: "treefile" + (e.id === openId4 ? " on" : ""),
        text: titleOf(e),
        title: e.id
      });
      name.addEventListener("click", () => open4(e));
      const siblings = all.filter((x) => folderOf(x) === folderOf(e));
      const at = siblings.findIndex((x) => x.id === e.id);
      const moveTo = async (neighbor) => {
        try {
          await state.moveLore(e.id, all.findIndex((x) => x.id === neighbor.id));
          await refresh8();
        } catch (err) {
          notice9("\uC21C\uC11C\uB97C \uBC14\uAFB8\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg4(err), "err");
        }
      };
      const up = el("button", { class: "ghost tiny movebtn", text: "\u2191", title: "\uC704\uB85C" });
      const down = el("button", { class: "ghost tiny movebtn", text: "\u2193", title: "\uC544\uB798\uB85C" });
      up.disabled = at <= 0;
      down.disabled = at < 0 || at >= siblings.length - 1;
      up.addEventListener("click", () => void moveTo(siblings[at - 1]));
      down.addEventListener("click", () => void moveTo(siblings[at + 1]));
      const row = el("div", { class: "treerow lorecard" }, [name]);
      const io = Number(e.entry.insertorder ?? 100);
      row.appendChild(el("span", { class: "hint ordertag", title: "\uC6B0\uC120\uC21C\uC704 (insertorder)", text: String(io) }));
      if (e.entry.alwaysActive) {
        row.appendChild(el("span", { class: "badge", title: "\uC0C1\uC2DC \uD65C\uC131\uD654 \u2014 \uD0A4\uC6CC\uB4DC \uC5C6\uC774 \uD56D\uC0C1 \uC0BD\uC785\uB429\uB2C8\uB2E4", text: "\uC0C1\uC2DC" }));
      }
      if (e.conflict) {
        row.appendChild(conflictBadge());
      } else if (e.origin !== "original") {
        row.appendChild(el("span", { class: "badge warn", text: e.origin === "added" ? "\uCD94\uAC00" : "\uC218\uC815" }));
      }
      row.appendChild(up);
      row.appendChild(down);
      return row;
    }
    function open4(e) {
      if (!viewMount6) return;
      openId4 = e.id;
      for (const b of Array.from(document.querySelectorAll(".tree .treefile"))) {
        b.classList.toggle("on", b.title === e.id);
      }
      const entry = e.entry;
      const keys = el("input", { value: String(entry.key ?? entry.keys ?? "") });
      const comment = el("input", { value: String(entry.comment ?? entry.name ?? "") });
      const always = el("input", { type: "checkbox" });
      always.checked = !!entry.alwaysActive;
      const keyHint = el("span", { class: "hint", text: "\uC27C\uD45C\uB85C \uAD6C\uBD84\uD569\uB2C8\uB2E4. \uB300\uD654\uC5D0 \uC774 \uB9D0\uC774 \uB098\uC624\uBA74 \uD56D\uBAA9\uC774 \uC0BD\uC785\uB429\uB2C8\uB2E4." });
      const syncAlways = () => {
        keys.disabled = always.checked;
        if (always.checked) keys.value = "";
        keyHint.textContent = always.checked ? "\uC0C1\uC2DC \uD65C\uC131\uD654 \uD56D\uBAA9\uC740 \uD0A4\uC6CC\uB4DC \uC5C6\uC774 \uD56D\uC0C1 \uC0BD\uC785\uB429\uB2C8\uB2E4 (\uD0A4\uC6CC\uB4DC\uB294 \uBE44\uC6C1\uB2C8\uB2E4)." : "\uC27C\uD45C\uB85C \uAD6C\uBD84\uD569\uB2C8\uB2E4. \uB300\uD654\uC5D0 \uC774 \uB9D0\uC774 \uB098\uC624\uBA74 \uD56D\uBAA9\uC774 \uC0BD\uC785\uB429\uB2C8\uB2E4.";
      };
      always.addEventListener("change", syncAlways);
      syncAlways();
      const content = el("textarea", {
        value: String(entry.content ?? ""),
        style: { minHeight: "300px" }
      });
      const order = el("input", {
        type: "number",
        step: "10",
        value: String(Number(entry.insertorder ?? 100)),
        title: "\uD074\uC218\uB85D \uC608\uC0B0\uC5D0\uC11C \uBA3C\uC800 \uC0B4\uC544\uB0A8\uACE0 \uD504\uB86C\uD504\uD2B8\uC5D0 \uBA3C\uC800 \uB193\uC785\uB2C8\uB2E4. \uC8FC\uC5F0 1000 \xB7 \uC870\uC5F0 800~900 \xB7 \uC138\uACC4\uAD00 700 \xB7 \uC7A5\uC18C 600 \xB7 \uBAAC\uC2A4\uD130 500 \xB7 \uC5D1\uC2A4\uD2B8\uB77C 300 \xB7 \uC0C1\uC2DC \uC815\uBCF8 2000"
      });
      const names = folderNames(entries);
      const curFolder = folderOf(e);
      const folderKeys = [...names.keys()];
      if (curFolder && !folderKeys.includes(curFolder)) folderKeys.push(curFolder);
      const folderSel = el("select", {}, [
        (() => {
          const o = el("option", { value: "", text: "(\uD3F4\uB354 \uC5C6\uC74C)" });
          if (!curFolder) o.setAttribute("selected", "");
          return o;
        })(),
        ...folderKeys.map((k) => {
          const o = el("option", { value: k, text: names.get(k) || shortId(k) });
          if (k === curFolder) o.setAttribute("selected", "");
          return o;
        })
      ]);
      const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const next = {
            ...entry,
            key: always.checked ? "" : keys.value,
            alwaysActive: always.checked,
            comment: comment.value,
            content: content.value,
            insertorder: Number.isFinite(Number(order.value)) ? Math.trunc(Number(order.value)) : 100
          };
          if (folderSel.value) next.folder = folderSel.value;
          else delete next.folder;
          await state.saveLore(e.id, next);
          if (opts.scope === "global") void state.refreshBotChanges();
          notice9(opts.savedNotice, "ok");
          await refresh8();
          const fresh = entries.find((x) => x.id === e.id);
          if (fresh) open4(fresh);
        } catch (err) {
          notice9("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg4(err), "err");
        } finally {
          save.disabled = false;
        }
      });
      const del = el("button", { class: "ghost" });
      armed(del, "\uC0AD\uC81C", "\uC815\uB9D0 \uC9C0\uC6B8\uAE4C\uC694?", async () => {
        try {
          await state.deleteLore(e.id);
          if (opts.scope === "global") void state.refreshBotChanges();
          openId4 = "";
          if (viewMount6) clear(viewMount6);
          await refresh8();
        } catch (err) {
          notice9("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg4(err), "err");
        }
      });
      const orig = e.origin === "edited" && e.original ? e.original : null;
      const diff = orig ? diffCard(String(orig.content ?? ""), String(entry.content ?? "")) : null;
      const metaChanged = [];
      if (orig) {
        if (String(orig.comment ?? "") !== String(entry.comment ?? "")) metaChanged.push(`\uC774\uB984: \u201C${String(orig.comment ?? "")}\u201D \u2192 \u201C${String(entry.comment ?? "")}\u201D`);
        if (String(orig.key ?? "") !== String(entry.key ?? "")) metaChanged.push(`\uD0A4\uC6CC\uB4DC: \u201C${String(orig.key ?? "")}\u201D \u2192 \u201C${String(entry.key ?? "")}\u201D`);
        if (!!orig.alwaysActive !== !!entry.alwaysActive) metaChanged.push(`\uC0C1\uC2DC \uD65C\uC131\uD654: ${orig.alwaysActive ? "\uCF2C" : "\uB054"} \u2192 ${entry.alwaysActive ? "\uCF2C" : "\uB054"}`);
      }
      const conflict = e.conflict ? conflictBox({
        kind: "lore",
        id: e.id,
        label: titleOf(e),
        charKey: null,
        chatKey: e.chatKey ?? null,
        reason: String(e.conflict.kind ?? ""),
        tier: "",
        mine: e.entry,
        theirs: e.conflict.theirs ?? null,
        base: e.conflict.base ?? null,
        canTakeTheirs: true
      }, () => {
        void refresh8();
      }) : null;
      clear(viewMount6);
      viewMount6.appendChild(el("div", { class: "card" }, [
        el("h2", {}, [el("span", { text: opts.heading }), el("span", { class: "spacer" }), focusButton(content, titleOf(e))]),
        conflict,
        el("label", { class: "field" }, [el("span", { text: "\uC774\uB984 (comment)" }), comment]),
        el("label", { class: "checkrow", style: { marginBottom: "8px" } }, [
          always,
          el("span", { text: "\uC0C1\uC2DC \uD65C\uC131\uD654 (alwaysActive) \u2014 \uD0A4\uC6CC\uB4DC \uC5C6\uC774 \uD56D\uC0C1 \uC0BD\uC785" })
        ]),
        el("label", { class: "field" }, [
          el("span", { text: "\uD0A4\uC6CC\uB4DC (key)" }),
          keys,
          keyHint
        ]),
        el("div", { class: "row", style: { marginBottom: "10px" } }, [
          el("label", { class: "field grow", style: { marginBottom: "0" } }, [el("span", { text: "\uD3F4\uB354" }), folderSel]),
          el("label", { class: "field", style: { marginBottom: "0", width: "150px" } }, [el("span", { text: "\uC6B0\uC120\uC21C\uC704 (insertorder)" }), order])
        ]),
        el("label", { class: "field" }, [el("span", { text: "\uB0B4\uC6A9" }), content]),
        metaChanged.length ? el("div", { class: "hint diffmeta", text: "\uAE30\uC900\uC120\uACFC \uB2E4\uB978 \uD56D\uBAA9 \u2014 " + metaChanged.join(" \xB7 ") }) : null,
        diff,
        el("div", { class: "row" }, [save, del])
      ]));
    }
    async function create2() {
      try {
        const id = await state.addLore(
          { key: "", comment: "\uC0C8 \uD56D\uBAA9", content: "", alwaysActive: false, insertorder: 100 },
          opts.scope
        );
        if (opts.scope === "global") void state.refreshBotChanges();
        await refresh8();
        const made = entries.find((e) => e.id === id);
        if (made) open4(made);
      } catch (e) {
        notice9("\uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg4(e), "err");
      }
    }
    return render;
  }
  function titleOf(e) {
    const entry = e.entry;
    const raw = String(entry.comment || entry.name || entry.key || entry.keys || "").trim();
    return raw ? raw.slice(0, 60) : "(\uC774\uB984 \uC5C6\uC74C)";
  }
  function folderOf(e) {
    const entry = e.entry;
    return String(entry.folder || entry.folderId || "").trim();
  }
  function isFolder(e) {
    return String(e.entry.mode || "") === "folder";
  }
  function folderNames(all) {
    const names = /* @__PURE__ */ new Map();
    for (const e of all) {
      if (!isFolder(e)) continue;
      const entry = e.entry;
      const key = String(entry.key ?? "").trim();
      if (key) names.set(key, String(entry.comment || "").trim() || "\uC774\uB984 \uC5C6\uB294 \uD3F4\uB354");
    }
    return names;
  }
  function shortId(id) {
    return id.length > 10 ? `\uD3F4\uB354 ${id.slice(0, 6)}\u2026` : `\uD3F4\uB354 ${id}`;
  }
  function msg4(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/tab-lore.ts
  var renderLoreTab = makeLoreTab({
    scope: "local",
    scopeLabel: "\uC774 \uCC57",
    heading: "\uC774 \uCC57\uC758 \uB85C\uC5B4\uBD81 \uD56D\uBAA9",
    emptyLines: [
      "\uC774 \uCC57\uC758 \uB85C\uC5B4\uBD81 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uB300\uBD80\uBD84\uC758 \uCC57\uC740 \uBE44\uC5B4 \uC788\uB294 \uAC83\uC774 \uC815\uC0C1\uC785\uB2C8\uB2E4.",
      "\uBD07 \uC804\uCCB4 \uB85C\uC5B4\uBD81\uC740 \u201C\uBD07 \uB85C\uC5B4\uBD81\u201D \uD0ED\uC5D0\uC11C \uB2E4\uB8F9\uB2C8\uB2E4."
    ],
    savedNotice: "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uC704 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 \uD134\xB7\uC7A5\uAE30\uAE30\uC5B5\uACFC \uD568\uAED8 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4."
  });

  // src/ui/tab-memory.ts
  var KIND_LABEL = {
    hypaV3Data: "HypaV3",
    hypaV2Data: "HypaV2",
    supaMemoryData: "SupaMemory",
    supaMemory: "SupaMemory",
    lastMemory: "\uCD5C\uADFC \uC694\uC57D"
  };
  var built2 = false;
  var treeMount2 = null;
  var viewMount2 = null;
  var noticeMount3 = null;
  var toolbar = null;
  var countEl2 = null;
  var openId = "";
  var items = [];
  var seenEpoch = -1;
  function renderMemoryTab(mount) {
    if (!state.activeChatKey) {
      clear(mount);
      built2 = false;
      setToolbar(null);
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \u201C\uCC57 \uC120\uD0DD\u201D \uD0ED\uC5D0\uC11C \uCC57\uC744 \uACE8\uB77C \uC8FC\uC138\uC694." })
      ]));
      return;
    }
    if (!built2 || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      treeMount2 = el("div", { class: "tree" });
      pane.left.appendChild(treeMount2);
      noticeMount3 = el("div");
      viewMount2 = el("div", { class: "pad" });
      pane.centre.appendChild(noticeMount3);
      pane.centre.appendChild(viewMount2);
      mount.appendChild(pane.root);
      buildToolbar2();
      built2 = true;
      seenEpoch = state.epoch;
      void refresh2();
    } else if (seenEpoch !== state.epoch) {
      seenEpoch = state.epoch;
      void refresh2();
    }
    if (toolbar) setToolbar(toolbar);
    bindAgent({ notice: notice3 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function buildToolbar2() {
    countEl2 = el("span", { class: "dim" });
    const reloadBtn = el("button", { class: "tool", title: "\uBC31\uC5D4\uB4DC\uC5D0\uC11C \uB2E4\uC2DC \uC77D\uC5B4 \uC635\uB2C8\uB2E4" }, [
      el("span", { class: "glyph", text: "\u21BB" }),
      el("span", { class: "tool-label", text: "\uC0C8\uB85C\uACE0\uCE68" })
    ]);
    reloadBtn.addEventListener("click", () => void refresh2());
    toolbar = el("div", { class: "toolrow" }, [
      reloadBtn,
      el("span", { class: "spacer" }),
      countEl2
    ]);
  }
  function notice3(text2, kind = "") {
    if (!noticeMount3) return;
    clear(noticeMount3);
    noticeMount3.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount3) clear(noticeMount3);
    }, 9e3);
  }
  async function refresh2() {
    if (!treeMount2) return;
    clear(treeMount2);
    treeMount2.appendChild(el("div", { class: "hint", style: { padding: "8px" }, text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
    try {
      const r = await state.memory();
      items = r.items.filter((i) => i.kind !== "scriptstate");
      drawTree2(items.filter((i) => i.changed || i.isNew).length);
    } catch (e) {
      clear(treeMount2);
      treeMount2.appendChild(el("div", { class: "notice err", text: msg5(e) }));
    }
  }
  function drawTree2(changed) {
    if (!treeMount2) return;
    clear(treeMount2);
    if (countEl2) {
      countEl2.textContent = items.length ? `${items.length}\uAC1C${changed ? ` \xB7 \uC218\uC815 ${changed}` : ""}` : "\uC5C6\uC74C";
    }
    const add = el("button", { class: "primary tiny", text: "\uC0C8 \uD56D\uBAA9" });
    add.addEventListener("click", () => void create());
    const reloadBtn = el("button", { class: "ghost tiny", text: "\uC0C8\uB85C\uACE0\uCE68" });
    reloadBtn.addEventListener("click", () => void refresh2());
    treeMount2.appendChild(el("div", { class: "treehead" }, [add, reloadBtn]));
    if (!items.length) {
      treeMount2.appendChild(el("div", {
        class: "hint",
        style: { padding: "8px" },
        text: "\uC774 \uCC57\uC5D0\uB294 \uC7A5\uAE30\uAE30\uC5B5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. RisuAI\uC5D0\uC11C \uD558\uC774\uD30C\uB098 \uC218\uD30C \uBA54\uBAA8\uB9AC\uB97C \uCF1C\uC57C \uC0DD\uAE41\uB2C8\uB2E4."
      }));
      return;
    }
    const kinds = [...new Set(items.map((i) => i.kind))];
    for (const kind of kinds) {
      const group = items.filter((i) => i.kind === kind);
      treeMount2.appendChild(el("div", {
        class: "treescope",
        text: `${KIND_LABEL[kind] ?? kind} \xB7 ${group.length}`
      }));
      for (const item of group) treeMount2.appendChild(itemRow(item));
    }
  }
  function itemRow(item) {
    const name = el("button", {
      class: "treefile" + (item.id === openId ? " on" : ""),
      text: `${item.seq}. ${item.title}`,
      title: item.id
    });
    name.addEventListener("click", () => open(item));
    const row = el("div", { class: "treerow" }, [name]);
    if (item.isNew) row.appendChild(el("span", { class: "badge ok", text: "\uCD94\uAC00" }));
    else if (item.changed) row.appendChild(el("span", { class: "badge warn", text: "\uC218\uC815" }));
    return row;
  }
  function open(item) {
    if (!viewMount2) return;
    openId = item.id;
    for (const b of Array.from(document.querySelectorAll(".tree .treefile"))) {
      b.classList.toggle("on", b.title === item.id);
    }
    const body = el("textarea", { value: item.body, style: { minHeight: "300px" } });
    const count = el("div", { class: "hint" });
    const sync = () => {
      count.textContent = `${body.value.length}\uC790`;
    };
    body.addEventListener("input", sync);
    sync();
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await state.saveMemory(item.id, body.value);
        notice3("\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uC704 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 \uD134\xB7\uB85C\uC5B4\uBD81\uACFC \uD568\uAED8 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.", "ok");
        await refresh2();
        const fresh = items.find((i) => i.id === item.id);
        if (fresh) open(fresh);
      } catch (e) {
        notice3("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg5(e), "err");
      } finally {
        save.disabled = false;
      }
    });
    const revert = el("button", { class: "ghost", text: "\uC6D0\uB798\uB300\uB85C" });
    revert.disabled = item.original === null;
    revert.addEventListener("click", () => {
      body.value = item.original ?? "";
      sync();
    });
    const del = el("button", { class: "ghost" });
    armed(del, "\uC0AD\uC81C", "\uC815\uB9D0 \uC9C0\uC6B8\uAE4C\uC694?", async () => {
      try {
        await state.deleteMemory(item.id);
        openId = "";
        if (viewMount2) clear(viewMount2);
        await refresh2();
      } catch (e) {
        notice3("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg5(e), "err");
      }
    });
    clear(viewMount2);
    viewMount2.appendChild(el("div", { class: "card" }, [
      el("h2", {}, [
        el("span", { text: `${KIND_LABEL[item.kind] ?? item.kind} \xB7 ${item.seq}\uBC88 \uD56D\uBAA9` }),
        el("span", { class: "spacer" }),
        focusButton(body, `${KIND_LABEL[item.kind] ?? item.kind} \xB7 ${item.seq}\uBC88 \uD56D\uBAA9`)
      ]),
      el("div", { class: "hint", style: { marginBottom: "8px" } }, [
        "\uC774 \uC694\uC57D\uC774 \uBAA8\uB378\uC774 \uC2E4\uC81C\uB85C \uC77D\uB294 \u201C\uC61B\uB0A0 \uC77C\u201D\uC785\uB2C8\uB2E4. \uC5EC\uAE30 \uD2C0\uB9B0 \uC0AC\uC2E4\uC774 \uC788\uC73C\uBA74 \uC774\uD6C4 \uB2F5\uBCC0\uC774 \uACC4\uC18D \uADF8 \uC704\uC5D0 \uC313\uC785\uB2C8\uB2E4."
      ]),
      body,
      count,
      el("div", { class: "row", style: { marginTop: "8px" } }, [save, revert, del])
    ]));
    if (item.changed && item.original !== null) {
      viewMount2.appendChild(el("div", { class: "card" }, [
        el("h2", { text: "\uC6D0\uBCF8\uACFC\uC758 \uCC28\uC774" }),
        diffCard(item.original, item.body, { open: true })
      ]));
    }
  }
  async function create() {
    const kind = items[0]?.kind || "hypaV3Data";
    try {
      const made = await state.addMemory(kind, "");
      await refresh2();
      open(made);
    } catch (e) {
      notice3("\uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg5(e), "err");
    }
  }
  function msg5(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/tab-vars.ts
  var KIND2 = "scriptstate";
  var built3 = false;
  var listMount = null;
  var noticeMount4 = null;
  var seenEpoch2 = -1;
  var items2 = [];
  function renderVarsTab(mount) {
    if (!state.activeChatKey) {
      clear(mount);
      built3 = false;
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \u201C\uCC57 \uC120\uD0DD\u201D \uD0ED\uC5D0\uC11C \uCC57\uC744 \uACE8\uB77C \uC8FC\uC138\uC694." })
      ]));
      return;
    }
    if (!built3 || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      pane.left.style.display = "none";
      noticeMount4 = el("div");
      listMount = el("div", { class: "pad" });
      pane.centre.appendChild(noticeMount4);
      pane.centre.appendChild(listMount);
      mount.appendChild(pane.root);
      built3 = true;
      seenEpoch2 = state.epoch;
      void refresh3();
    } else if (seenEpoch2 !== state.epoch) {
      seenEpoch2 = state.epoch;
      void refresh3();
    }
    bindAgent({ notice: notice4 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function notice4(text2, kind = "") {
    if (!noticeMount4) return;
    clear(noticeMount4);
    noticeMount4.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount4) clear(noticeMount4);
    }, 9e3);
  }
  async function refresh3() {
    if (!listMount) return;
    clear(listMount);
    listMount.appendChild(el("div", { class: "hint", text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
    try {
      const r = await state.memory();
      items2 = r.items.filter((i) => i.kind === KIND2);
      draw();
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el("div", { class: "notice err", text: msg6(e) }));
    }
  }
  function draw() {
    if (!listMount) return;
    clear(listMount);
    const changed = items2.filter((i) => i.changed || i.isNew).length;
    const head = el("h2", {}, [
      el("span", { text: "\uCC57 \uBCC0\uC218" }),
      el("span", {
        class: "hint",
        style: { marginLeft: "8px" },
        text: items2.length ? `${items2.length}\uAC1C${changed ? ` \xB7 \uC218\uC815 ${changed}` : ""}` : "\uC5C6\uC74C"
      })
    ]);
    const reloadBtn = el("button", { class: "ghost tiny", text: "\uC0C8\uB85C\uACE0\uCE68" });
    reloadBtn.addEventListener("click", () => void refresh3());
    const card = el("div", { class: "card" }, [
      el("div", { class: "row" }, [head, el("span", { class: "spacer" }), reloadBtn]),
      el("div", {
        class: "hint",
        style: { marginBottom: "8px" },
        text: "`$`\uB85C \uC2DC\uC791\uD558\uB294 \uD0A4\uAC00 {{getvar}}\uAC00 \uC77D\uB294 \uBCC0\uC218\uC785\uB2C8\uB2E4. \uB098\uBA38\uC9C0\uB294 \uD2B8\uB9AC\uAC70\xB7Lua\uAC00 \uC4F4 \uAC12\uC785\uB2C8\uB2E4. \uC800\uC7A5\uD55C \uAC12\uC740 \uC704 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 \uD134\xB7\uB85C\uC5B4\uBD81\xB7\uC7A5\uAE30\uAE30\uC5B5\uACFC \uD568\uAED8 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4."
      })
    ]);
    if (!items2.length) {
      card.appendChild(el("div", { class: "hint", text: "\uC774 \uCC57\uC5D0\uB294 \uBCC0\uC218\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uBD07\uC774 {{setvar}}\uB97C \uC4F0\uC9C0 \uC54A\uC73C\uBA74 \uBE44\uC5B4 \uC788\uB294 \uAC83\uC774 \uC815\uC0C1\uC785\uB2C8\uB2E4." }));
    } else {
      const table = el("div", { class: "vartable" });
      for (const item of items2) table.appendChild(varRow(item));
      card.appendChild(table);
    }
    card.appendChild(buildAdd());
    listMount.appendChild(card);
  }
  function typeLabel(t) {
    switch (t) {
      case "number":
        return "\uC22B\uC790";
      case "bool":
        return "\uCC38/\uAC70\uC9D3";
      case "json":
        return "JSON";
      case "null":
        return "null";
      default:
        return "\uBB38\uC790\uC5F4";
    }
  }
  function varRow(item) {
    const value = el("input", { value: item.body, class: "mono" });
    const save = el("button", { class: "primary tiny", text: "\uC800\uC7A5" });
    save.disabled = true;
    value.addEventListener("input", () => {
      save.disabled = value.value === item.body;
    });
    const commit = async () => {
      if (value.value === item.body) return;
      save.disabled = true;
      try {
        await state.saveMemory(item.id, value.value);
        notice4(`${item.title} \uC744(\uB97C) \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uC704 \u201C\uBC18\uC601\u201D\uC73C\uB85C RisuAI\uC5D0 \uC4F8 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`, "ok");
        await refresh3();
      } catch (e) {
        notice4("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg6(e), "err");
        save.disabled = false;
      }
    };
    save.addEventListener("click", () => void commit());
    value.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void commit();
    });
    const revert = el("button", { class: "ghost tiny", text: "\uC6D0\uB798\uB300\uB85C", title: item.original ?? "" });
    revert.disabled = !item.changed;
    revert.addEventListener("click", async () => {
      if (item.original === null) return;
      try {
        await state.saveMemory(item.id, item.original);
        await refresh3();
      } catch (e) {
        notice4("\uB418\uB3CC\uB9AC\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg6(e), "err");
      }
    });
    const del = el("button", { class: "ghost tiny" });
    armed(del, "\uC0AD\uC81C", "\uC815\uB9D0?", async () => {
      try {
        await state.deleteMemory(item.id);
        notice4(`${item.title} \uC744(\uB97C) \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4. \uBC18\uC601\uD558\uBA74 RisuAI\uC5D0\uC11C\uB3C4 \uC0AC\uB77C\uC9D1\uB2C8\uB2E4.`, "ok");
        await refresh3();
      } catch (e) {
        notice4("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg6(e), "err");
      }
    });
    const badge = item.isNew ? el("span", { class: "badge ok", text: "\uCD94\uAC00" }) : item.changed ? el("span", { class: "badge warn", text: "\uC218\uC815" }) : el("span");
    return el("div", { class: "varrow" + (item.changed || item.isNew ? " changed" : "") }, [
      el("div", { class: "varkey mono", text: item.title, title: item.id }),
      el("div", { class: "vartype hint", text: typeLabel(item.valueType) }),
      el("div", { class: "varvalue" }, [value]),
      el("div", { class: "varops" }, [badge, save, revert, del])
    ]);
  }
  function buildAdd() {
    const key = el("input", { placeholder: "$\uC774\uB984", class: "mono" });
    const value = el("input", { placeholder: "\uAC12 (\uBB38\uC790\uC5F4\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4)", class: "mono" });
    const add = el("button", { class: "tiny", text: "\uBCC0\uC218 \uCD94\uAC00" });
    add.addEventListener("click", async () => {
      const k = key.value.trim();
      if (!k) {
        notice4("\uBCC0\uC218 \uC774\uB984\uC744 \uC785\uB825\uD574 \uC8FC\uC138\uC694.", "err");
        return;
      }
      add.disabled = true;
      try {
        await state.addMemory(KIND2, value.value, k);
        key.value = "";
        value.value = "";
        notice4(`${k} \uC744(\uB97C) \uCD94\uAC00\uD588\uC2B5\uB2C8\uB2E4.`, "ok");
        await refresh3();
      } catch (e) {
        notice4("\uCD94\uAC00\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg6(e), "err");
      } finally {
        add.disabled = false;
      }
    });
    return el("div", { class: "varadd row", style: { marginTop: "10px" } }, [key, value, add]);
  }
  function msg6(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/presets.ts
  var KIND_LABEL2 = { general: "\uC77C\uBC18 \uC5D0\uC774\uC804\uD2B8", search: "\uAC80\uC0C9 \uC5D0\uC774\uC804\uD2B8" };
  var REASONING_LABEL = {
    "": "\uBCF4\uB0B4\uC9C0 \uC54A\uC74C",
    none: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max"
  };
  var CODEX_KEY = "__codex__";
  function buildPresetsCard(opts) {
    const generalMount = el("div");
    const out = el("div");
    const say = (text2, kind = "") => {
      clear(out);
      out.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    };
    const refresh8 = async () => {
      clear(generalMount);
      generalMount.appendChild(el("div", { class: "hint", text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        const r = await state.presets();
        clear(generalMount);
        const general = r.presets.filter((p) => p.kind === "general");
        generalMount.appendChild(currentRow("general", r.selected, general.length));
      } catch (e) {
        clear(generalMount);
        generalMount.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      }
      await opts.onChanged();
    };
    const currentRow = (kind, p, total) => {
      const pick2 = el("button", { class: "ghost", text: `\uC120\uD0DD (${total})`, title: "\uC800\uC7A5\uB41C \uD504\uB9AC\uC14B \uBAA9\uB85D" });
      pick2.addEventListener("click", () => openPicker(kind, refresh8, say));
      if (!p) {
        const open5 = el("button", { class: "ghost chev", text: "\u203A", title: total ? `\uC800\uC7A5\uB41C \uD504\uB9AC\uC14B ${total}\uAC1C \u2014 \uC120\uD0DD \xB7 \uCD94\uAC00` : "\uD504\uB9AC\uC14B \uCD94\uAC00" });
        open5.addEventListener("click", () => openPicker(kind, refresh8, say));
        return el("div", { class: "presetnow" }, [
          el("div", { class: "grow" }, [
            el("div", { class: "hint", text: "\uD504\uB9AC\uC14B\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \u203A \uC5D0\uC11C \uD558\uB098 \uB9CC\uB4E4\uC5B4 \uC8FC\uC138\uC694." })
          ]),
          open5
        ]);
      }
      const open4 = el("button", { class: "ghost chev", text: "\u203A", title: `\uC800\uC7A5\uB41C \uD504\uB9AC\uC14B ${total}\uAC1C \u2014 \uC120\uD0DD \xB7 \uC218\uC815 \xB7 \uC0AD\uC81C \xB7 \uCD94\uAC00` });
      open4.addEventListener("click", () => openPicker(kind, refresh8, say));
      const row = el("div", { class: "presetnow" }, [
        el("div", { class: "grow" }, [
          el("div", { class: "presetnow-name" }, [
            el("span", { text: p.name }),
            !p.apiKey?.set && !p.keyRef && p.provider !== "codex" ? el("span", { class: "badge warn", style: { marginLeft: "6px" }, text: "\uD0A4 \uC5C6\uC74C" }) : null
          ]),
          el("div", { class: "hint", text: summarise(p) })
        ]),
        open4
      ]);
      return row;
    };
    const testButton = (kind, box) => {
      const testBtn = el("button", { class: "ghost", text: "\uC5F0\uACB0 \uD14C\uC2A4\uD2B8" });
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        clear(box);
        box.appendChild(el("div", { class: "hint", text: "\uD14C\uC2A4\uD2B8 \uC911\uC785\uB2C8\uB2E4\u2026 (\uCD5C\uB300 4\uBD84)" }));
        try {
          const r = await state.testAgent(kind);
          clear(box);
          if (r.ok) {
            const u = r.usage ?? {};
            box.appendChild(el("div", { class: "notice ok" }, [
              el("div", { text: `\uC815\uC0C1 \uB3D9\uC791\uD569\uB2C8\uB2E4 \xB7 ${r.model}` }),
              el("div", { class: "hint", text: `\uD234 \uD638\uCD9C ${r.toolCalls}\uAC74 \xB7 \uD1A0\uD070 in ${u.in} / out ${u.out}` })
            ]));
          } else {
            box.appendChild(el("div", { class: "notice err" }, [
              el("div", { text: `\uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4 (${r.stage})` }),
              el("div", { class: "hint", text: String(r.error ?? "") })
            ]));
          }
        } catch (e) {
          clear(box);
          box.appendChild(el("div", { class: "notice err", text: msg7(e) }));
        } finally {
          testBtn.disabled = false;
        }
      });
      return testBtn;
    };
    opts.onMount?.(refresh8);
    void refresh8();
    return el("div", {}, [
      el("div", { class: "card" }, [
        el("h2", { text: "\uC77C\uBC18 \uC5D0\uC774\uC804\uD2B8" }),
        el("div", { class: "hint", style: { marginBottom: "8px" }, text: "\uCC57\xB7\uCE74\uB4DC\uB97C \uC77D\uACE0 \uACE0\uCE58\uB294 \uC5D0\uC774\uC804\uD2B8\uC785\uB2C8\uB2E4. \uD234\uACFC \uD30C\uC774\uC36C \uC2A4\uD06C\uB9BD\uD2B8\uB97C \uC501\uB2C8\uB2E4. \uD56D\uC0C1 \uD558\uB098\uAC00 \uC120\uD0DD\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." }),
        generalMount,
        el("div", { class: "row", style: { marginTop: "8px" } }, [testButton("general", out)]),
        out,
        el("div", { class: "hint", style: { marginTop: "8px" } }, [
          "\uD14C\uC2A4\uD2B8\uB294 \uC77C\uBC18 \uC751\uB2F5\uACFC \uD234 \uD638\uCD9C\uC744 \uB530\uB85C \uD655\uC778\uD569\uB2C8\uB2E4. \uD234 \uD638\uCD9C\uC774 \uC548 \uB418\uBA74 \uC5D0\uC774\uC804\uD2B8\uAC00 \uB3D9\uC791\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
        ])
      ]),
      buildWebsearchCard()
    ]);
  }
  function buildWebsearchCard() {
    const modeSel = el("select");
    const modeNote = el("div", { class: "hint", style: { margin: "4px 0 10px" } });
    const status = el("div", { class: "hint", style: { marginBottom: "8px" } });
    const out = el("div", { class: "outbox" });
    let st = null;
    let keep = "__keep__";
    let keyList = [];
    const nativeInfo = el("div", { class: "hint" });
    const nativePane = el("div", { class: "wsmode" }, [nativeInfo]);
    const gModel = el("input", { placeholder: "gemini-3.7-flash" });
    const gKeySel = el("select");
    const gKey = el("input", { type: "password", placeholder: "Google AI Studio API \uD0A4" });
    const gKeyRow = el("label", { class: "field" }, [el("span", { text: "API \uD0A4 \uC9C1\uC811 \uC785\uB825" }), gKey]);
    const gInstr = el("textarea", { rows: "4" });
    const gReset = el("button", { class: "ghost tiny", text: "\uAE30\uBCF8 \uC9C0\uCE68\uC73C\uB85C" });
    gReset.addEventListener("click", () => {
      gInstr.value = st?.gemini.defaultInstructions ?? "";
    });
    const syncGeminiKey = () => {
      gKeyRow.style.display = selectedValue(gKeySel) ? "none" : "";
    };
    gKeySel.addEventListener("change", syncGeminiKey);
    const geminiPane = el("div", { class: "wsmode" }, [
      el("div", { class: "hint", style: { marginBottom: "8px" }, text: "Google AI Studio \uB85C \uACE0\uC815\uB429\uB2C8\uB2E4 (generativelanguage.googleapis.com). Gemini \uAC00 Google \uAC80\uC0C9\uC73C\uB85C \uCC3E\uACE0 \uC77D\uC5B4 \uCD9C\uCC98\uAC00 \uBD99\uC740 \uB2F5\uC744 \uB3CC\uB824\uC90D\uB2C8\uB2E4." }),
      el("label", { class: "field" }, [el("span", { text: "\uBAA8\uB378" }), gModel]),
      el("label", { class: "field" }, [el("span", { text: "API \uD0A4 (\uD0A4 \uBAA9\uB85D\uC5D0\uC11C)" }), gKeySel]),
      gKeyRow,
      el("label", { class: "field" }, [el("span", { text: "\uC5D0\uC774\uC804\uD2B8 \uC9C0\uCE68" }), gInstr]),
      el("div", { class: "row" }, [gReset])
    ]);
    const pSel = el("select");
    const pKey = el("input", { type: "password", placeholder: "API \uD0A4" });
    const pUrl = el("input", { placeholder: "https://searx.example.com" });
    const pMax = el("input", { type: "number", min: "1", max: "8", value: "5" });
    const pKeyRow = el("label", { class: "field" }, [el("span", { text: "API \uD0A4" }), pKey]);
    const pUrlRow = el("label", { class: "field" }, [el("span", { text: "\uC8FC\uC18C (baseUrl)" }), pUrl]);
    const pNote = el("div", { class: "hint" });
    const syncProvider = () => {
      const p = st?.providers.find((x) => x.id === selectedValue(pSel));
      pKeyRow.style.display = p?.needsKey ? "" : "none";
      pUrlRow.style.display = p?.needsUrl ? "" : "none";
      pKey.placeholder = st?.apiKeySet ? "(\uC800\uC7A5\uB41C \uD0A4 \uC720\uC9C0 \u2014 \uBC14\uAFB8\uB824\uBA74 \uC785\uB825)" : "API \uD0A4";
      pNote.textContent = p?.note ?? "";
    };
    pSel.addEventListener("change", syncProvider);
    const providerPane = el("div", { class: "wsmode" }, [
      el("label", { class: "field" }, [el("span", { text: "\uC81C\uACF5\uC790" }), pSel]),
      pNote,
      pKeyRow,
      pUrlRow,
      el("label", { class: "field" }, [el("span", { text: "\uACB0\uACFC \uC218 (1\u20138)" }), pMax])
    ]);
    const panes = { native: nativePane, gemini: geminiPane, provider: providerPane };
    const syncMode = () => {
      const m = selectedValue(modeSel);
      for (const [id, pane] of Object.entries(panes)) pane.style.display = id === m ? "" : "none";
      modeNote.textContent = st?.modes.find((x) => x.id === m)?.note ?? "";
    };
    modeSel.addEventListener("change", syncMode);
    const load = async () => {
      try {
        const [r, k] = await Promise.all([state.websearch(), state.apiKeys().catch(() => ({ keys: [] }))]);
        st = r;
        keep = r.keepSentinel || keep;
        keyList = k.keys ?? [];
        clear(modeSel);
        for (const m of r.modes) modeSel.appendChild(el("option", { value: m.id, text: `${r.modes.indexOf(m) + 1}. ${m.name}` }));
        setSelected(modeSel, r.mode);
        clear(nativeInfo);
        nativeInfo.appendChild(el("div", { text: `\uC77C\uBC18 \uC5D0\uC774\uC804\uD2B8: ${r.agent.model || "(\uBAA8\uB378 \uC5C6\uC74C)"} @ ${r.agent.host || "(\uC8FC\uC18C \uC5C6\uC74C)"}` }));
        nativeInfo.appendChild(el("div", { text: r.nativeShape ? `\uAE30\uC5B5\uD55C \uBC29\uC2DD: ${r.nativeShapeLabel || r.nativeShape} \u2014 \uD14C\uC2A4\uD2B8\uB85C \uB2E4\uC2DC \uCC3E\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.` : "\uC544\uC9C1 \uD14C\uC2A4\uD2B8\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uD14C\uC2A4\uD2B8\uAC00 \uC5EC\uB7EC \uBC29\uC2DD\uC744 \uCC28\uB840\uB85C \uC2DC\uB3C4\uD574 \uB418\uB294 \uAC83\uC744 \uAE30\uC5B5\uD569\uB2C8\uB2E4 (\uCD5C\uB300 \uBA87 \uBD84)." }));
        gModel.value = r.gemini.model === r.gemini.defaultModel ? "" : r.gemini.model;
        gModel.placeholder = r.gemini.defaultModel;
        clear(gKeySel);
        gKeySel.appendChild(el("option", { value: "", text: r.gemini.apiKeySet ? "(\uC9C1\uC811 \uC785\uB825\uD55C \uD0A4 \uC0AC\uC6A9)" : "(\uC9C1\uC811 \uC785\uB825)" }));
        for (const key of keyList) gKeySel.appendChild(el("option", { value: key.id, text: `${key.name}${key.provider ? " \xB7 " + key.provider : ""}` }));
        setSelected(gKeySel, r.gemini.keyRef);
        gKey.placeholder = r.gemini.apiKeySet ? "(\uC800\uC7A5\uB41C \uD0A4 \uC720\uC9C0 \u2014 \uBC14\uAFB8\uB824\uBA74 \uC785\uB825)" : "Google AI Studio API \uD0A4";
        gInstr.value = r.gemini.instructions;
        gInstr.placeholder = r.gemini.defaultInstructions;
        syncGeminiKey();
        clear(pSel);
        for (const p of r.providers) pSel.appendChild(el("option", { value: p.id, text: p.name }));
        setSelected(pSel, r.provider);
        pUrl.value = r.baseUrl || "";
        pMax.value = String(r.maxResults || 5);
        syncProvider();
        syncMode();
        status.textContent = r.ready ? `\uC9C0\uAE08: ${r.modes.find((m) => m.id === r.mode)?.name ?? r.mode} \u2014 \uAC80\uC0C9 \uAC00\uB2A5` : `\uAC80\uC0C9 \uBD88\uAC00: ${r.whyNot}`;
        status.className = "hint " + (r.ready ? "" : "diff-del-n");
      } catch (e) {
        status.textContent = msg7(e);
      }
    };
    const patch = () => {
      const m = selectedValue(modeSel);
      const p = { mode: m };
      if (m === "gemini") {
        p.geminiModel = gModel.value.trim();
        p.geminiKeyRef = selectedValue(gKeySel);
        p.geminiApiKey = gKey.value ? gKey.value : st?.gemini.apiKeySet ? keep : "";
        p.geminiInstructions = gInstr.value.trim();
      } else if (m === "provider") {
        p.provider = selectedValue(pSel);
        p.apiKey = pKey.value ? pKey.value : st?.apiKeySet ? keep : "";
        p.baseUrl = pUrl.value.trim();
        p.maxResults = Math.max(1, Math.min(8, Number(pMax.value) || 5));
      }
      return p;
    };
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await state.saveWebsearch(patch());
        gKey.value = "";
        pKey.value = "";
        await load();
        clear(out);
        out.appendChild(el("div", { class: "notice ok", text: "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4." }));
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      } finally {
        save.disabled = false;
      }
    });
    const q = el("input", { placeholder: "\uD14C\uC2A4\uD2B8 \uC9C8\uBB38", value: "RisuAI \uCD5C\uC2E0 \uB9B4\uB9AC\uC2A4 \uBC84\uC804" });
    const test = el("button", { class: "ghost", text: "\uD14C\uC2A4\uD2B8" });
    test.addEventListener("click", async () => {
      test.disabled = true;
      clear(out);
      out.appendChild(el("div", { class: "hint", text: "\uC800\uC7A5\uD558\uACE0 \uAC80\uC0C9\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026 (\uB0B4\uC7A5 \uAC80\uC0C9\uC740 \uC5EC\uB7EC \uBC29\uC2DD\uC744 \uC2DC\uB3C4\uD558\uBBC0\uB85C \uBA87 \uBD84 \uAC78\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4)" }));
      try {
        await state.saveWebsearch(patch());
        gKey.value = "";
        pKey.value = "";
        const r = await state.testWebsearch(q.value.trim() || "RisuAI \uCD5C\uC2E0 \uB9B4\uB9AC\uC2A4 \uBC84\uC804");
        await load();
        clear(out);
        out.appendChild(el("div", { class: "notice " + (r.ok ? "ok" : "err") }, [
          el("div", { text: r.ok ? `\uAC80\uC0C9\uB429\uB2C8\uB2E4 \xB7 ${r.detail} \xB7 ${(r.ms / 1e3).toFixed(1)}\uCD08` : `\uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4${r.detail ? " \xB7 " + r.detail : ""}` }),
          el("pre", { class: "mono", style: { maxHeight: "260px" }, text: r.text || r.error || "" })
        ]));
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      } finally {
        test.disabled = false;
      }
    });
    void load();
    return el("div", { class: "card", id: "websearch-card" }, [
      el("h2", { text: "\uC6F9 \uAC80\uC0C9 \uD234" }),
      el("div", { class: "hint", style: { marginBottom: "8px" }, text: "\uC77C\uBC18 \uC5D0\uC774\uC804\uD2B8\uAC00 \uC678\uBD80 \uC0AC\uC2E4\uC774 \uD544\uC694\uD560 \uB54C \uC4F0\uB294 web_search \uD234\uC785\uB2C8\uB2E4. \uB204\uAC00 \uAC80\uC0C9\uD560\uC9C0 \uD558\uB098\uB97C \uACE0\uB985\uB2C8\uB2E4." }),
      status,
      el("label", { class: "field" }, [el("span", { text: "\uAC80\uC0C9 \uC635\uC158" }), modeSel]),
      modeNote,
      nativePane,
      geminiPane,
      providerPane,
      el("div", { class: "row", style: { marginTop: "8px" } }, [save, q, test]),
      out
    ]);
  }
  function summarise(p) {
    const bits = [p.model || "\uBAA8\uB378 \uBBF8\uC124\uC815"];
    if (p.provider === "codex") bits.push("OpenAI \uAD6C\uB3C5");
    else if (p.keyRef) bits.push("API \uD0A4 \uD0ED\uC758 \uD0A4");
    if (p.reasoning) bits.push("reasoning " + p.reasoning);
    if (p.cache) bits.push("\uCE90\uC2DC");
    if (p.flex) bits.push("Flex");
    bits.push(`${p.maxTokens.toLocaleString()} \uD1A0\uD070`);
    if (p.params) bits.push("\uD30C\uB77C\uBBF8\uD130 JSON");
    if (p.instructions) bits.push("\uAE30\uBCF8\uC9C0\uCE68 \uC788\uC74C");
    return bits.join(" \xB7 ");
  }
  function openPicker(kind, refresh8, say) {
    const listMount2 = el("div");
    const body = el("div", {}, [
      el("div", { class: "hint", style: { marginBottom: "8px" } }, [
        "\uC120\uD0DD\uD558\uBA74 \uBC14\uB85C \uC801\uC6A9\uB429\uB2C8\uB2E4."
      ]),
      listMount2
    ]);
    const close = modal(`${KIND_LABEL2[kind]} \uD504\uB9AC\uC14B \uC120\uD0DD`, body);
    const draw2 = async () => {
      clear(listMount2);
      listMount2.appendChild(el("div", { class: "hint", text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        const r = await state.presets();
        const mine = r.presets.filter((p) => p.kind === kind);
        clear(listMount2);
        for (const p of mine) listMount2.appendChild(row(p, mine.length));
        const add = el("button", { class: "primary", text: "\uC0C8 \uD504\uB9AC\uC14B \uCD94\uAC00", style: { marginTop: "10px" } });
        add.addEventListener("click", () => {
          close();
          openEditor(kind, null, refresh8, say);
        });
        listMount2.appendChild(add);
      } catch (e) {
        clear(listMount2);
        listMount2.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      }
    };
    const row = (p, total) => {
      const pickArea = el("div", { class: "grow" }, [
        el("div", { class: "pickname" }, [
          el("span", { text: p.name }),
          p.selected ? el("span", { class: "badge ok", text: "\uC0AC\uC6A9 \uC911" }) : null,
          !p.apiKey?.set && !p.keyRef && p.provider !== "codex" ? el("span", { class: "badge warn", text: "\uD0A4 \uC5C6\uC74C" }) : null
        ]),
        el("div", { class: "hint", text: summarise(p) })
      ]);
      const select = el("button", { class: "primary tiny", text: p.selected ? "\uC0AC\uC6A9 \uC911" : "\uC120\uD0DD" });
      select.disabled = !!p.selected;
      select.addEventListener("click", async () => {
        try {
          await state.selectPreset(p.id);
          await refresh8();
          close();
          say(`\u201C${p.name}\u201D \uC744(\uB97C) \uC4F0\uAE30 \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.`, "ok");
        } catch (e) {
          say(msg7(e), "err");
        }
      });
      const edit = el("button", { class: "ghost tiny", text: "\uC218\uC815" });
      edit.addEventListener("click", () => {
        close();
        openEditor(kind, p.id, refresh8, say);
      });
      const del = el("button", { class: "ghost tiny" });
      armed(del, "\uC0AD\uC81C", "\uD55C \uBC88 \uB354", async () => {
        try {
          await state.deletePreset(p.id);
          await draw2();
          await refresh8();
        } catch (e) {
          clear(listMount2);
          listMount2.appendChild(el("div", { class: "notice err", text: msg7(e) }));
          setTimeout(() => void draw2(), 2500);
        }
      });
      if (kind === "general" && total <= 1) del.style.display = "none";
      return el("div", { class: "pickrow" + (p.selected ? " on" : "") }, [pickArea, select, edit, del]);
    };
    void draw2();
  }
  function openEditor(kind, id, refresh8, say) {
    const name = el("input", { placeholder: kind === "search" ? "\uD504\uB9AC\uC14B \uC774\uB984 (\uC608: Gemini \uAC80\uC0C9)" : "\uD504\uB9AC\uC14B \uC774\uB984 (\uC608: \uC815\uBC00 \xB7 \uC800\uB834\uC774)" });
    const agentName = el("input", { placeholder: "\uD788\uB098" });
    const baseUrl = el("input", { placeholder: kind === "search" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "https://ai-gateway.vercel.sh/v1" });
    const model = el("input", { placeholder: kind === "search" ? "gemini-2.5-flash" : "google/gemini-3.7-flash" });
    const keySel = el("select");
    const apiKey = el("input", { type: "password", placeholder: "(\uBCC0\uACBD\uD560 \uB54C\uB9CC \uC785\uB825)" });
    const keyNote = el("span", { class: "hint" });
    const ownKeyRow = el("label", { class: "field" }, [el("span", { text: "API Key (\uC9C1\uC811 \uC785\uB825)" }), apiKey, keyNote]);
    const maxTokens = el("input", { placeholder: kind === "search" ? "16000" : "32000" });
    const temperature = el("input", { placeholder: "(\uBE44\uC6C0 = \uBCF4\uB0B4\uC9C0 \uC54A\uC74C)" });
    const reasoning = reasoningSelect();
    const params = el("textarea", {
      placeholder: '{"reasoning_effort": "medium", "temperature": null}',
      style: { minHeight: "64px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "12px" }
    });
    const paramsNote = el("div", { class: "hint", style: { marginTop: "-4px", marginBottom: "10px" } });
    const provBox = el("div", { class: "notice", style: { marginBottom: "10px", display: "none" } });
    let providers = [];
    const cache = el("input", { type: "checkbox" });
    const flex = el("input", { type: "checkbox" });
    const instructions = el("textarea", {
      placeholder: kind === "search" ? "\uAC80\uC0C9 \uC5D0\uC774\uC804\uD2B8\uAC00 \uC9C0\uD0AC \uC9C0\uCE68 (\uC608: \uD55C\uAD6D\uC5B4 \uC790\uB8CC \uC6B0\uC120, \uCD9C\uCC98 3\uAC1C \uC774\uC0C1). \uBE44\uC6CC \uB450\uC154\uB3C4 \uB429\uB2C8\uB2E4." : "\uC5D0\uC774\uC804\uD2B8\uAC00 \uD56D\uC0C1 \uC9C0\uD0AC \uC9C0\uCE68\uC744 \uC801\uC5B4 \uC8FC\uC138\uC694. \uBE44\uC6CC \uB450\uC154\uB3C4 \uB429\uB2C8\uB2E4.",
      style: { minHeight: "110px" }
    });
    const instCount = el("div", { class: "hint" });
    const out = el("div");
    let keepSentinel = "__keep__";
    let keys = [];
    const keyRow = el("label", { class: "field" }, [el("span", { text: "API \uD0A4" }), keySel]);
    const keyHint = el("div", { class: "hint", style: { marginTop: "-4px", marginBottom: "10px" } }, [
      "API \uD0A4/\uC778\uC99D \uD0ED\uC758 \uD0A4\uB97C \uACE0\uB974\uAC70\uB098 \uC9C1\uC811 \uC785\uB825\uD569\uB2C8\uB2E4. \uD0A4\uB97C \uACE0\uB974\uBA74 \uC8FC\uC18C\uB3C4 \uB530\uB77C\uC635\uB2C8\uB2E4."
    ]);
    const urlRow = el("label", { class: "field" }, [el("span", { text: "Base URL" }), baseUrl]);
    const codexBox = buildCodexBox(model, false);
    const isCodex = () => selectedValue(keySel) === CODEX_KEY;
    const syncCount = () => {
      instCount.textContent = `${instructions.value.length}\uC790`;
    };
    instructions.addEventListener("input", syncCount);
    syncCount();
    const syncKeyRow = () => {
      const codex = isCodex();
      const fromKeyPage = !codex && !!selectedValue(keySel);
      urlRow.style.display = codex || fromKeyPage ? "none" : "";
      ownKeyRow.style.display = codex || fromKeyPage ? "none" : "";
      codexBox.root.style.display = codex ? "" : "none";
      if (codex) void codexBox.refresh();
    };
    keySel.addEventListener("change", syncKeyRow);
    const profileFor = () => {
      if (isCodex()) return null;
      const k = keys.find((x) => x.id === selectedValue(keySel));
      const url = (baseUrl.value || k?.baseUrl || "").toLowerCase().replace(/^https?:\/\//, "");
      const byUrl = url ? providers.find((p) => p.hosts.some((h) => url.includes(h))) : null;
      if (byUrl) return byUrl;
      const pv = (k?.provider || "").trim().toLowerCase();
      return pv ? providers.find((p) => p.id === pv || p.name.toLowerCase() === pv) ?? null : null;
    };
    const syncProvider = () => {
      const p = profileFor();
      clear(provBox);
      provBox.style.display = p ? "" : "none";
      if (!p) return;
      const fill = el("button", { class: "ghost tiny", text: "\uC608\uC2DC JSON \uCC44\uC6B0\uAE30" });
      fill.addEventListener("click", () => {
        let cur = {};
        try {
          cur = params.value.trim() ? JSON.parse(params.value) : {};
        } catch {
          cur = {};
        }
        params.value = JSON.stringify({ ...p.template, ...cur }, null, 1).replace(/\n\s*/g, " ");
      });
      provBox.appendChild(el("div", {}, [
        el("b", { text: p.name }),
        el("span", { class: "dim", text: ` \xB7 ${p.endpoint === "responses" ? "Responses API" : "Chat Completions"} \xB7 \uCD9C\uB825 \uC0C1\uD55C ${p.capField}` })
      ]));
      if (p.note) provBox.appendChild(el("div", { class: "hint", text: p.note }));
      for (const n of p.modelNotes) provBox.appendChild(el("div", { class: "hint", text: "\xB7 " + n }));
      if (p.unsupported.length) provBox.appendChild(el("div", { class: "hint", text: "\uBCF4\uB0B4\uC9C0 \uC54A\uB294 \uD544\uB4DC: " + p.unsupported.join(", ") }));
      if (p.modelExample) provBox.appendChild(el("div", { class: "hint", text: "\uBAA8\uB378 \uC774\uB984 \uC608: " + p.modelExample }));
      const row = el("div", { class: "row", style: { marginTop: "4px" } }, [
        Object.keys(p.template).length ? fill : null,
        p.docs ? el("a", { href: p.docs, target: "_blank", rel: "noopener", class: "hint", text: "\uBB38\uC11C \u2197" }) : null
      ]);
      provBox.appendChild(row);
    };
    keySel.addEventListener("change", syncProvider);
    baseUrl.addEventListener("input", syncProvider);
    model.addEventListener("input", syncProvider);
    const catalogBtn = el("button", { class: "ghost tiny", text: "\uCE74\uD0C8\uB85C\uADF8\uC5D0\uC11C \uCC3E\uAE30", title: "models.dev \uC5D0\uC11C \uD504\uB85C\uBC14\uC774\uB354\xB7\uBAA8\uB378\uC744 \uCC3E\uC544 \uCC44\uC6C1\uB2C8\uB2E4" });
    catalogBtn.addEventListener("click", () => openCatalogPicker(catalogBtn, (m, api) => {
      model.value = m.id;
      if (api && !baseUrl.value) baseUrl.value = api;
    }));
    const load = async () => {
      try {
        const r = await state.presets();
        keepSentinel = r.keepSentinel || keepSentinel;
        keys = r.keys ?? [];
        providers = r.providers ?? [];
        paramsNote.textContent = `\uC694\uCCAD \uD544\uB4DC \uC774\uB984 \uADF8\uB300\uB85C, null \uC740 "\uBCF4\uB0B4\uC9C0 \uC54A\uC74C". \uC704 \uCE78\uB4E4\uBCF4\uB2E4 \uC6B0\uC120\uD569\uB2C8\uB2E4. \uC624\uB958 \uBA54\uC2DC\uC9C0\uAC00 \uC54C\uB824\uC8FC\uB294 JSON \uC744 \uC5EC\uAE30\uC5D0 \uBD99\uC785\uB2C8\uB2E4. (${r.maxParams ?? 4e3}\uC790\uAE4C\uC9C0)`;
        clear(keySel);
        keySel.appendChild(el("option", { value: "", text: "\uC9C1\uC811 \uC785\uB825" }));
        for (const k of keys) keySel.appendChild(el("option", { value: k.id, text: `${k.name}${k.provider ? " \xB7 " + k.provider : ""}` }));
        keySel.appendChild(el("option", { value: CODEX_KEY, text: "OpenAI \uAD6C\uB3C5 (ChatGPT Plus/Pro \xB7 Codex)" }));
        const p = id ? r.presets.find((x) => x.id === id) : null;
        if (!p) {
          agentName.value = r.defaultAgentName || "\uD788\uB098";
          instructions.value = r.defaultInstructions?.[kind] || "";
          syncCount();
          keyNote.textContent = "\uC124\uC815\uB418\uC9C0 \uC54A\uC74C";
          syncKeyRow();
          syncProvider();
          return;
        }
        agentName.value = p.agentName || r.defaultAgentName || "\uD788\uB098";
        name.value = p.name;
        baseUrl.value = p.baseUrl;
        model.value = p.model;
        maxTokens.value = String(p.maxTokens);
        temperature.value = p.temperature === null || p.temperature === void 0 ? "" : String(p.temperature);
        params.value = p.params || "";
        setSelected(reasoning, p.reasoning || "");
        setSelected(keySel, p.provider === "codex" ? CODEX_KEY : p.keyRef || "");
        cache.checked = p.cache;
        flex.checked = p.flex;
        instructions.value = p.instructions || "";
        syncCount();
        syncKeyRow();
        syncProvider();
        keyNote.textContent = p.apiKey?.set ? `\uC124\uC815\uB428 (${p.apiKey.length}\uC790) \u2014 \uBC14\uAFB8\uB824\uBA74 \uC0C8\uB85C \uC785\uB825` : "\uC124\uC815\uB418\uC9C0 \uC54A\uC74C";
      } catch (e) {
        keyNote.textContent = msg7(e);
      }
    };
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    const cancel = el("button", { class: "ghost", text: "\uCDE8\uC18C" });
    const body = el("div", {}, [
      el("label", { class: "field" }, [el("span", { text: "\uD504\uB9AC\uC14B \uC774\uB984" }), name]),
      kind === "general" ? el("label", { class: "field" }, [el("span", { text: "\uC5D0\uC774\uC804\uD2B8 \uC774\uB984 (\uB300\uD654\uC5D0\uC11C \uBD80\uB974\uB294 \uC774\uB984)" }), agentName]) : null,
      keyRow,
      keyHint,
      codexBox.root,
      ownKeyRow,
      urlRow,
      el("label", { class: "field" }, [
        el("span", {}, [el("span", { text: "Model " }), catalogBtn]),
        model
      ]),
      kind === "search" ? el("div", { class: "notice", style: { marginBottom: "10px" }, text: "\uAC80\uC0C9 \uC5D0\uC774\uC804\uD2B8\uC5D0\uB294 \uAC80\uC0C9\uC5D0 \uAC15\uD558\uACE0 \uC800\uB834\uD55C \uBAA8\uB378\uC744 \uAD8C\uD569\uB2C8\uB2E4 \u2014 Google Gemini(\uC608: gemini-2.5-flash, OpenAI \uD638\uD658 \uC5D4\uB4DC\uD3EC\uC778\uD2B8 \u2026/v1beta/openai). \uC2E4\uC81C \uAC80\uC0C9\uC740 \uC5D0\uC774\uC804\uD2B8 \uD0ED \uC544\uB798 \u201C\uAC80\uC0C9 \uC81C\uACF5\uC790\u201D \uCE74\uB4DC\uB85C \uD569\uB2C8\uB2E4." }) : null,
      el("div", { class: "row" }, [
        el("label", { class: "field grow" }, [el("span", { text: "\uCD5C\uB300 \uCD9C\uB825 \uD1A0\uD070" }), maxTokens]),
        el("label", { class: "field grow" }, [el("span", { text: "temperature" }), temperature])
      ]),
      el("div", { class: "hint", style: { marginTop: "-4px", marginBottom: "10px" } }, [
        "\uC0AC\uACE0 \uBAA8\uB378\uC740 \uC0DD\uAC01\uD55C \uD1A0\uD070\uB3C4 \uCD9C\uB825\uC5D0 \uD3EC\uD568\uB429\uB2C8\uB2E4 \u2014 32000 \uC774\uC0C1 \uAD8C\uC7A5. temperature \uB294 \uBE44\uC6B0\uBA74 \uBCF4\uB0B4\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
      ]),
      el("label", { class: "field" }, [el("span", { text: "Reasoning" }), reasoning]),
      el("div", { class: "row", style: { marginBottom: "8px" } }, [
        el(
          "label",
          { class: "checkrow", title: "\uAC19\uC740 \uC9C0\uC2DC\uBB38\xB7\uD234 \uC815\uC758\uB97C \uB2E4\uC2DC \uBCF4\uB0BC \uB54C \uCE90\uC2DC\uB97C \uD0DC\uC6C1\uB2C8\uB2E4" },
          [cache, el("span", { text: "\uD504\uB86C\uD504\uD2B8 \uCE90\uC2DC" })]
        ),
        el(
          "label",
          { class: "checkrow", title: "\uC2F8\uC9C0\uB9CC \uB290\uB9BD\uB2C8\uB2E4. \uB300\uAE30\uAC00 \uAE38\uC5B4\uC9C8 \uC218 \uC788\uC2B5\uB2C8\uB2E4" },
          [flex, el("span", { text: "Flex \uD2F0\uC5B4" })]
        )
      ]),
      el("div", { class: "hint", style: { marginBottom: "12px" } }, [
        "\uD504\uB85C\uBC14\uC774\uB354\uC5D0 \uB530\uB77C \uC9C0\uC6D0\uC774 \uB2E4\uB985\uB2C8\uB2E4. \uC624\uB958\uAC00 \uB098\uBA74 \uBA3C\uC800 \uAEBC \uBCF4\uC138\uC694."
      ]),
      provBox,
      el("label", { class: "field" }, [el("span", { text: "\uD30C\uB77C\uBBF8\uD130 JSON (\uC120\uD0DD)" }), params]),
      paramsNote,
      el("label", { class: "field" }, [
        el("span", { text: "\uAE30\uBCF8\uC9C0\uCE68" }),
        instructions,
        instCount
      ]),
      el("div", { class: "hint", style: { marginTop: "-4px", marginBottom: "12px" } }, [
        "\uAE30\uBCF8 \uADDC\uCE59 \uB4A4\uC5D0 \uB367\uBD99\uC2B5\uB2C8\uB2E4. \u201C\uC804\uC0AC\uC5D0 \uC9C1\uC811 \uC4F0\uC9C0 \uC54A\uB294\uB2E4\u201D \uAC19\uC740 \uC548\uC804 \uADDC\uCE59\uC740 \uC5EC\uAE30\uC11C \uB4A4\uC9D1\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
      ]),
      out,
      el("div", { class: "row" }, [save, cancel])
    ]);
    const close = modal(`${KIND_LABEL2[kind]} \u2014 ${id ? "\uD504\uB9AC\uC14B \uC218\uC815" : "\uC0C8 \uD504\uB9AC\uC14B"}`, body, { wide: true, sticky: true });
    cancel.addEventListener("click", close);
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const saved = await state.savePreset(name.value, {
          kind,
          provider: isCodex() ? "codex" : "",
          keyRef: isCodex() ? "" : selectedValue(keySel),
          baseUrl: baseUrl.value,
          model: model.value,
          // Leave the stored key alone unless a new one was typed.
          apiKey: apiKey.value ? apiKey.value : keepSentinel,
          maxTokens: maxTokens.value === "" ? void 0 : Number(maxTokens.value),
          // '' is a value here: "do not send". undefined would keep the old one.
          temperature: temperature.value.trim() === "" ? "" : Number(temperature.value),
          params: params.value.trim(),
          reasoning: selectedValue(reasoning),
          cache: cache.checked,
          flex: flex.checked,
          instructions: instructions.value,
          agentName: agentName.value.trim() || void 0
        }, id ?? void 0);
        close();
        await refresh8();
        say(saved.selected ? "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4." : `\u201C${saved.name}\u201D \uC744(\uB97C) \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uC4F0\uB824\uBA74 \uC544\uB798\uC5D0\uC11C \uC120\uD0DD\uD558\uC138\uC694.`, "ok");
        openPicker(kind, refresh8, say);
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      } finally {
        save.disabled = false;
      }
    });
    void load();
  }
  function buildCodexBox(modelInput, withLogin) {
    const line = el("div", { class: "hint" });
    const out = el("div", { class: "outbox" });
    const login = el("button", { class: "primary tiny", text: "OpenAI \uB85C\uADF8\uC778" });
    const logout = el("button", { class: "ghost tiny", text: "\uB85C\uADF8\uC544\uC6C3" });
    const paste = el("input", { placeholder: "\uB85C\uADF8\uC778 \uB4A4 \uC774\uB3D9\uD55C \uC8FC\uC18C\uB97C \uC5EC\uAE30\uC5D0 \uBD99\uC5EC\uB123\uAE30 (http://localhost:1455/auth/callback?code=\u2026)" });
    const finish = el("button", { class: "ghost tiny", text: "\uBD99\uC5EC\uB123\uC740 \uC8FC\uC18C\uB85C \uC644\uB8CC" });
    const pasteRow = el("div", { class: "row" }, [paste, finish]);
    pasteRow.style.display = "none";
    const models = el("div", { class: "row" });
    let pendingState = "";
    let poll = null;
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    const refresh8 = async () => {
      try {
        const s = await state.codexStatus();
        line.textContent = s.loggedIn ? `\uB85C\uADF8\uC778\uB428 \xB7 ${s.email || s.accountId.slice(0, 8)}${s.plan ? " \xB7 " + s.plan : ""}` : "\uB85C\uADF8\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. ChatGPT Plus/Pro \uACC4\uC815\uC73C\uB85C \uB85C\uADF8\uC778\uD558\uBA74 \uAD6C\uB3C5\uC73C\uB85C \uC5D0\uC774\uC804\uD2B8\uB97C \uB3CC\uB9BD\uB2C8\uB2E4.";
        login.style.display = s.loggedIn ? "none" : "";
        logout.style.display = s.loggedIn ? "" : "none";
        if (s.loggedIn) {
          pasteRow.style.display = "none";
          stopPoll();
        }
        clear(models);
        if (modelInput) {
          for (const m of s.models) {
            const b = el("button", { class: "ghost tiny", text: m });
            b.addEventListener("click", () => {
              modelInput.value = m;
            });
            models.appendChild(b);
          }
        }
      } catch (e) {
        line.textContent = msg7(e);
      }
    };
    login.addEventListener("click", async () => {
      login.disabled = true;
      clear(out);
      try {
        const r = await state.codexLoginStart();
        pendingState = r.state;
        const a = el("a", { href: r.url, target: "_blank", rel: "noopener", text: "\uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C OpenAI \uB85C\uADF8\uC778 \uC5F4\uAE30" });
        const urlBox = el("input", { value: r.url, readonly: "readonly", class: "mono" });
        urlBox.addEventListener("focus", () => {
          try {
            urlBox.select();
          } catch {
          }
        });
        const copy = el("button", { class: "ghost tiny", text: "\uBCF5\uC0AC" });
        copy.addEventListener("click", () => {
          try {
            urlBox.select();
            document.execCommand("copy");
            copy.textContent = "\uBCF5\uC0AC\uB428";
          } catch {
            copy.textContent = "\uAE38\uAC8C \uB20C\uB7EC \uBCF5\uC0AC";
          }
        });
        out.appendChild(el("div", { class: "notice" }, [
          el("div", {}, [a]),
          el("div", { class: "row", style: { marginTop: "6px" } }, [urlBox, copy]),
          el("ol", { class: "hint steps" }, [
            el("li", { text: "\uC704 \uC8FC\uC18C\uB97C \uC5F4\uC5B4 ChatGPT \uACC4\uC815\uC73C\uB85C \uB85C\uADF8\uC778\uD569\uB2C8\uB2E4 (\uB2E4\uB978 \uAE30\uAE30\uC5EC\uB3C4 \uB429\uB2C8\uB2E4)." }),
            el("li", { text: r.listening ? "\uBC31\uC5D4\uB4DC\uC640 \uAC19\uC740 PC \uC758 \uBE0C\uB77C\uC6B0\uC800\uBA74 \uC790\uB3D9\uC73C\uB85C \uC644\uB8CC\uB429\uB2C8\uB2E4." : "(\uD3EC\uD2B8 1455 \uAC00 \uC0AC\uC6A9 \uC911\uC774\uB77C \uC790\uB3D9 \uC644\uB8CC\uB294 \uC548 \uB429\uB2C8\uB2E4.)" }),
            el("li", { text: '\uB2E4\uB978 \uAE30\uAE30\uBA74 \uB9C8\uC9C0\uB9C9\uC5D0 "\uC5F0\uACB0\uD560 \uC218 \uC5C6\uC74C" \uD398\uC774\uC9C0(localhost:1455/\u2026)\uAC00 \uB739\uB2C8\uB2E4 \u2014 \uC815\uC0C1. \uADF8 \uC8FC\uC18C \uC804\uCCB4\uB97C \uC544\uB798\uC5D0 \uBD99\uC5EC\uB123\uACE0 \uC644\uB8CC.' })
          ])
        ]));
        pasteRow.style.display = "";
        try {
          window.open(r.url, "_blank", "noopener");
        } catch {
        }
        stopPoll();
        poll = setInterval(async () => {
          try {
            const st = await state.codexLoginStatus(pendingState);
            if (st.done || st.loggedIn) {
              stopPoll();
              clear(out);
              await refresh8();
            } else if (st.error) {
              stopPoll();
              out.appendChild(el("div", { class: "notice err", text: st.error }));
            }
          } catch {
          }
        }, 2e3);
      } catch (e) {
        out.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      } finally {
        login.disabled = false;
      }
    });
    finish.addEventListener("click", async () => {
      finish.disabled = true;
      try {
        await state.codexLoginComplete(paste.value.trim(), pendingState);
        clear(out);
        paste.value = "";
        await refresh8();
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      } finally {
        finish.disabled = false;
      }
    });
    logout.addEventListener("click", async () => {
      try {
        await state.codexLogout();
        await refresh8();
      } catch (e) {
        out.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      }
    });
    const root = withLogin ? el("div", { class: "card codexbox" }, [
      el("h2", { text: "OpenAI \uAD6C\uB3C5 (Codex)" }),
      el("div", { class: "hint", style: { marginBottom: "6px" }, text: 'Codex CLI \uC640 \uAC19\uC740 \uBC29\uC2DD\uC73C\uB85C ChatGPT Plus/Pro \uACC4\uC815\uC5D0 \uB85C\uADF8\uC778\uD574 chatgpt.com \uC758 codex \uBC31\uC5D4\uB4DC\uB97C \uC501\uB2C8\uB2E4. \uB85C\uADF8\uC778\uD574 \uB450\uBA74 \uC5D0\uC774\uC804\uD2B8 \uD504\uB9AC\uC14B\uC758 API \uD0A4 \uC120\uD0DD\uC5D0\uC11C "OpenAI \uAD6C\uB3C5" \uC744 \uACE0\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uACF5\uC2DD API \uAC00 \uC544\uB2C8\uB77C OpenAI \uCABD \uBCC0\uACBD\uC5D0 \uAE68\uC9C8 \uC218 \uC788\uACE0, \uADF8\uB54C\uB294 \uC624\uB958\uB97C \uADF8\uB300\uB85C \uBCF4\uC5EC \uC90D\uB2C8\uB2E4.' }),
      line,
      el("div", { class: "row", style: { marginTop: "6px" } }, [login, logout]),
      pasteRow,
      out
    ]) : el("div", { class: "codexbox", style: { marginBottom: "10px" } }, [
      el("div", { class: "notice" }, [
        line,
        el("div", { class: "hint", style: { marginTop: "4px" }, text: "Base URL\xB7API \uD0A4\uB294 \uC4F0\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB85C\uADF8\uC778\xB7\uB85C\uADF8\uC544\uC6C3\uC740 API \uD0A4 \uD0ED\uC5D0\uC11C \uD569\uB2C8\uB2E4." })
      ]),
      el("div", { class: "hint", text: "\uC774 \uBC31\uC5D4\uB4DC\uAC00 \uBC1B\uB294 \uBAA8\uB378 (\uB204\uB974\uBA74 \uCC44\uC6CC\uC9D1\uB2C8\uB2E4):" }),
      models
    ]);
    root.style.display = "none";
    return { root, refresh: refresh8 };
  }
  function openCatalogPicker(anchor, onPick) {
    const input = el("input", { placeholder: "\uD504\uB85C\uBC14\uC774\uB354\uB098 \uBAA8\uB378 \uC774\uB984 (\uC608: gemini, anthropic, gpt-5)" });
    const list2 = el("div", { class: "cataloglist" });
    const body = el("div", { class: "applypop catalogpop" }, [el("div", { class: "row" }, [input]), list2]);
    const close = popover(anchor, body);
    let timer = null;
    const run = async () => {
      const q = input.value.trim();
      clear(list2);
      if (q.length < 2) {
        list2.appendChild(el("div", { class: "hint", text: "\uB450 \uAE00\uC790 \uC774\uC0C1 \uC785\uB825\uD558\uC138\uC694." }));
        return;
      }
      list2.appendChild(el("div", { class: "hint", text: "\uCC3E\uB294 \uC911\u2026" }));
      try {
        const r = await state.modelCatalog(q);
        clear(list2);
        const apiOf = new Map(r.providers.map((p) => [p.id, p.api]));
        if (!r.models.length) list2.appendChild(el("div", { class: "hint", text: "\uC5C6\uC2B5\uB2C8\uB2E4." }));
        for (const m of r.models.slice(0, 40)) {
          const b = el("button", { class: "catrow" }, [
            el("span", { class: "grow", text: `${m.id}` }),
            el("span", { class: "hint", text: `${m.provider}${m.context ? " \xB7 " + Math.round(m.context / 1e3) + "k" : ""}${m.costIn != null ? " \xB7 $" + m.costIn + "/" + m.costOut : ""}` })
          ]);
          b.addEventListener("click", () => {
            onPick(m, apiOf.get(m.provider) || "");
            close();
          });
          list2.appendChild(b);
        }
        if (r.truncated) list2.appendChild(el("div", { class: "hint", text: "\uB354 \uC788\uC2B5\uB2C8\uB2E4 \u2014 \uAC80\uC0C9\uC5B4\uB97C \uC881\uD600 \uC8FC\uC138\uC694." }));
      } catch (e) {
        clear(list2);
        list2.appendChild(el("div", { class: "notice err", text: msg7(e) }));
      }
    };
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), 300);
    });
    setTimeout(() => input.focus(), 0);
  }
  function reasoningSelect() {
    const sel = el("select");
    for (const [value, label] of Object.entries(REASONING_LABEL)) {
      sel.appendChild(el("option", { value, text: label }));
    }
    return sel;
  }
  function msg7(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/skills.ts
  function buildSkillsCard(opts = {}) {
    const listMount2 = el("div");
    const out = el("div", { class: "outbox" });
    const budget = el("div", { class: "hint" });
    let maxBody = 4e4;
    let maxDesc = 400;
    const say = (text2, kind = "") => {
      clear(out);
      out.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    };
    const refresh8 = async () => {
      clear(listMount2);
      listMount2.appendChild(el("div", { class: "hint", text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        const r = await state.skills();
        maxBody = r.maxBodyChars || maxBody;
        maxDesc = r.maxDescriptionChars || maxDesc;
        budget.textContent = `\uB9E4 \uC694\uCCAD\uC5D0 \uC2E4\uB9AC\uB294 \uAC83\uC740 \uC774 \uBAA9\uB85D(\uC774\uB984\xB7\uC124\uBA85)\uBFD0\uC785\uB2C8\uB2E4: ${r.catalogChars.toLocaleString()}\uC790 / \uD55C\uB3C4 ${r.catalogLimit.toLocaleString()}\uC790. \uBCF8\uBB38\uC740 \uC5D0\uC774\uC804\uD2B8\uAC00 \uB9DE\uB294 \uC791\uC5C5\uC744 \uB9CC\uB098\uBA74 load_skill \uB85C \uADF8\uB54C \uBD88\uB7EC\uC635\uB2C8\uB2E4.`;
        clear(listMount2);
        if (!r.skills.length) {
          listMount2.appendChild(el("div", { class: "hint", text: "\uB4F1\uB85D\uB41C \uC2A4\uD0AC\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." }));
          return;
        }
        for (const s of r.skills) listMount2.appendChild(row(s));
      } catch (e) {
        clear(listMount2);
        listMount2.appendChild(el("div", { class: "notice err", text: msg8(e) }));
      }
    };
    const row = (s) => {
      const toggle = el("input", { type: "checkbox", checked: s.enabled, title: "\uCF1C\uBA74 \uBAA9\uB85D\uC5D0 \uC2E4\uB824 \uC5D0\uC774\uC804\uD2B8\uAC00 \uBD88\uB7EC\uC62C \uC218 \uC788\uC2B5\uB2C8\uB2E4" });
      toggle.addEventListener("change", async () => {
        try {
          await state.toggleSkill(s.id, toggle.checked);
          await refresh8();
        } catch (e) {
          toggle.checked = !toggle.checked;
          say(msg8(e), "err");
        }
      });
      const editBtn = el("button", { class: "ghost tiny", text: "\uC218\uC815" });
      editBtn.addEventListener("click", () => void openEditor2(s.id, refresh8, say, { maxBody, maxDesc }));
      const del = el("button", { class: "ghost tiny" });
      armed(del, "\uC0AD\uC81C", "\uD3F4\uB354\uC9F8 \uC9C0\uC6C1\uB2C8\uB2E4", async () => {
        try {
          await state.deleteSkill(s.id);
          await refresh8();
        } catch (e) {
          say(msg8(e), "err");
        }
      });
      const files = s.files?.length ? ` \xB7 \uD30C\uC77C ${s.files.length}` : "";
      return el("div", { class: "pickrow" + (s.enabled ? "" : " off") }, [
        toggle,
        el("div", { class: "grow" }, [
          el("div", { class: "pickname" }, [
            el("span", { text: s.name }),
            s.always ? el("span", { class: "badge warn", text: "\uD56D\uC0C1" }) : null,
            s.files?.some((f) => f.path.startsWith("scripts/")) ? el("span", { class: "badge", text: "PY" }) : null,
            s.enabled ? null : el("span", { class: "badge", text: "\uAEBC\uC9D0" })
          ]),
          el("div", { class: "hint", text: s.description || "(\uC124\uBA85 \uC5C6\uC74C)" }),
          el("div", { class: "hint dim", text: `skills/${s.id} \xB7 \uBCF8\uBB38 ${s.bodyChars.toLocaleString()}\uC790${files}` })
        ]),
        editBtn,
        del
      ]);
    };
    const addBtn = el("button", { class: "primary", text: "\uC2A4\uD0AC \uCD94\uAC00" });
    addBtn.addEventListener("click", () => void openEditor2(null, refresh8, say, { maxBody, maxDesc }));
    const picker = el("input", { type: "file", accept: ".md,.txt,.py,.zip", style: { display: "none" } });
    picker.addEventListener("change", async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const skill = await state.uploadSkill(file);
        await refresh8();
        say(`\u201C${skill.name}\u201D \uC2A4\uD0AC\uC744 \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4 (skills/${skill.id}). \uC124\uBA85\uC744 \uB2E4\uB4EC\uC5B4 \uB450\uBA74 \uC5D0\uC774\uC804\uD2B8\uAC00 \uB354 \uC815\uD655\uD788 \uACE0\uB985\uB2C8\uB2E4.`, "ok");
      } catch (e) {
        say("\uC5C5\uB85C\uB4DC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg8(e), "err");
      } finally {
        picker.value = "";
      }
    });
    const uploadBtn = el("button", { class: "ghost", text: "\uAC00\uC838\uC624\uAE30 (.md \xB7 .py \xB7 .zip)" });
    uploadBtn.addEventListener("click", () => picker.click());
    const previewBtn = el("button", { class: "ghost", text: "\uBCF4\uB0B4\uB294 \uB0B4\uC6A9 \uBCF4\uAE30" });
    previewBtn.addEventListener("click", async () => {
      previewBtn.disabled = true;
      try {
        const r = await state.skillPrompt();
        modal(`\uC2E4\uC81C\uB85C \uBD99\uB294 \uB0B4\uC6A9 \xB7 ${r.chars.toLocaleString()}\uC790`, el("div", {}, [
          el("div", {
            class: "hint",
            style: { marginBottom: "8px" },
            text: "\uC774 \uBE14\uB85D\uC774 \uB9E4 \uC694\uCCAD\uC758 \uC9C0\uCE68 \uB05D\uC5D0 \uBD99\uC2B5\uB2C8\uB2E4. \uBCF8\uBB38\uC740 \uC5D0\uC774\uC804\uD2B8\uAC00 load_skill \uC744 \uBD80\uB97C \uB54C \uB530\uB85C \uC804\uB2EC\uB429\uB2C8\uB2E4."
          }),
          el("pre", { class: "mono filepreview", text: r.prompt || "(\uCF1C \uB454 \uC2A4\uD0AC\uC774 \uC5C6\uC2B5\uB2C8\uB2E4)" })
        ]), { wide: true });
      } catch (e) {
        say(msg8(e), "err");
      } finally {
        previewBtn.disabled = false;
      }
    });
    void refresh8();
    opts.onMount?.(refresh8);
    return el("div", { class: "card" }, [
      el("h2", { text: "\uC2A4\uD0AC" }),
      el("div", { class: "hint", style: { marginBottom: "8px" } }, [
        "\uC790\uC8FC \uC2DC\uD0A4\uB294 \uC791\uC5C5\uC758 \uC808\uCC28\uB97C \uD3F4\uB354\uB85C \uB461\uB2C8\uB2E4. \uC774\uB984\uACFC \u201C\uC5B8\uC81C \uC4F0\uB294\uC9C0\u201D \uD55C \uC904\uB9CC \uD504\uB86C\uD504\uD2B8\uC5D0 \uC2E4\uB9AC\uACE0, \uC5D0\uC774\uC804\uD2B8\uB294 \uB9DE\uB294 \uC791\uC5C5\uC774 \uC624\uBA74 load_skill \uB85C \uBCF8\uBB38\uC744 \uBD88\uB7EC\uC635\uB2C8\uB2E4 \u2014 \uB300\uD654\uCC3D\uC5D0 \uD234 \uD638\uCD9C\uB85C \uBCF4\uC785\uB2C8\uB2E4."
      ]),
      listMount2,
      el("div", { class: "row", style: { marginTop: "10px" } }, [addBtn, uploadBtn, previewBtn]),
      picker,
      budget,
      out
    ]);
  }
  async function openEditor2(id, refresh8, say, caps) {
    let skill = null;
    if (id) {
      try {
        skill = await state.skill(id);
      } catch (e) {
        say(msg8(e), "err");
        return;
      }
    }
    const name = el("input", { placeholder: "\uC2A4\uD0AC \uC774\uB984", value: skill?.name ?? "" });
    const description = el("textarea", {
      value: skill?.description ?? "",
      placeholder: '\uC5B8\uC81C \uC4F0\uB294 \uC2A4\uD0AC\uC778\uC9C0 \uD55C\uB450 \uBB38\uC7A5. \uC608: "\uD55C \uC778\uBB3C\uC758 \uB9D0\uD22C\uB97C \uCC57 \uC804\uCCB4\uC5D0\uC11C \uB9DE\uCD9C \uB54C. \uB9D0\uD22C \uD1B5\uC77C\xB7\uBC18\uB9D0\uB85C \uBC14\uAFD4 \uAC19\uC740 \uC694\uCCAD."',
      style: { minHeight: "56px" }
    });
    const descCount = el("div", { class: "hint" });
    const always = el("input", { type: "checkbox", checked: !!skill?.always });
    const body = el("textarea", {
      value: skill?.body ?? "",
      placeholder: "\uC774 \uC791\uC5C5\uC744 \uD560 \uB54C \uC5B4\uB5A4 \uC21C\uC11C\uB85C \uD574\uC57C \uD558\uB294\uC9C0. \uC5D0\uC774\uC804\uD2B8\uAC00 load_skill \uB85C \uBD88\uB7EC \uC77D\uC2B5\uB2C8\uB2E4.",
      style: { minHeight: "220px" }
    });
    const bodyCount = el("div", { class: "hint" });
    const out = el("div", { class: "outbox" });
    const sync = () => {
      descCount.textContent = `${description.value.length} / ${caps.maxDesc}\uC790 \u2014 \uC774 \uC904\uC774 \uB9E4 \uC694\uCCAD\uC5D0 \uC2E4\uB9AC\uACE0, \uC5D0\uC774\uC804\uD2B8\uAC00 \uC2A4\uD0AC\uC744 \uACE0\uB974\uB294 \uADFC\uAC70\uC785\uB2C8\uB2E4`;
      bodyCount.textContent = `${body.value.length.toLocaleString()} / ${caps.maxBody.toLocaleString()}\uC790` + (always.checked ? " \u2014 \u201C\uD56D\uC0C1 \uC801\uC6A9\u201D\uC774\uB77C \uB9E4 \uC694\uCCAD\uC5D0 \uC2E4\uB9BD\uB2C8\uB2E4" : " \u2014 \uBD88\uB7EC\uC62C \uB54C\uB9CC \uC804\uB2EC\uB429\uB2C8\uB2E4");
    };
    description.addEventListener("input", sync);
    body.addEventListener("input", sync);
    always.addEventListener("change", sync);
    sync();
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    const cancel = el("button", { class: "ghost", text: "\uCDE8\uC18C" });
    const form = el("div", {}, [
      el("label", { class: "field" }, [el("span", { text: "\uC774\uB984" }), name]),
      el("label", { class: "field" }, [el("span", { text: "\uC124\uBA85 \u2014 \uC5B8\uC81C \uC4F0\uB294\uC9C0 (\uD2B8\uB9AC\uAC70)" }), description, descCount]),
      el("label", { class: "checkrow" }, [always, el("span", { text: "\uD56D\uC0C1 \uC801\uC6A9 \u2014 \uBCF8\uBB38\uC744 \uB9E4 \uC694\uCCAD\uC5D0 \uD568\uAED8 \uBCF4\uB0C5\uB2C8\uB2E4 (\uBAA8\uB4E0 \uB300\uD654\uC5D0 \uC801\uC6A9\uB420 \uADDC\uCE59\uC5D0\uB9CC)" })]),
      el("label", { class: "field" }, [el("span", { text: "\uBCF8\uBB38 \u2014 \uC808\uCC28" }), body, bodyCount])
    ]);
    if (skill) form.appendChild(buildFiles(skill, say));
    form.appendChild(out);
    form.appendChild(el("div", { class: "row" }, [save, cancel]));
    const close = modal(skill ? `\uC2A4\uD0AC \uC218\uC815 \xB7 skills/${skill.id}` : "\uC0C8 \uC2A4\uD0AC", form, { wide: true });
    cancel.addEventListener("click", close);
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await state.saveSkill({
          id: skill?.id,
          name: name.value,
          description: description.value,
          body: body.value,
          always: always.checked
        });
        close();
        await refresh8();
        say("\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.", "ok");
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: msg8(e) }));
      } finally {
        save.disabled = false;
      }
    });
  }
  function buildFiles(skill, say) {
    const list2 = el("div", { class: "skillfiles" });
    const out = el("div", { class: "outbox" });
    let files = skill.files ?? [];
    const draw2 = () => {
      clear(list2);
      if (!files.length) {
        list2.appendChild(el("div", { class: "hint", text: "\uD30C\uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uC790\uB8CC(.md)\uB098 \uC2A4\uD06C\uB9BD\uD2B8(.py)\uB97C \uB123\uC73C\uBA74 \uBCF8\uBB38\uC5D0\uC11C \uAC00\uB9AC\uD0AC \uC218 \uC788\uC2B5\uB2C8\uB2E4." }));
        return;
      }
      for (const f of files) {
        const del = el("button", { class: "ghost tiny" });
        armed(del, "\xD7", "\uC9C0\uC6B8\uAE4C\uC694?", async () => {
          try {
            await state.deleteSkillFile(skill.id, f.path);
            files = files.filter((x) => x.path !== f.path);
            draw2();
          } catch (e) {
            clear(out);
            out.appendChild(el("div", { class: "notice err", text: msg8(e) }));
          }
        });
        list2.appendChild(el("div", { class: "pickrow" }, [
          el("span", { class: "mono grow", text: `skills/${skill.id}/${f.path}` }),
          el("span", { class: "hint", text: fmtSize3(f.size) }),
          del
        ]));
      }
    };
    draw2();
    const picker = el("input", { type: "file", style: { display: "none" } });
    const sub = el("select");
    sub.appendChild(el("option", { value: "references", text: "references/ (\uC790\uB8CC)" }));
    sub.appendChild(el("option", { value: "scripts", text: "scripts/ (\uC2A4\uD06C\uB9BD\uD2B8)" }));
    sub.appendChild(el("option", { value: "", text: "\uD3F4\uB354 \uBC14\uB85C \uC544\uB798" }));
    picker.addEventListener("change", async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const folder = [...sub.querySelectorAll("option")].find((o) => o.selected)?.value ?? "references";
        const r = await state.putSkillFile(skill.id, (folder ? folder + "/" : "") + file.name, file);
        files = [...files.filter((x) => x.path !== r.path), { path: r.path, size: r.size, textual: true }].sort((a, b) => a.path.localeCompare(b.path));
        draw2();
        say(`${r.path} \uC744(\uB97C) \uB123\uC5C8\uC2B5\uB2C8\uB2E4. \uBCF8\uBB38\uC5D0\uC11C skills/${skill.id}/${r.path} \uB85C \uAC00\uB9AC\uCF1C \uC8FC\uC138\uC694.`, "ok");
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: msg8(e) }));
      } finally {
        picker.value = "";
      }
    });
    const addBtn = el("button", { class: "ghost tiny", text: "\uD30C\uC77C \uB123\uAE30" });
    addBtn.addEventListener("click", () => picker.click());
    return el("div", { class: "field" }, [
      el("span", { text: "\uD3F4\uB354\uC758 \uD30C\uC77C" }),
      list2,
      el("div", { class: "row", style: { marginTop: "6px" } }, [sub, addBtn, picker]),
      out
    ]);
  }
  function fmtSize3(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }
  function msg8(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/debugpanel.ts
  function buildUpdateCard() {
    const out = el("div", { class: "outbox" });
    const say = (text2, kind = "") => {
      clear(out);
      out.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    };
    const applyBtn3 = el("button", { class: "primary", text: "\uBC31\uC5D4\uB4DC \uC5C5\uB370\uC774\uD2B8" });
    applyBtn3.disabled = true;
    const checkBtn = el("button", { class: "ghost", text: "\uC5C5\uB370\uC774\uD2B8 \uD655\uC778" });
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      say("\uD655\uC778\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026");
      try {
        const r = await state.updateCheck();
        clear(out);
        if (!r.configured) {
          out.appendChild(el("div", { class: "notice" }, [
            el("div", { text: "\uC5C5\uB370\uC774\uD2B8 \uB808\uD3EC\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4." }),
            el("div", {
              class: "hint",
              text: "\uBC31\uC5D4\uB4DC data/config.json \uC758 update.repo \uC5D0 GitHub \uC758 owner/repo \uB97C \uB123\uC5B4 \uC8FC\uC138\uC694."
            })
          ]));
          return;
        }
        if (!r.ok) {
          say(r.error || "\uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4", "err");
          return;
        }
        if (!r.newer) {
          say(`\uC774\uBBF8 \uCD5C\uC2E0\uC785\uB2C8\uB2E4 (v${r.current}).`, "ok");
          return;
        }
        applyBtn3.disabled = !r.installable;
        out.appendChild(el("div", { class: "notice ok" }, [
          el("div", { text: `\uC0C8 \uBC84\uC804\uC774 \uC788\uC2B5\uB2C8\uB2E4: v${r.current} \u2192 v${r.latest}` }),
          r.installable ? null : el("div", { class: "hint", text: r.reason || "\uC774 \uB9B4\uB9AC\uC2A4\uB294 \uC790\uB3D9 \uC124\uCE58\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4" })
        ]));
        if (r.notes) {
          const notes = el("div", { class: "md notes", style: { maxHeight: "320px", overflowY: "auto", marginTop: "8px" } });
          notes.appendChild(renderMarkdown(r.notes));
          out.appendChild(notes);
        }
      } catch (e) {
        say(msg9(e), "err");
      } finally {
        checkBtn.disabled = false;
      }
    });
    applyBtn3.addEventListener("click", async () => {
      applyBtn3.disabled = true;
      checkBtn.disabled = true;
      say("\uB0B4\uB824\uBC1B\uACE0 \uAC80\uC99D\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026 \uB05D\uB098\uBA74 \uBC31\uC5D4\uB4DC\uAC00 \uB2E4\uC2DC \uC2DC\uC791\uB429\uB2C8\uB2E4.");
      try {
        const r = await state.updateApply();
        if (!r.updated) {
          say(r.reason || "\uC124\uCE58\uD560 \uAC83\uC774 \uC5C6\uC2B5\uB2C8\uB2E4", "ok");
          return;
        }
        say(`v${r.version} \uC744(\uB97C) \uC124\uCE58\uD588\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC62C\uB77C\uC624\uAE30\uB97C \uAE30\uB2E4\uB9AC\uB294 \uC911\uC785\uB2C8\uB2E4\u2026`);
        const version = await state.waitForBackend(90);
        say(`\uBC31\uC5D4\uB4DC\uAC00 v${version} \uC73C\uB85C \uB2E4\uC2DC \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.`, "ok");
      } catch (e) {
        say("\uC124\uCE58 \uB610\uB294 \uC7AC\uC2DC\uC791\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg9(e) + " \u2014 \uC7A0\uC2DC \uD6C4 \uC0C8\uB85C\uACE0\uCE68\uD574\uC11C \uBC84\uC804\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.", "err");
      } finally {
        checkBtn.disabled = false;
      }
    });
    return el("div", { class: "card" }, [
      el("h2", { text: "\uC5C5\uB370\uC774\uD2B8" }),
      el("div", { class: "hint", style: { marginBottom: "8px" } }, [
        "\uC21C\uC11C\uAC00 \uC788\uC2B5\uB2C8\uB2E4. \u2460 RisuAI \uD50C\uB7EC\uADF8\uC778 \uD654\uBA74\uC5D0\uC11C \uD50C\uB7EC\uADF8\uC778\uC744 \uBA3C\uC800 \uC5C5\uB370\uC774\uD2B8\uD558\uACE0, \u2461 \uC5EC\uAE30\uC11C \uBC31\uC5D4\uB4DC\uB97C \uC5C5\uB370\uC774\uD2B8\uD574 \uC8FC\uC138\uC694."
      ]),
      el("div", { class: "row" }, [checkBtn, applyBtn3]),
      out
    ]);
  }
  function buildDebugCard() {
    const out = el("div", { class: "outbox" });
    const levelSel = el("select");
    for (const [value, label] of [
      ["", "\uC804\uCCB4"],
      ["info", "info \uC774\uC0C1"],
      ["warn", "warn \uC774\uC0C1"],
      ["error", "error\uB9CC"]
    ]) {
      levelSel.appendChild(el("option", { value, text: label }));
    }
    const say = (text2, kind = "") => {
      clear(out);
      out.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    };
    const show = (title, text2) => {
      clear(out);
      const copy = el("button", { class: "ghost tiny", text: "\uBCF5\uC0AC" });
      copy.addEventListener("click", () => {
        const ok = copyText(text2);
        copy.textContent = ok ? "\uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4" : "\uBCF5\uC0AC \uC2E4\uD328 \u2014 \uC9C1\uC811 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694";
        setTimeout(() => {
          copy.textContent = "\uBCF5\uC0AC";
        }, 3e3);
      });
      const dl = el("button", { class: "ghost tiny", text: "\uD30C\uC77C\uB85C \uC800\uC7A5" });
      dl.addEventListener("click", () => saveText(title, text2));
      out.appendChild(el("div", { class: "card" }, [
        el("h2", {}, [
          el("span", { text: `${title} \xB7 ${text2.length.toLocaleString()}\uC790` })
        ]),
        el("div", { class: "row", style: { marginBottom: "8px" } }, [copy, dl]),
        el("pre", { class: "mono filepreview", text: text2 })
      ]));
    };
    const diagBtn = el("button", { class: "primary", text: "\uC9C4\uB2E8 \uC815\uBCF4" });
    diagBtn.addEventListener("click", async () => {
      diagBtn.disabled = true;
      try {
        const server = await state.diagnostics();
        const report = {
          plugin: {
            version: "0.9.2",
            platform: transport.hostPlatform,
            route: transport.routeKind,
            tokenAttached: transport.tokenAttached,
            backendUrl: redactUrl(transport.config.url),
            hasToken: Boolean(transport.config.token),
            userAgent: navigator.userAgent,
            screen: `${window.innerWidth}x${window.innerHeight}`
          },
          server,
          state: {
            connected: Boolean(state.health),
            connectError: state.connectError,
            charKey: state.activeCharKey,
            chatKey: state.activeChatKey,
            turns: state.turns.length
          }
        };
        show("\uC9C4\uB2E8 \uC815\uBCF4", JSON.stringify(report, null, 2));
      } catch (e) {
        say("\uC9C4\uB2E8 \uC815\uBCF4\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg9(e), "err");
      } finally {
        diagBtn.disabled = false;
      }
    });
    const logBtn = el("button", { class: "ghost", text: "\uC11C\uBC84 \uB85C\uADF8" });
    logBtn.addEventListener("click", async () => {
      logBtn.disabled = true;
      try {
        const r = await state.logs(400, selectedLevel(levelSel));
        show("\uC11C\uBC84 \uB85C\uADF8", r.lines.join("\n") || "(\uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4)");
      } catch (e) {
        say("\uB85C\uADF8\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg9(e), "err");
      } finally {
        logBtn.disabled = false;
      }
    });
    return el("div", { class: "card" }, [
      el("h2", { text: "\uBB38\uC81C \uC2E0\uACE0 \xB7 \uB514\uBC84\uAE45" }),
      el("div", { class: "hint", style: { marginBottom: "8px" } }, [
        "\uBB38\uC81C\uAC00 \uC0DD\uAE30\uBA74 \uC544\uB798 \uB450 \uAC00\uC9C0\uB97C \uBCF5\uC0AC\uD574\uC11C \uD568\uAED8 \uBCF4\uB0B4 \uC8FC\uC138\uC694. API \uD0A4\uB098 \uD1A0\uD070\uC740 \uD3EC\uD568\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
      ]),
      el("div", { class: "row" }, [diagBtn, logBtn, levelSel]),
      out
    ]);
  }
  function selectedLevel(sel) {
    const chosen = Array.from(sel.querySelectorAll("option")).find((o) => o.selected);
    return chosen?.value ?? sel.value ?? "";
  }
  function redactUrl(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}:${u.port || "(\uAE30\uBCF8)"}`;
    } catch {
      return url ? "(\uD615\uC2DD \uC624\uB958)" : "(\uBBF8\uC124\uC815)";
    }
  }
  function copyText(text2) {
    return copyToClipboard(text2);
  }
  function saveText(title, text2) {
    const url = URL.createObjectURL(new Blob([text2], { type: "text/plain;charset=utf-8" }));
    const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "");
    const a = el("a", { href: url, download: `risu-hina-${title}-${stamp}.txt` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e4);
  }
  function msg9(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/tab-settings.ts
  var aboutMount = null;
  var refreshers = [];
  var watchedHealth = null;
  function refreshSettingsCards() {
    for (const fn of refreshers) {
      try {
        void fn();
      } catch {
      }
    }
  }
  state.onChange(() => {
    const ok = !!state.health;
    if (watchedHealth === null) {
      watchedHealth = ok;
      return;
    }
    if (ok && !watchedHealth) refreshSettingsCards();
    watchedHealth = ok;
  });
  function renderSettingsTab(mount) {
    if (mount.querySelector(".pad")) {
      refreshAbout();
      return;
    }
    clear(mount);
    refreshers.length = 0;
    watchedHealth = !!state.health;
    aboutMount = el("div");
    refreshAbout();
    const sections = [
      // The backend update sits with the connection, right under it: it is the
      // first thing to press when the two sides disagree, and it was buried on
      // the last page before.
      ["\uC5F0\uACB0", [buildConnectionCard(), buildUpdateCard(), buildDiagnosticCard(), buildAssetsCard()]],
      ["API \uD0A4/\uC778\uC99D", [buildKeysCard()]],
      ["\uC5D0\uC774\uC804\uD2B8", [buildPresetsCard({
        onMount: (refresh8) => {
          refreshers.push(refresh8);
        },
        onChanged: async () => {
          await state.connect();
          agentPanel().invalidate();
        }
      })]],
      ["\uC2A4\uD0AC", [buildSkillsCard({ onMount: (refresh8) => {
        refreshers.push(refresh8);
      } })]],
      ["\uC815\uBCF4 \xB7 \uB85C\uADF8", [buildCatalogCard(), buildDebugCard(), aboutMount]]
    ];
    const bar3 = el("div", { class: "subtabs" });
    const body = el("div", { class: "pad" });
    const panes = sections.map(([label, cards], i) => {
      const pane = el("div", { class: "subpane" + (i === 0 ? " active" : "") }, cards);
      const btn = el("button", { class: "subtab" + (i === 0 ? " active" : ""), text: label });
      btn.addEventListener("click", () => {
        for (const [j, other] of panes.entries()) {
          other.pane.classList.toggle("active", j === i);
          other.btn.classList.toggle("active", j === i);
        }
      });
      bar3.appendChild(btn);
      body.appendChild(pane);
      return { pane, btn };
    });
    const closeBtn = el("button", { class: "ghost tiny settingsclose", text: "\u2715 \uB2EB\uAE30", title: "\uC124\uC815\uC744 \uB2EB\uACE0 \uBCF4\uB358 \uD0ED\uC73C\uB85C \uB3CC\uC544\uAC11\uB2C8\uB2E4" });
    closeBtn.addEventListener("click", () => {
      document.getElementById("open-settings")?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    bar3.appendChild(el("span", { class: "spacer" }));
    bar3.appendChild(closeBtn);
    settingsBar = bar3;
    mount.appendChild(el("div", { class: "settingswrap" }, [body]));
  }
  var settingsBar = null;
  function getSettingsBar() {
    return settingsBar;
  }
  function refreshAbout() {
    if (!aboutMount) return;
    clear(aboutMount);
    aboutMount.appendChild(buildAboutCard());
  }
  function buildConnectionCard() {
    const cfg = transport.config;
    const url = el("input", { value: cfg.url, placeholder: "http://127.0.0.1:6020" });
    const token2 = el("input", { value: cfg.token, type: "password", placeholder: "data/token.txt" });
    const out = el("div", { class: "hint" });
    const save = el("button", { class: "primary", text: "\uC800\uC7A5\uD558\uACE0 \uC5F0\uACB0" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      out.textContent = "\uC5F0\uACB0\uD558\uB294 \uC911\uC785\uB2C8\uB2E4\u2026";
      try {
        await Risuai.pluginStorage.setItem("backend", { url: url.value, token: token2.value });
        transport.configure({ url: url.value, token: token2.value });
        const ok = await state.connect();
        out.textContent = ok ? `\uC5F0\uACB0\uB418\uC5C8\uC2B5\uB2C8\uB2E4 \xB7 \uBC31\uC5D4\uB4DC v${state.health?.version}` : "\uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + state.connectError;
        if (ok) refreshSettingsCards();
      } finally {
        save.disabled = false;
      }
    });
    return el("div", { class: "card" }, [
      el("h2", { text: "\uBC31\uC5D4\uB4DC \uC5F0\uACB0" }),
      el("label", { class: "field" }, [el("span", { text: "URL" }), url]),
      el("label", { class: "field" }, [
        el("span", { text: "\uD1A0\uD070 (\uB8E8\uD504\uBC31\uC774\uBA74 \uBE44\uC6CC \uB450\uC154\uB3C4 \uB429\uB2C8\uB2E4)" }),
        token2
      ]),
      el("div", { class: "row" }, [save]),
      out,
      el("div", { class: "hint", style: { marginTop: "8px" } }, [
        "127.0.0.1\uC740 PocketRisu \uC11C\uBC84 \uC785\uC7A5\uC758 \uB8E8\uD504\uBC31\uC785\uB2C8\uB2E4. \uC774 \uBE0C\uB77C\uC6B0\uC800\uAC00 \uB3C4\uB294 PC\uAC00 \uC544\uB2D9\uB2C8\uB2E4."
      ])
    ]);
  }
  function buildDiagnosticCard() {
    const out = el("div", { class: "outbox" });
    const run = el("button", { text: "\uC5F0\uACB0 \uC9C4\uB2E8" });
    run.addEventListener("click", async () => {
      run.disabled = true;
      clear(out);
      try {
        await transport.detectPlatform();
        const t0 = Date.now();
        const ok = await state.connect();
        const ms = Date.now() - t0;
        const h = state.health;
        const rows = [
          ["\uD638\uC2A4\uD2B8", transport.hostPlatform],
          ["\uB77C\uC6B0\uD305", transport.routeKind === "direct" ? "\uC9C1\uC811 \uC5F0\uACB0 \uD655\uC778\uB428" : "\uD655\uC778 \uC548 \uB428"],
          ["\uD1A0\uD070 \uBD80\uCC29", transport.tokenAttached ? "\uD5C8\uC6A9\uB428" : "\uBCF4\uB958 \uC911"],
          ["\uC655\uBCF5 \uC2DC\uAC04", ms + "ms"]
        ];
        if (h) {
          rows.push(["\uBC31\uC5D4\uB4DC \uBC84\uC804", h.version]);
          rows.push(["\uBC31\uC5D4\uB4DC\uAC00 \uBCF8 \uD074\uB77C\uC774\uC5B8\uD2B8", String(h.clientIp)]);
          rows.push(["\uB8E8\uD504\uBC31\uC73C\uB85C \uC778\uC2DD", h.loopback ? "\uC608 (\uD1A0\uD070 \uBA74\uC81C)" : "\uC544\uB2C8\uC624 (\uD1A0\uD070 \uD544\uC218)"]);
          rows.push(["\uC5D0\uC774\uC804\uD2B8 \uC124\uC815", h.agentReady ? "\uC644\uB8CC" : "\uBBF8\uC644\uB8CC"]);
        }
        out.appendChild(el(
          "div",
          { class: ok ? "notice ok" : "notice err" },
          [ok ? "\uBC31\uC5D4\uB4DC\uC5D0 \uC9C1\uC811 \uB2FF\uC558\uC2B5\uB2C8\uB2E4." : "\uC5F0\uACB0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + state.connectError]
        ));
        out.appendChild(el("pre", {
          class: "mono",
          text: rows.map(([k, v]) => `${k.padEnd(22)} ${v}`).join("\n")
        }));
        if (!ok && transport.hostPlatform === "web" && !transport.tokenAttached) {
          out.appendChild(el("div", { class: "notice" }, [
            el("div", { text: "web RisuAI\uC5D0\uC11C \uC9C1\uC811 \uC5F0\uACB0\uC774 \uD655\uC778\uB418\uC9C0 \uC54A\uC544 \uD1A0\uD070\uC744 \uBCF4\uB0B4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4." }),
            el("div", {
              class: "hint",
              text: "\uB300\uAC1C\uB294 \uBC31\uC5D4\uB4DC \uC55E\uC758 \uD130\uB110\xB7VPN \uC774 \uC544\uC9C1 \uC548 \uC5F4\uB9B0 \uAC83\uC774\uACE0, \uD328\uB110\uC774 30\uCD08\uB9C8\uB2E4 \uB2E4\uC2DC \uC2DC\uB3C4\uD569\uB2C8\uB2E4. \uACC4\uC18D \uC2E4\uD328\uD558\uBA74 \uC704\uC5D0 \uC778\uC6A9\uB41C \uC751\uB2F5\uC744 \uBCF4\uC138\uC694 \u2014 HTML \uC774\uB098 \uB2E4\uB978 \uC11C\uBC84\uC758 \uB2F5\uC774\uBA74 URL \uC774 \uC798\uBABB\uB41C \uAC83\uC774\uACE0, sv.risuai.xyz \uC758 \uC624\uB958\uBA74 RisuAI \uC124\uC815\uC758 Use Plain Fetch \uAC00 \uAEBC\uC838 \uC694\uCCAD\uC774 \uB9B4\uB808\uC774\uB41C \uAC83\uC785\uB2C8\uB2E4."
            })
          ]));
        }
      } finally {
        run.disabled = false;
      }
    });
    return el("div", { class: "card" }, [
      el("h2", { text: "\uC5F0\uACB0 \uC9C4\uB2E8" }),
      el("div", { class: "row" }, [run]),
      out
    ]);
  }
  function buildAssetsCard() {
    const savePath = el("input", { placeholder: "D:\\path\\to\\Risuai-NodeOnly\\save  (PocketRisu \uC758 save \uD3F4\uB354, \uBC31\uC5D4\uB4DC\uC640 \uAC19\uC740 PC\uC77C \uB54C)" });
    const stats = el("div", { class: "hint" });
    const out = el("div", { class: "outbox" });
    const load = async () => {
      try {
        const { config } = await state.getConfig();
        const pr = config.pocketrisu || {};
        savePath.value = pr.savePath || "";
      } catch {
      }
      try {
        const d = await state.diagnostics();
        const a = d.assets || {};
        stats.textContent = `\uC2A4\uD1A0\uC5B4 ${a.blobs ?? "?"}\uAC1C \xB7 ${((a.bytes ?? 0) / 1048576).toFixed(1)}MB \xB7 ${a.dir ?? ""}` + (a.fastPath ? " \xB7 SQLite \uACE0\uC18D \uACBD\uB85C \uC0AC\uC6A9 \uC911" : "") + (a.serverWrite ? " \xB7 \uC11C\uBC84 \uC4F0\uAE30 \uAC00\uB2A5" : "");
      } catch {
        stats.textContent = "";
      }
    };
    void load();
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      clear(out);
      try {
        await state.setConfig({ pocketrisu: { savePath: savePath.value.trim() } });
        await load();
        out.appendChild(el("div", { class: "notice ok", text: "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uB2E4\uC74C \uC5D0\uC14B \uB3D9\uAE30\uD654\uBD80\uD130 \uC801\uC6A9\uB429\uB2C8\uB2E4." }));
      } catch (e) {
        out.appendChild(el("div", { class: "notice err", text: "\uC800\uC7A5 \uC2E4\uD328: " + (e instanceof Error ? e.message : String(e)) }));
      } finally {
        save.disabled = false;
      }
    });
    const gc = el("button", { text: "\uC2A4\uD1A0\uC5B4 \uC815\uB9AC (GC)" });
    gc.title = "\uC5B4\uB290 \uBD07\uC758 \uBAA9\uB85D\uC5D0\uB3C4 \uC5C6\uB294 \uD30C\uC77C \uC911 7\uC77C\uC774 \uC9C0\uB09C \uAC83\uC744 \uC9C0\uC6C1\uB2C8\uB2E4";
    gc.addEventListener("click", async () => {
      gc.disabled = true;
      clear(out);
      try {
        const r = await transport.post("/assets/gc", {});
        await load();
        out.appendChild(el("div", { class: "notice ok", text: `\uC815\uB9AC\uD588\uC2B5\uB2C8\uB2E4: \uD30C\uC77C ${r.removed}\uAC1C \xB7 ${(r.freed / 1048576).toFixed(1)}MB \uD655\uBCF4 \xB7 \uACE0\uC544 \uD0A4 ${r.orphanKeys}\uAC1C` }));
      } catch (e) {
        out.appendChild(el("div", { class: "notice err", text: "GC \uC2E4\uD328: " + (e instanceof Error ? e.message : String(e)) }));
      } finally {
        gc.disabled = false;
      }
    });
    return el("div", { class: "card" }, [
      el("h2", { text: "\uD3EC\uCF13\uB9AC\uC2A4 \uC9C1\uB82C\uC5F0\uACB0 (\uD3EC\uCF13\uB9AC\uC2A4 \uC0AC\uC6A9\uC2DC\uB9CC)" }),
      el("label", { class: "field" }, [el("span", { text: "PocketRisu save \uD3F4\uB354 (\uC120\uD0DD \xB7 \uBC31\uC5D4\uB4DC\uC640 \uAC19\uC740 PC\uC77C \uB54C\uB9CC)" }), savePath]),
      el("div", { class: "row" }, [save, gc]),
      stats,
      out,
      el("div", { class: "hint", style: { marginTop: "8px" } }, [
        "\uBE44\uC6CC \uB450\uBA74 \uD50C\uB7EC\uADF8\uC778\uC774 \uC5D0\uC14B\uC744 \uC77D\uC5B4 \uC62C\uB9BD\uB2C8\uB2E4(\uC6F9 \uACC4\uC815 \uC0AC\uC6A9\uC790\uB294 \uBC31\uC5D4\uB4DC\uAC00 \uD5C8\uBE0C\uC5D0\uC11C \uC9C1\uC811 \uBC1B\uC2B5\uB2C8\uB2E4). ",
        "\uACBD\uB85C\uB97C \uC8FC\uBA74 \uBC31\uC5D4\uB4DC\uAC00 risuai.db \uB97C \uC77D\uAE30 \uC804\uC6A9\uC73C\uB85C \uC5F4\uC5B4 \uBE60\uC9C4 \uC5D0\uC14B\uC744 \uACE7\uBC14\uB85C \uCC44\uC6C1\uB2C8\uB2E4."
      ])
    ]);
  }
  function buildKeysCard() {
    const listMount2 = el("div");
    const out = el("div", { class: "outbox" });
    const say = (text2, kind = "") => {
      clear(out);
      out.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    };
    let keepSentinel = "__keep__";
    const openForm = (existing) => {
      let close = () => {
      };
      const box = form(existing, () => close());
      close = modal(existing ? "API \uD0A4 \uC218\uC815" : "API \uD0A4 \uCD94\uAC00", box, { sticky: true });
    };
    const form = (existing, onClose) => {
      const name = el("input", { value: existing?.name ?? "", placeholder: "\uC774\uB984 (\uD655\uC778\uC6A9, \uC608: \uB0B4 Gemini \uD0A4)" });
      const provider = el("input", { value: existing?.provider ?? "", placeholder: "\uD504\uB85C\uBC14\uC774\uB354 (\uC608: google, openai, openrouter, vercel)", list: "hina-providers" });
      const providerList = el("datalist", { id: "hina-providers" }, ["google", "openai", "anthropic", "openrouter", "vercel", "groq", "deepseek", "xai", "mistral", "ollama"].map((p) => el("option", { value: p })));
      const provNote = el("div", { class: "notice", style: { marginTop: "-4px", marginBottom: "10px", display: "none" } });
      let profiles = [];
      const syncProv = () => {
        const want = provider.value.trim().toLowerCase();
        const p = want ? profiles.find((x) => x.id === want || x.name.toLowerCase() === want || x.hosts.some((h) => want.includes(h))) : null;
        clear(provNote);
        provNote.style.display = p ? "" : "none";
        if (!p) return;
        provNote.appendChild(el("div", {}, [el("b", { text: p.name })]));
        provNote.appendChild(el("div", { class: "hint", text: p.api ? "API \uC8FC\uC18C: " + p.api : "API \uC8FC\uC18C: \uD504\uB85C\uC81D\uD2B8\uB9C8\uB2E4 \uB2E4\uB985\uB2C8\uB2E4 \u2014 \uC544\uB798 Base URL \uC9C1\uC811 \uC9C0\uC815" }));
        provNote.appendChild(el("div", { class: "hint", text: "\uC778\uC99D: " + p.auth }));
        if (p.modelExample) provNote.appendChild(el("div", { class: "hint", text: "\uBAA8\uB378 \uC774\uB984 \uC608: " + p.modelExample }));
        if (p.note) provNote.appendChild(el("div", { class: "hint", text: p.note }));
        if (p.docs) provNote.appendChild(el("a", { href: p.docs, target: "_blank", rel: "noopener", class: "hint", text: "\uBB38\uC11C \u2197" }));
        if (!p.api) urlRow.style.display = "";
      };
      provider.addEventListener("input", syncProv);
      void state.providers().then((list2) => {
        profiles = list2;
        clear(providerList);
        for (const p of list2) providerList.appendChild(el("option", { value: p.id, text: p.name }));
        syncProv();
      }).catch(() => {
      });
      const apiKey = el("input", { type: "password", placeholder: existing?.apiKey?.set ? `\uC124\uC815\uB428 (${existing.apiKey.length}\uC790) \u2014 \uBC14\uAFC0 \uB54C\uB9CC \uC785\uB825` : "API \uD0A4" });
      const note = el("input", { value: existing?.note ?? "", placeholder: "\uBA54\uBAA8 (\uC120\uD0DD)" });
      const baseUrl = el("input", { value: existing?.baseUrl ?? "", placeholder: "Base URL (\uD504\uB85C\uBC14\uC774\uB354 \uC774\uB984\uC73C\uB85C \uBABB \uCC3E\uC744 \uB54C\uB9CC \xB7 \uC608: https://generativelanguage.googleapis.com/v1beta/openai)" });
      const urlRow = el("label", { class: "field", style: { display: existing?.baseUrl ? "" : "none" } }, [el("span", { text: "Base URL \uC9C1\uC811 \uC9C0\uC815" }), baseUrl]);
      const urlToggle = el("button", { class: "ghost tiny", text: "Base URL \uC9C1\uC811 \uC9C0\uC815" });
      urlToggle.addEventListener("click", () => {
        urlRow.style.display = urlRow.style.display === "none" ? "" : "none";
      });
      const save = el("button", { class: "primary tiny", text: existing ? "\uC800\uC7A5" : "\uCD94\uAC00" });
      const cancel = el("button", { class: "ghost tiny", text: "\uCDE8\uC18C" });
      const box = el("div", { class: "keyform" }, [
        el("label", { class: "field" }, [el("span", { text: "\uC774\uB984" }), name]),
        el("label", { class: "field" }, [el("span", { text: "\uD504\uB85C\uBC14\uC774\uB354" }), provider, providerList]),
        el("div", { class: "hint", style: { marginTop: "-4px", marginBottom: "10px" }, text: "\uC774\uB984\uC744 \uACE0\uB974\uBA74 \uC8FC\uC18C\uB97C \uC555\uB2C8\uB2E4. \uC8FC\uC18C\uAC00 \uB530\uB85C \uC788\uC73C\uBA74 \uC544\uB798 \uC9C1\uC811 \uC9C0\uC815." }),
        provNote,
        el("label", { class: "field" }, [el("span", { text: "API \uD0A4" }), apiKey]),
        el("label", { class: "field" }, [el("span", { text: "\uBA54\uBAA8" }), note]),
        urlRow,
        el("div", { class: "row" }, [save, cancel, urlToggle])
      ]);
      cancel.addEventListener("click", () => {
        onClose();
      });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await state.saveApiKey({
            name: name.value,
            provider: provider.value,
            baseUrl: baseUrl.value,
            note: note.value,
            apiKey: apiKey.value ? apiKey.value : existing ? keepSentinel : ""
          }, existing?.id);
          say(existing ? "\uD0A4\uB97C \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uC774 \uD0A4\uB97C \uC4F0\uB294 \uD504\uB9AC\uC14B\uC5D0 \uBC14\uB85C \uC801\uC6A9\uB429\uB2C8\uB2E4." : "\uD0A4\uB97C \uCD94\uAC00\uD588\uC2B5\uB2C8\uB2E4. \uC5D0\uC774\uC804\uD2B8 \uD0ED\uC758 \uD504\uB9AC\uC14B\uC5D0\uC11C \uACE0\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4.", "ok");
          onClose();
          await draw2();
        } catch (e) {
          say(e instanceof Error ? e.message : String(e), "err");
        } finally {
          save.disabled = false;
        }
      });
      return box;
    };
    const draw2 = async () => {
      clear(listMount2);
      listMount2.appendChild(el("div", { class: "hint", text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
      try {
        const r = await state.apiKeys();
        keepSentinel = r.keepSentinel || keepSentinel;
        clear(listMount2);
        if (!r.keys.length) listMount2.appendChild(el("div", { class: "hint", text: "\uC800\uC7A5\uB41C \uD0A4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." }));
        for (const k of r.keys) {
          const edit = el("button", { class: "ghost tiny", text: "\uC218\uC815" });
          const del = el("button", { class: "ghost tiny" });
          const row = el("div", { class: "verrow keyrow" }, [
            el("div", { class: "grow" }, [
              el("div", {}, [
                el("span", { text: k.name }),
                k.provider ? el("span", { class: "badge", style: { marginLeft: "6px" }, text: k.provider }) : null,
                !k.apiKey.set ? el("span", { class: "badge warn", style: { marginLeft: "6px" }, text: "\uD0A4 \uC5C6\uC74C" }) : null
              ]),
              el("div", { class: "hint", text: [k.baseUrl || "(URL \uC5C6\uC74C)", k.apiKey.set ? `\uD0A4 ${k.apiKey.length}\uC790` : "", k.note].filter(Boolean).join(" \xB7 ") })
            ]),
            edit,
            del
          ]);
          edit.addEventListener("click", () => {
            openForm(k);
          });
          armed(del, "\uC0AD\uC81C", "\uC815\uB9D0?", async () => {
            try {
              await state.deleteApiKey(k.id);
              await draw2();
            } catch (e) {
              say(e instanceof Error ? e.message : String(e), "err");
            }
          });
          listMount2.appendChild(row);
        }
      } catch (e) {
        clear(listMount2);
        listMount2.appendChild(el("div", { class: "notice err", text: e instanceof Error ? e.message : String(e) }));
      }
    };
    const add = el("button", { class: "primary", text: "\uD0A4 \uCD94\uAC00" });
    add.addEventListener("click", () => {
      openForm(null);
    });
    refreshers.push(draw2);
    void draw2();
    const codex = buildCodexBox(null, true);
    codex.root.style.display = "";
    refreshers.push(codex.refresh);
    void codex.refresh();
    return el("div", {}, [
      el("div", { class: "card" }, [
        el("h2", { text: "API \uD0A4" }),
        el("div", { class: "hint", style: { marginBottom: "8px" }, text: "\uD504\uB85C\uBC14\uC774\uB354\xB7\uAC8C\uC774\uD2B8\uC6E8\uC774\uC758 \uD0A4\uB97C \uD55C \uACF3\uC5D0 \uB461\uB2C8\uB2E4. \uC5D0\uC774\uC804\uD2B8 \uD504\uB9AC\uC14B\uC740 \uC5EC\uAE30 \uD0A4\uB97C \uACE0\uB974\uAC70\uB098 \uC9C1\uC811 \uC785\uB825\uD560 \uC218 \uC788\uACE0, \uD0A4\uB97C \uBC14\uAFB8\uBA74 \uADF8 \uD0A4\uB97C \uC4F0\uB294 \uD504\uB9AC\uC14B \uC804\uBD80\uC5D0 \uBC14\uB85C \uC801\uC6A9\uB429\uB2C8\uB2E4. \uD0A4\uB294 \uBC31\uC5D4\uB4DC data/ \uC5D0\uB9CC \uC800\uC7A5\uB418\uBA70 \uD654\uBA74\uC5D0\uB294 \uAE38\uC774\uB9CC \uBCF4\uC785\uB2C8\uB2E4." }),
        listMount2,
        el("div", { class: "row", style: { marginTop: "8px" } }, [add]),
        out
      ]),
      codex.root
    ]);
  }
  function buildCatalogCard() {
    const input = el("input", { placeholder: "\uD504\uB85C\uBC14\uC774\uB354\uB098 \uBAA8\uB378 \uC774\uB984 (\uC608: gemini, anthropic, deepseek)" });
    const out = el("div", { class: "outbox" });
    const meta = el("div", { class: "hint" });
    let timer = null;
    const run = async (refresh8 = false) => {
      const q = input.value.trim();
      clear(out);
      if (q.length < 2 && !refresh8) {
        meta.textContent = "";
        return;
      }
      out.appendChild(el("div", { class: "hint", text: "\uCC3E\uB294 \uC911\u2026" }));
      try {
        const r = await state.modelCatalog(q, "", refresh8);
        clear(out);
        meta.textContent = `models.dev \xB7 \uD504\uB85C\uBC14\uC774\uB354 ${r.totalProviders}\uAC1C` + (r.cachedAt ? ` \xB7 \uAC31\uC2E0 ${new Date(r.cachedAt * 1e3).toLocaleString()}` : "") + (r.stale ? " \xB7 \uC624\uB798\uB428" : "");
        if (r.providers.length) {
          out.appendChild(el("div", { class: "sectiontitle", text: `\uD504\uB85C\uBC14\uC774\uB354 ${r.providers.length}` }));
          for (const p of r.providers.slice(0, 20)) {
            out.appendChild(el("div", { class: "verrow" }, [
              el("div", { class: "grow" }, [
                el("div", { text: `${p.name} (${p.id}) \xB7 \uBAA8\uB378 ${p.models}\uAC1C` }),
                el("div", { class: "hint mono", text: p.api || "(OpenAI \uD638\uD658 URL \uBBF8\uAE30\uC7AC)" }),
                p.doc ? el("div", { class: "hint", text: p.doc }) : null
              ])
            ]));
          }
        }
        if (r.models.length) {
          out.appendChild(el("div", { class: "sectiontitle", style: { marginTop: "8px" }, text: `\uBAA8\uB378 ${r.models.length}${r.truncated ? "+" : ""}` }));
          const rows = r.models.map((m) => `${m.provider.padEnd(14)} ${m.id.padEnd(40)} ${m.context ? Math.round(m.context / 1e3) + "k" : "-"}`.padEnd(62) + ` ${m.costIn != null ? "$" + m.costIn + "/" + m.costOut : "-"}${m.reasoning ? " \xB7 reasoning" : ""}${m.toolCall ? " \xB7 tools" : ""}`);
          out.appendChild(el("pre", { class: "mono", style: { maxHeight: "360px" }, text: rows.join("\n") }));
        }
        if (!r.providers.length && !r.models.length) out.appendChild(el("div", { class: "hint", text: "\uC5C6\uC2B5\uB2C8\uB2E4." }));
      } catch (e) {
        clear(out);
        out.appendChild(el("div", { class: "notice err", text: e instanceof Error ? e.message : String(e) }));
      }
    };
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), 300);
    });
    const refreshBtn = el("button", { class: "ghost tiny", text: "\uC9C0\uAE08 \uAC31\uC2E0" });
    refreshBtn.addEventListener("click", () => void run(true));
    return el("div", { class: "card" }, [
      el("h2", { text: "\uBAA8\uB378 \uCE74\uD0C8\uB85C\uADF8" }),
      el("div", { class: "hint", style: { marginBottom: "8px" }, text: "\uC8FC\uC694 \uD504\uB85C\uBC14\uC774\uB354\uC758 API \uC8FC\uC18C\uC640 \uBAA8\uB378 \uC774\uB984\xB7\uCEE8\uD14D\uC2A4\uD2B8\xB7\uAC00\uACA9\uC744 models.dev \uC5D0\uC11C \uCC3E\uC2B5\uB2C8\uB2E4(\uBC31\uC5D4\uB4DC\uAC00 \uD558\uB8E8 \uD55C \uBC88 \uBC1B\uC544 \uB460). \uD504\uB9AC\uC14B \uD3B8\uC9D1\uAE30\uC758 \u201C\uCE74\uD0C8\uB85C\uADF8\uC5D0\uC11C \uCC3E\uAE30\u201D\uB3C4 \uAC19\uC740 \uC790\uB8CC\uC785\uB2C8\uB2E4." }),
      el("div", { class: "row" }, [input, refreshBtn]),
      meta,
      out
    ]);
  }
  function buildAboutCard() {
    const h = state.health;
    return el("div", { class: "card" }, [
      el("h2", { text: "\uC815\uBCF4" }),
      el("pre", {
        class: "mono",
        text: [
          `\uD50C\uB7EC\uADF8\uC778   v${"0.9.2"}`,
          `\uBC31\uC5D4\uB4DC     ${h ? "v" + h.version : "\uBBF8\uC5F0\uACB0"}`,
          `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${h?.workspaces ?? "?"}\uAC1C`
        ].join("\n")
      })
    ]);
  }

  // src/ui/tab-meta.ts
  var LABELS = {
    name: "\uC774\uB984",
    desc: "\uC124\uBA85 (desc)",
    firstMessage: "\uD37C\uC2A4\uD2B8 \uBA54\uC2DC\uC9C0",
    creatorNotes: "\uC81C\uC791\uC790 \uB178\uD2B8",
    characterVersion: "\uBD07 \uBC84\uC804",
    replaceGlobalNote: "\uAE00\uB85C\uBC8C \uB178\uD2B8 \uB36E\uC5B4\uC4F0\uAE30",
    alternateGreetings: "\uB300\uCCB4 \uC778\uC0AC\uB9D0"
  };
  var NOT_HERE = /* @__PURE__ */ new Set(["backgroundHTML"]);
  var FIELD_RANK = {
    name: 0,
    desc: 10,
    firstMessage: 20,
    alternateGreetings: 21,
    replaceGlobalNote: 30,
    characterVersion: 100,
    creatorNotes: 110
  };
  var built4 = false;
  var treeMount3 = null;
  var viewMount3 = null;
  var noticeMount5 = null;
  var openId2 = "";
  var fields = [];
  var full = true;
  var seenEpoch3 = -1;
  var seenKey = "";
  var filterText2 = "";
  function renderMetaTab(mount) {
    if (!state.botKey) {
      clear(mount);
      built4 = false;
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \uD328\uB110\uC744 \uC5F0 \uBD07\uC774 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4. RisuAI\uC5D0\uC11C \uBD07\uC744 \uC5F4\uACE0 \uB2E4\uC2DC \uC5EC\uC138\uC694." })
      ]));
      return;
    }
    if (!built4 || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      treeMount3 = el("div", { class: "tree" });
      pane.left.appendChild(treeMount3);
      noticeMount5 = el("div");
      viewMount3 = el("div", { class: "pad" });
      pane.centre.appendChild(noticeMount5);
      pane.centre.appendChild(viewMount3);
      mount.appendChild(pane.root);
      built4 = true;
      seenEpoch3 = state.epoch;
      seenKey = state.botKey;
      void refresh4();
    } else if (seenEpoch3 !== state.epoch || seenKey !== state.botKey) {
      seenEpoch3 = state.epoch;
      seenKey = state.botKey;
      openId2 = "";
      if (viewMount3) clear(viewMount3);
      void refresh4();
    }
    bindAgent({ notice: notice5 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function notice5(text2, kind = "") {
    if (!noticeMount5) return;
    clear(noticeMount5);
    noticeMount5.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount5) clear(noticeMount5);
    }, 9e3);
  }
  async function refresh4() {
    if (!treeMount3) return;
    clear(treeMount3);
    treeMount3.appendChild(el("div", { class: "hint", style: { padding: "8px" }, text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
    try {
      const r = await state.cardFields();
      fields = r.fields.filter((f) => !NOT_HERE.has(f.field));
      full = r.full;
      drawTree3();
    } catch (e) {
      clear(treeMount3);
      treeMount3.appendChild(el("div", { class: "notice err", text: msg10(e) }));
    }
  }
  function labelOf(f) {
    if (f.field === "alternateGreetings") return `\uB300\uCCB4 \uC778\uC0AC\uB9D0 #${f.seq + 1}`;
    return LABELS[f.field] || f.field;
  }
  function drawTree3() {
    if (!treeMount3) return;
    clear(treeMount3);
    const addGreet = el("button", { class: "primary tiny", text: "\uC778\uC0AC\uB9D0 \uCD94\uAC00" });
    addGreet.addEventListener("click", async () => {
      try {
        const made = await state.addGreeting("");
        await refresh4();
        const fresh = fields.find((f) => f.id === made.id);
        if (fresh) open2(fresh);
      } catch (e) {
        notice5("\uCD94\uAC00\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg10(e), "err");
      }
    });
    const reloadBtn = el("button", { class: "ghost tiny", text: "\uC0C8\uB85C\uACE0\uCE68" });
    reloadBtn.addEventListener("click", () => void refresh4());
    treeMount3.appendChild(el("div", { class: "treehead" }, [addGreet, reloadBtn]));
    if (!full) {
      treeMount3.appendChild(el("div", {
        class: "notice",
        style: { margin: "8px" },
        text: "\uAD6C\uBC84\uC804 \uC5C5\uB85C\uB4DC \uC0C1\uD0DC\uC785\uB2C8\uB2E4. \uD328\uB110\uC744 \uB2EB\uC558\uB2E4 \uB2E4\uC2DC \uC5F4\uBA74 \uC804\uCCB4 \uCE74\uB4DC\uB85C \uAC31\uC2E0\uB429\uB2C8\uB2E4."
      }));
    }
    setToolbarSearch(filterText2, (v) => {
      filterText2 = v;
      drawTree3();
      refocusSearch(null);
    }, "\uCC3E\uAE30 (\uC774\uB984\xB7\uBCF8\uBB38)");
    const needle = filterText2.trim().toLowerCase();
    const shown = fields.filter((f) => !needle || labelOf(f).toLowerCase().includes(needle) || f.body.toLowerCase().includes(needle));
    shown.sort((a, b) => (FIELD_RANK[a.field] ?? 50) - (FIELD_RANK[b.field] ?? 50) || a.seq - b.seq);
    let ruled = false;
    for (const f of shown) {
      if (!ruled && (FIELD_RANK[f.field] ?? 50) >= 100) {
        ruled = true;
        treeMount3.appendChild(el("div", { class: "sectionline", style: { margin: "8px 6px" } }));
      }
      const name = el("button", {
        class: "treefile" + (f.id === openId2 ? " on" : ""),
        text: labelOf(f) + (f.body ? "" : " (\uBE44\uC5B4 \uC788\uC74C)"),
        title: f.id
      });
      name.addEventListener("click", () => open2(f));
      const row = el("div", { class: "treerow" }, [name]);
      if (f.deleted) row.appendChild(el("span", { class: "badge", text: "\uC0AD\uC81C \uC608\uC815" }));
      else if (f.isNew) row.appendChild(el("span", { class: "badge warn", text: "\uCD94\uAC00" }));
      else if (f.changed) row.appendChild(el("span", { class: "badge warn", text: "\uC218\uC815" }));
      treeMount3.appendChild(row);
    }
  }
  function open2(f) {
    if (!viewMount3) return;
    openId2 = f.id;
    for (const b of Array.from(document.querySelectorAll(".tree .treefile"))) {
      b.classList.toggle("on", b.title === f.id);
    }
    const body = el("textarea", {
      value: f.body,
      style: { minHeight: f.field === "name" ? "48px" : "340px" }
    });
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await state.saveCardField(f.id, body.value);
        notice5(f.deleted ? "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uC0AD\uC81C \uD45C\uC2DC\uB294 \uD574\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.", "ok");
        await refresh4();
        const fresh = fields.find((x) => x.id === f.id);
        if (fresh) open2(fresh);
      } catch (e) {
        notice5("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg10(e), "err");
      } finally {
        save.disabled = false;
      }
    });
    const buttons = [save];
    if (f.field === "alternateGreetings" && !f.deleted) {
      const del = el("button", { class: "ghost" });
      armed(del, "\uC0AD\uC81C", "\uC815\uB9D0 \uC9C0\uC6B8\uAE4C\uC694?", async () => {
        try {
          await state.deleteGreeting(f.id);
          openId2 = "";
          if (viewMount3) clear(viewMount3);
          await refresh4();
        } catch (e) {
          notice5("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg10(e), "err");
        }
      });
      buttons.push(del);
    }
    const diff = f.changed && !f.conflict ? diffCard(f.original, f.body) : null;
    const conflict = f.conflict ? conflictBox({
      kind: "card_field",
      id: f.id,
      label: labelOf(f),
      charKey: state.botKey,
      chatKey: null,
      reason: String(f.conflict.kind ?? ""),
      tier: "",
      mine: f.body,
      theirs: f.conflict.theirs ?? null,
      base: f.conflict.base ?? null,
      canTakeTheirs: true
    }, () => {
      void refresh4();
    }) : null;
    clear(viewMount3);
    viewMount3.appendChild(el("div", { class: "card" }, [
      conflict,
      el("h2", {}, [
        el("span", { text: labelOf(f) }),
        el("span", { class: "spacer" }),
        f.field === "name" ? null : focusButton(body, labelOf(f))
      ]),
      ...f.deleted ? [el("div", { class: "notice", text: "\uC0AD\uC81C \uC608\uC815\uC785\uB2C8\uB2E4. \uC800\uC7A5\uD558\uBA74 \uC0AD\uC81C\uAC00 \uCDE8\uC18C\uB429\uB2C8\uB2E4." })] : [],
      el("label", { class: "field" }, [body]),
      ...diff ? [diff] : [],
      el("div", { class: "row" }, buttons)
    ]));
  }
  function msg10(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/tab-botlore.ts
  var renderBotLoreTab = makeLoreTab({
    scope: "global",
    scopeLabel: "\uC774 \uBD07",
    heading: "\uBD07 \uB85C\uC5B4\uBD81 \uD56D\uBAA9",
    emptyLines: [
      "\uC774 \uBD07\uC758 \uB85C\uC5B4\uBD81(globalLore)\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.",
      "\uC5EC\uAE30 \uD56D\uBAA9\uC740 \uC774 \uBD07\uC758 \uBAA8\uB4E0 \uCC57\uC5D0 \uC801\uC6A9\uB429\uB2C8\uB2E4."
    ],
    savedNotice: "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 \uCE74\uB4DC\uC640 \uD568\uAED8 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4."
  });

  // src/ui/tab-regex.ts
  var TYPES = ["editinput", "editoutput", "editprocess", "editdisplay"];
  var TYPE_LABEL = {
    editinput: "editinput \u2014 \uC785\uB825 \uC218\uC815",
    editoutput: "editoutput \u2014 \uBAA8\uB378 \uCD9C\uB825 \uC218\uC815(\uC800\uC7A5\uB428)",
    editprocess: "editprocess \u2014 \uC694\uCCAD \uC9C1\uC804 \uC218\uC815",
    editdisplay: "editdisplay \u2014 \uD45C\uC2DC\uB9CC \uC218\uC815"
  };
  var BG_LABEL = {
    backgroundHTML: "\uBC31\uADF8\uB77C\uC6B4\uB4DC HTML"
  };
  var built5 = false;
  var treeMount4 = null;
  var viewMount4 = null;
  var noticeMount6 = null;
  var openId3 = "";
  var items3 = [];
  var bgFields = [];
  var seenEpoch4 = -1;
  var seenKey2 = "";
  var filterText3 = "";
  function renderRegexTab(mount) {
    if (!state.botKey) {
      clear(mount);
      built5 = false;
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \uD328\uB110\uC744 \uC5F0 \uBD07\uC774 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4." })
      ]));
      return;
    }
    if (!built5 || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      treeMount4 = el("div", { class: "tree" });
      pane.left.appendChild(treeMount4);
      noticeMount6 = el("div");
      viewMount4 = el("div", { class: "pad" });
      pane.centre.appendChild(noticeMount6);
      pane.centre.appendChild(viewMount4);
      mount.appendChild(pane.root);
      built5 = true;
      seenEpoch4 = state.epoch;
      seenKey2 = state.botKey;
      void refresh5();
    } else if (seenEpoch4 !== state.epoch || seenKey2 !== state.botKey) {
      seenEpoch4 = state.epoch;
      seenKey2 = state.botKey;
      openId3 = "";
      if (viewMount4) clear(viewMount4);
      void refresh5();
    }
    bindAgent({ notice: notice6 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function notice6(text2, kind = "") {
    if (!noticeMount6) return;
    clear(noticeMount6);
    noticeMount6.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount6) clear(noticeMount6);
    }, 9e3);
  }
  async function refresh5() {
    if (!treeMount4) return;
    clear(treeMount4);
    treeMount4.appendChild(el("div", { class: "hint", style: { padding: "8px" }, text: "\uC77D\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" }));
    try {
      items3 = await state.cardScripts("customscript");
      const r = await state.cardFields();
      bgFields = r.fields.filter((f) => f.field in BG_LABEL);
      drawTree4();
    } catch (e) {
      clear(treeMount4);
      treeMount4.appendChild(el("div", { class: "notice err", text: msg11(e) }));
    }
  }
  function titleOf2(s) {
    const e = s.entry;
    return String(e.comment || e.in || "").trim().slice(0, 60) || "(\uC774\uB984 \uC5C6\uC74C)";
  }
  function drawTree4() {
    if (!treeMount4) return;
    clear(treeMount4);
    const add = el("button", { class: "primary tiny", text: "\uC0C8 \uD56D\uBAA9" });
    add.addEventListener("click", async () => {
      try {
        const id = await state.addScript(
          "customscript",
          { comment: "\uC0C8 \uC2A4\uD06C\uB9BD\uD2B8", in: "", out: "", type: "editdisplay" }
        );
        await refresh5();
        const made = items3.find((s) => s.id === id);
        if (made) open3(made);
      } catch (e) {
        notice6("\uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg11(e), "err");
      }
    });
    const reloadBtn = el("button", { class: "ghost tiny", text: "\uC0C8\uB85C\uACE0\uCE68" });
    reloadBtn.addEventListener("click", () => void refresh5());
    treeMount4.appendChild(el("div", { class: "treehead" }, [add, reloadBtn]));
    if (bgFields.length) {
      treeMount4.appendChild(el("div", { class: "treescope", text: "\uBC30\uACBD" }));
      for (const f of bgFields) {
        const name = el("button", {
          class: "treefile" + (f.id === openId3 ? " on" : ""),
          text: BG_LABEL[f.field] + (f.body ? ` (${f.body.length}\uC790)` : " (\uBE44\uC5B4 \uC788\uC74C)"),
          title: f.id
        });
        name.addEventListener("click", () => openField(f));
        const row = el("div", { class: "treerow lorecard" }, [name]);
        if (f.changed) row.appendChild(el("span", { class: "badge warn", text: "\uC218\uC815" }));
        treeMount4.appendChild(row);
      }
    }
    if (!items3.length) {
      treeMount4.appendChild(el("div", {
        class: "hint",
        style: { padding: "8px" },
        text: "\uC774 \uBD07\uC758 Regex \uC2A4\uD06C\uB9BD\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
      }));
      return;
    }
    setToolbarSearch(filterText3, (v) => {
      filterText3 = v;
      drawTree4();
      refocusSearch(null);
    }, "\uCC3E\uAE30 (\uC774\uB984\xB7\uD328\uD134\xB7\uBCF8\uBB38)");
    const needle = filterText3.trim().toLowerCase();
    const shown = items3.map((s, i) => ({ s, i })).filter(({ s }) => {
      if (!needle) return true;
      const e = s.entry;
      return [e.comment, e.in, e.out].some((v) => String(v ?? "").toLowerCase().includes(needle));
    });
    treeMount4.appendChild(el("div", {
      class: "treescope",
      text: `\uC2A4\uD06C\uB9BD\uD2B8 \xB7 ${needle ? `${shown.length}/${items3.length}` : items3.length} \xB7 \uC704\uC5D0\uC11C \uC544\uB798 \uC21C\uC11C\uB85C \uC801\uC6A9`
    }));
    for (const { s, i } of shown) {
      const e = s.entry;
      const name = el("button", {
        class: "treefile" + (s.id === openId3 ? " on" : ""),
        text: `${i + 1}. ${titleOf2(s)}`,
        title: s.id
      });
      name.addEventListener("click", () => open3(s));
      const move = async (to) => {
        try {
          await state.moveScript(s.id, to);
          await refresh5();
        } catch (err) {
          notice6("\uC21C\uC11C\uB97C \uBC14\uAFB8\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg11(err), "err");
        }
      };
      const up = el("button", { class: "ghost tiny movebtn", text: "\u2191", title: "\uC704\uB85C" });
      const down = el("button", { class: "ghost tiny movebtn", text: "\u2193", title: "\uC544\uB798\uB85C" });
      up.disabled = i <= 0;
      down.disabled = i >= items3.length - 1;
      up.addEventListener("click", () => void move(i - 1));
      down.addEventListener("click", () => void move(i + 1));
      const row = el("div", { class: "treerow lorecard" }, [name]);
      const size = String(e.out ?? "").length;
      if (size > 2e3) row.appendChild(el("span", { class: "hint", text: `${Math.round(size / 1e3)}k\uC790` }));
      if (s.origin !== "original") {
        row.appendChild(el("span", { class: "badge warn", text: s.origin === "added" ? "\uCD94\uAC00" : "\uC218\uC815" }));
      }
      row.appendChild(up);
      row.appendChild(down);
      treeMount4.appendChild(row);
    }
  }
  function openField(f) {
    if (!viewMount4) return;
    openId3 = f.id;
    for (const b of Array.from(document.querySelectorAll(".tree .treefile"))) {
      b.classList.toggle("on", b.title === f.id);
    }
    const body = el("textarea", {
      class: "codearea",
      value: f.body,
      style: { minHeight: "380px" }
    });
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await state.saveCardField(f.id, body.value);
        notice6("\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.", "ok");
        await refresh5();
        const fresh = bgFields.find((x) => x.id === f.id);
        if (fresh) openField(fresh);
      } catch (err) {
        notice6("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg11(err), "err");
      } finally {
        save.disabled = false;
      }
    });
    clear(viewMount4);
    viewMount4.appendChild(el("div", { class: "card" }, [
      el("h2", {}, [
        el("span", { text: BG_LABEL[f.field] }),
        el("span", { class: "spacer" }),
        focusButton(body, BG_LABEL[f.field], { code: true })
      ]),
      el("div", { class: "hint", text: "CSS\uB294 \uBCF4\uD1B5 \uC5EC\uAE30(\uBC31\uADF8\uB77C\uC6B4\uB4DC HTML)\uC758 <style> \uC548\uC5D0 \uB4E4\uC5B4\uAC11\uB2C8\uB2E4." }),
      el("label", { class: "field" }, [body]),
      f.changed ? diffCard(f.original, f.body, { code: true }) : null,
      el("div", { class: "row" }, [save])
    ]));
  }
  function open3(s) {
    if (!viewMount4) return;
    openId3 = s.id;
    for (const b of Array.from(document.querySelectorAll(".tree .treefile"))) {
      b.classList.toggle("on", b.title === s.id);
    }
    const e = s.entry;
    const comment = el("input", { value: String(e.comment ?? "") });
    const curType = String(e.type ?? "editdisplay");
    const typeNames = TYPES.includes(curType) ? TYPES : [...TYPES, curType];
    const type = el("select", {}, typeNames.map((t) => {
      const o = el("option", { value: t, text: TYPE_LABEL[t] || t });
      if (t === curType) o.setAttribute("selected", "");
      return o;
    }));
    const inPat = el("textarea", {
      class: "codearea",
      value: String(e.in ?? ""),
      style: { minHeight: "60px" }
    });
    const outText = el("textarea", {
      class: "codearea",
      value: String(e.out ?? ""),
      style: { minHeight: "260px" }
    });
    const flag = el("input", { value: String(e.flag ?? ""), placeholder: "\uC608: g" });
    const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await state.saveScript(s.id, {
          ...e,
          comment: comment.value,
          type: type.value,
          in: inPat.value,
          out: outText.value,
          ...flag.value ? { flag: flag.value } : {}
        });
        notice6("\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.", "ok");
        await refresh5();
        const fresh = items3.find((x) => x.id === s.id);
        if (fresh) open3(fresh);
      } catch (err) {
        notice6("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg11(err), "err");
      } finally {
        save.disabled = false;
      }
    });
    const del = el("button", { class: "ghost" });
    armed(del, "\uC0AD\uC81C", "\uC815\uB9D0 \uC9C0\uC6B8\uAE4C\uC694?", async () => {
      try {
        await state.deleteScript(s.id);
        openId3 = "";
        if (viewMount4) clear(viewMount4);
        await refresh5();
      } catch (err) {
        notice6("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg11(err), "err");
      }
    });
    const orig = s.origin === "edited" && s.original ? s.original : null;
    const diff = orig ? diffCard(String(orig.out ?? ""), String(e.out ?? ""), { code: true }) : null;
    const small = [];
    if (orig) {
      if (String(orig.in ?? "") !== String(e.in ?? "")) small.push(`\uCC3E\uAE30: ${String(orig.in ?? "")} \u2192 ${String(e.in ?? "")}`);
      if (String(orig.type ?? "") !== String(e.type ?? "")) small.push(`\uC885\uB958: ${String(orig.type ?? "")} \u2192 ${String(e.type ?? "")}`);
      if (String(orig.comment ?? "") !== String(e.comment ?? "")) small.push(`\uC774\uB984: ${String(orig.comment ?? "")} \u2192 ${String(e.comment ?? "")}`);
    }
    clear(viewMount4);
    viewMount4.appendChild(el("div", { class: "card" }, [
      el("h2", {}, [
        el("span", { text: "Regex \uC2A4\uD06C\uB9BD\uD2B8" }),
        el("span", { class: "spacer" }),
        focusButton(outText, String(e.comment || "Regex \uC2A4\uD06C\uB9BD\uD2B8") + " \u2014 \uBC14\uAFB8\uAE30 (out)", { code: true })
      ]),
      el("label", { class: "field" }, [el("span", { text: "\uC774\uB984 (comment)" }), comment]),
      el("label", { class: "field" }, [el("span", { text: "\uC885\uB958 (type)" }), type]),
      el("label", { class: "field" }, [
        el("span", { text: "\uCC3E\uAE30 (in) \u2014 \uC815\uADDC\uC2DD" }),
        inPat
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "\uBC14\uAFB8\uAE30 (out) \u2014 background HTML\uB3C4 \uC5EC\uAE30\uC5D0 \uB4E4\uC5B4\uAC11\uB2C8\uB2E4" }),
        outText
      ]),
      el("label", { class: "field" }, [el("span", { text: "\uD50C\uB798\uADF8 (flag)" }), flag]),
      small.length ? el("div", { class: "hint diffmeta", text: "\uAE30\uC900\uC120\uACFC \uB2E4\uB978 \uD56D\uBAA9 \u2014 " + small.join(" \xB7 ") }) : null,
      diff,
      el("div", { class: "row" }, [save, del])
    ]));
  }
  function msg11(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/tab-trigger.ts
  var built6 = false;
  var sideMount = null;
  var viewMount5 = null;
  var noticeMount7 = null;
  var items4 = [];
  var seenEpoch5 = -1;
  var seenKey3 = "";
  function renderTriggerTab(mount) {
    if (!state.botKey) {
      clear(mount);
      built6 = false;
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \uD328\uB110\uC744 \uC5F0 \uBD07\uC774 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4." })
      ]));
      return;
    }
    if (!built6 || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      sideMount = el("div", { class: "tree" });
      pane.left.appendChild(sideMount);
      noticeMount7 = el("div");
      viewMount5 = el("div", { class: "pad" });
      pane.centre.appendChild(noticeMount7);
      pane.centre.appendChild(viewMount5);
      mount.appendChild(pane.root);
      built6 = true;
      seenEpoch5 = state.epoch;
      seenKey3 = state.botKey;
      void refresh6();
    } else if (seenEpoch5 !== state.epoch || seenKey3 !== state.botKey) {
      seenEpoch5 = state.epoch;
      seenKey3 = state.botKey;
      void refresh6();
    }
    bindAgent({ notice: notice7 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function notice7(text2, kind = "") {
    if (!noticeMount7) return;
    clear(noticeMount7);
    noticeMount7.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount7) clear(noticeMount7);
    }, 9e3);
  }
  async function refresh6() {
    try {
      items4 = await state.cardScripts("triggerscript");
    } catch (e) {
      items4 = [];
      notice7("\uD2B8\uB9AC\uAC70\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg12(e), "err");
    }
    drawSide();
    drawView();
  }
  function firstEffectType() {
    const e = items4[0]?.entry;
    const first = e && Array.isArray(e.effect) ? e.effect[0] : null;
    return first && typeof first.type === "string" ? first.type : "";
  }
  function modeOf() {
    if (!items4.length) return "none";
    const t = firstEffectType();
    if (t === "triggerlua") return "lua";
    if (t === "v2Header") return "v2";
    return "v1";
  }
  function drawSide() {
    if (!sideMount) return;
    clear(sideMount);
    const mode2 = modeOf();
    const btn = (label, on, run) => {
      const b = el("button", { class: "modebtn" + (on ? " on" : ""), text: label });
      if (on) return b;
      if (items4.length) armed(b, label, "\uC815\uB9D0 \uBC14\uAFC0\uAE4C\uC694? (\uC9C0\uAE08 \uD2B8\uB9AC\uAC70\uAC00 \uC9C0\uC6CC\uC9D1\uB2C8\uB2E4)", run);
      else b.addEventListener("click", run);
      return b;
    };
    const row = el("div", { class: "row", style: { padding: "6px" } });
    if (mode2 === "v1") row.appendChild(btn("V1", true, () => {
    }));
    row.appendChild(btn("V2", mode2 === "v2", () => void switchMode("v2")));
    row.appendChild(btn("Lua", mode2 === "lua", () => void switchMode("lua")));
    sideMount.appendChild(row);
    sideMount.appendChild(el("div", { class: "hint", style: { padding: "0 8px" }, text: mode2 === "lua" ? "Lua \uC2A4\uD06C\uB9BD\uD2B8 \uD55C \uAC1C\uAC00 \uC774 \uBD07\uC758 \uD2B8\uB9AC\uAC70\uC785\uB2C8\uB2E4." : mode2 === "v2" ? `V2 \uBE14\uB85D \uD504\uB85C\uADF8\uB7A8 \xB7 \uC774\uBCA4\uD2B8 ${Math.max(0, items4.length - 1)}\uAC1C` : mode2 === "v1" ? "V1 (\uAD6C\uD615) \uD2B8\uB9AC\uAC70\uC785\uB2C8\uB2E4." : "\uD2B8\uB9AC\uAC70\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uBAA8\uB4DC\uB97C \uACE8\uB77C \uC2DC\uC791\uD569\uB2C8\uB2E4." }));
  }
  async function switchMode(to) {
    const mode2 = modeOf();
    if (mode2 === to) return;
    try {
      for (const it of items4) await state.deleteScript(it.id);
      if (to === "lua") {
        await state.addScript("triggerscript", {
          comment: "",
          type: "start",
          conditions: [],
          effect: [{ type: "triggerlua", code: "" }]
        });
      } else {
        await state.addScript("triggerscript", {
          comment: "",
          type: "manual",
          conditions: [],
          effect: [{ type: "v2Header", code: "", indent: 0 }]
        });
        await state.addScript("triggerscript", {
          comment: "New Event",
          type: "manual",
          conditions: [],
          effect: []
        });
      }
      await refresh6();
      notice7("\uBAA8\uB4DC\uB97C \uBC14\uAFE8\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.", "ok");
    } catch (e) {
      notice7("\uBAA8\uB4DC\uB97C \uBC14\uAFB8\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg12(e), "err");
    }
  }
  function drawView() {
    if (!viewMount5) return;
    clear(viewMount5);
    const mode2 = modeOf();
    if (mode2 === "none") {
      viewMount5.appendChild(el("div", { class: "empty", text: "\uD2B8\uB9AC\uAC70\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uC67C\uCABD\uC5D0\uC11C V2 \uB610\uB294 Lua \uB97C \uACE0\uB974\uBA74 RisuAI \uC640 \uAC19\uC740 \uCD08\uAE30 \uC0C1\uD0DC\uB85C \uC2DC\uC791\uD569\uB2C8\uB2E4." }));
      return;
    }
    if (mode2 === "lua") {
      const s = items4[0];
      const e = s.entry;
      const first = Array.isArray(e.effect) ? e.effect[0] : {};
      const body = el("textarea", {
        class: "codearea",
        value: String(first.code ?? ""),
        style: { minHeight: "520px" },
        spellcheck: "false"
      });
      const save = el("button", { class: "primary", text: "\uC800\uC7A5" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const effect = Array.isArray(e.effect) ? e.effect.slice() : [{}];
          effect[0] = { ...effect[0], type: "triggerlua", code: body.value };
          await state.saveScript(s.id, { ...e, effect });
          notice7("\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.", "ok");
          await refresh6();
        } catch (err) {
          notice7("\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg12(err), "err");
        } finally {
          save.disabled = false;
        }
      });
      const origFirst = s.origin === "edited" && s.original && Array.isArray(s.original.effect) ? s.original.effect[0] : void 0;
      const diff = origFirst ? diffCard(String(origFirst.code ?? ""), String(first.code ?? ""), { code: true }) : null;
      viewMount5.appendChild(el("div", { class: "card" }, [
        el("h2", {}, [
          el("span", { text: "Lua" + (s.origin !== "original" ? " \xB7 \uC218\uC815\uB428" : "") }),
          el("span", { class: "spacer" }),
          focusButton(body, "Lua \uD2B8\uB9AC\uAC70", { code: true })
        ]),
        body,
        diff,
        el("div", { class: "row", style: { marginTop: "8px" } }, [save]),
        el("div", { class: "hint", style: { marginTop: "6px" }, text: "RisuAI \uC758 \uD2B8\uB9AC\uAC70 \uD3B8\uC9D1\uAE30\uC640 \uAC19\uC740 Lua \uC2A4\uD06C\uB9BD\uD2B8 \uD55C \uAC1C\uC785\uB2C8\uB2E4. \uC774\uBCA4\uD2B8 \uB4F1\uB85D\uC740 \uC2A4\uD06C\uB9BD\uD2B8 \uC548\uC5D0\uC11C \uD569\uB2C8\uB2E4 (listenEdit, onStart \uB4F1)." })
      ]));
      return;
    }
    const rows = items4.filter((s, i) => !(mode2 === "v2" && i === 0)).map((s) => {
      const e = s.entry;
      const n = Array.isArray(e.effect) ? e.effect.length : 0;
      const c = Array.isArray(e.conditions) ? e.conditions.length : 0;
      const del = el("button", { class: "ghost tiny" });
      armed(del, "\uC0AD\uC81C", "\uC815\uB9D0?", async () => {
        try {
          await state.deleteScript(s.id);
          await refresh6();
        } catch (err) {
          notice7(msg12(err), "err");
        }
      });
      return el("div", { class: "verrow" }, [
        el("div", { class: "grow" }, [
          el("div", { text: String(e.comment || "(\uC774\uB984 \uC5C6\uC74C)") }),
          el("div", { class: "hint", text: `${String(e.type || "manual")} \xB7 \uC870\uAC74 ${c} \xB7 \uD6A8\uACFC ${n}` + (s.origin !== "original" ? ` \xB7 ${s.origin}` : "") })
        ]),
        del
      ]);
    });
    viewMount5.appendChild(el("div", { class: "card" }, [
      el("h2", { text: mode2 === "v2" ? "\uD2B8\uB9AC\uAC70 V2 (\uBE14\uB85D)" : "\uD2B8\uB9AC\uAC70 V1 (\uAD6C\uD615)" }),
      el("div", { class: "notice", text: mode2 === "v2" ? "\uBE14\uB85D \uD504\uB85C\uADF8\uB7A8\uC740 RisuAI \uC758 \uD2B8\uB9AC\uAC70 \uD3B8\uC9D1\uAE30\uC5D0\uC11C \uD3B8\uC9D1\uD569\uB2C8\uB2E4. \uC5EC\uAE30\uC11C\uB294 \uC774\uBCA4\uD2B8 \uBAA9\uB85D\uC744 \uBCF4\uACE0 \uC9C0\uC6B8 \uC218\uB9CC \uC788\uC2B5\uB2C8\uB2E4. \uC5D0\uC774\uC804\uD2B8\uB294 run_python \uC73C\uB85C card_scripts \uC758 entry_json \uC744 \uC77D\uC5B4 \uBD84\uC11D\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4." : "V1 \uD2B8\uB9AC\uAC70\uB294 RisuAI \uC5D0\uC11C\uB3C4 \uB354 \uC774\uC0C1 \uAD8C\uC7A5\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. V2 \uB098 Lua \uB85C \uBC14\uAFB8\uB294 \uAC83\uC744 \uAD8C\uD569\uB2C8\uB2E4." }),
      ...rows.length ? rows : [el("div", { class: "hint", text: "\uC774\uBCA4\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." })]
    ]));
  }
  function msg12(e) {
    return e instanceof Error ? e.message : String(e);
  }

  // src/ui/chatbar.ts
  var bar = null;
  var applyBtn = null;
  var applyBadge = null;
  var summaryEl = null;
  var noticeMount8 = null;
  function buildChatBar(notice9) {
    noticeMount8 = notice9;
    applyBadge = el("span", { class: "badge warn applybadge", style: { display: "none" } });
    applyBtn = el("button", {
      class: "tool",
      dataset: { tool: "apply" },
      title: "RisuAI\uC5D0 \uBC18\uC601 \xB7 \uBCF5\uC0AC\uBCF8 \uC800\uC7A5 \xB7 \uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30"
    }, [
      el("span", { class: "glyph", text: TOOL.apply }),
      el("span", { class: "tool-label", text: "\uBC18\uC601" }),
      applyBadge
    ]);
    applyBtn.addEventListener("click", () => {
      if (applyBtn) openApply(applyBtn);
    });
    const snap = el("button", {
      class: "tool",
      dataset: { tool: "snapshot" },
      title: "\uC9C0\uAE08 \uC0C1\uD0DC(\uD134\xB7\uB85C\uC5B4\uBD81\xB7\uC7A5\uAE30\uAE30\uC5B5)\uB97C \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uC800\uC7A5\uD569\uB2C8\uB2E4"
    }, [
      el("span", { class: "glyph", text: TOOL.snapshot }),
      el("span", { class: "tool-label", text: "\uC2A4\uB0C5\uC0F7" })
    ]);
    snap.addEventListener("click", () => {
      openSnapshotName(snap, "\uC218\uB3D9", async (label) => {
        await state.checkpoint(label);
        shellNotice("\uC2A4\uB0C5\uC0F7\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \u{1F558} \uBC84\uC804\uC5D0\uC11C \uC774\uB984\uC744 \uBC14\uAFB8\uAC70\uB098 \uB418\uB3CC\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.", "ok");
      });
    });
    const versions = el("button", {
      class: "tool",
      dataset: { tool: "versions" },
      title: "\uC2A4\uB0C5\uC0F7 \uBAA9\uB85D\uC5D0\uC11C \uB418\uB3CC\uB9AC\uAE30"
    }, [
      el("span", { class: "glyph", text: TOOL.versions }),
      el("span", { class: "tool-label", text: "\uBC84\uC804" })
    ]);
    versions.addEventListener("click", () => void openVersions(versions));
    summaryEl = el("span", { class: "dim changesum", title: "\uC774 \uCC57\uC5D0\uC11C \uC544\uC9C1 RisuAI\uC5D0 \uC4F0\uC9C0 \uC54A\uC740 \uBCC0\uACBD" });
    bar = el("div", { class: "toolrow chatbar" }, [applyBtn, snap, versions, summaryEl]);
    refreshChatBar();
    return bar;
  }
  function refreshChatBar() {
    if (!bar || !summaryEl || !applyBadge) return;
    const c = state.changes;
    const parts = describe(c);
    const conflicts = c?.conflicts ?? 0;
    if (conflicts) parts.unshift(`\u26A0 \uCDA9\uB3CC ${conflicts}`);
    summaryEl.textContent = parts.length ? parts.join(" \xB7 ") : state.activeChatKey ? "\uBCC0\uACBD \uC5C6\uC74C" : "";
    const total = c?.total ?? 0;
    applyBadge.textContent = String(total);
    applyBadge.style.display = total ? "" : "none";
    applyBadge.classList.toggle("conflict", !!conflicts);
  }
  function describe(c) {
    if (!c) return [];
    const out = [];
    const t = c.turns;
    if (t.total) {
      const bits = [];
      if (t.edited) bits.push(`\uC218\uC815 ${t.edited}`);
      if (t.added) bits.push(`\uCD94\uAC00 ${t.added}`);
      if (t.removed) bits.push(`\uC0AD\uC81C ${t.removed}`);
      if (t.reordered) bits.push("\uC21C\uC11C \uBCC0\uACBD");
      out.push("\uD134 " + bits.join(" "));
    }
    const l = c.lore;
    if (l.total) {
      const bits = [];
      if (l.added) bits.push(`+${l.added}`);
      if (l.edited) bits.push(`~${l.edited}`);
      if (l.deleted) bits.push(`\u2212${l.deleted}`);
      out.push("\uB85C\uC5B4\uBD81 " + bits.join(" "));
    }
    if (c.memory.changed) out.push(`\uC7A5\uAE30\uAE30\uC5B5 ${c.memory.changed}`);
    if (c.memory.vars) out.push(`\uCC57 \uBCC0\uC218 ${c.memory.vars}`);
    const pending = (c.staged || 0) + (c.actions || 0);
    if (pending) out.push(`\uC81C\uC548 ${pending} \uB300\uAE30`);
    return out;
  }
  function shellNotice(text2, kind = "") {
    if (!noticeMount8) return;
    clear(noticeMount8);
    noticeMount8.appendChild(el("div", { class: "notice " + kind, text: text2 }));
    setTimeout(() => {
      if (noticeMount8) clear(noticeMount8);
    }, 9e3);
  }
  function msg13(e) {
    return e instanceof Error ? e.message : String(e);
  }
  function openApply(anchor) {
    const out = el("div", { class: "hint" });
    const body = el("div", { class: "applypop" });
    const close = popover(anchor, body);
    const lines = describe(state.changes);
    body.appendChild(el("div", { class: "hint", text: lines.length ? lines.join(" \xB7 ") : "\uBC18\uC601\uD560 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." }));
    if (state.changes?.warnings?.length) {
      for (const w of state.changes.warnings) body.appendChild(el("div", { class: "notice", text: w }));
    }
    const conflicts = state.changes?.conflicts ?? 0;
    if (conflicts) {
      const open4 = el("button", { class: "ghost tiny", text: `\uCDA9\uB3CC ${conflicts}\uAC74 \uC815\uB9AC` });
      open4.addEventListener("click", () => {
        close();
        openConflicts("chat", () => {
          void state.refreshChanges();
        });
      });
      body.appendChild(el("div", { class: "notice" }, [
        el("div", { text: `RisuAI \uCABD\uC5D0\uC11C\uB3C4 \uBC14\uB010 \uD56D\uBAA9\uC774 ${conflicts}\uAC74 \uC788\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 \uC815\uB9AC\uD574 \uC8FC\uC138\uC694.` }),
        el("div", { class: "row", style: { marginTop: "6px" } }, [open4])
      ]));
    }
    const apply = el("button", { class: "primary", text: "RisuAI\uC5D0 \uBC18\uC601" });
    apply.disabled = conflicts > 0;
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      try {
        const r = await state.writeBack();
        if (r.mode === "noop" && !r.lore && !r.memory) {
          out.textContent = "\uBC18\uC601\uD560 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
        } else {
          await state.commit("\uBC18\uC601 \uC9C1\uC804");
          const bits = [];
          if (r.mode !== "noop") bits.push(`${r.mode === "replace" ? "\uC804\uCCB4 \uAD50\uCCB4" : "\uBCF8\uBB38 \uC218\uC815"} ${r.applied}\uAC74`);
          if (r.lore) bits.push(`\uB85C\uC5B4\uBD81 ${r.lore}\uAC74`);
          if (r.memory) bits.push(`\uC7A5\uAE30\uAE30\uC5B5 ${r.memory}\uAC74`);
          out.textContent = bits.join(" \xB7 ");
          shellNotice(`RisuAI\uC5D0 \uBC18\uC601\uD558\uACE0 \uB2E4\uC2DC \uC77D\uC5C8\uC2B5\uB2C8\uB2E4 (${bits.join(" \xB7 ")}).`, "ok");
          close();
        }
        for (const w of r.warnings) shellNotice(w);
      } catch (e) {
        const m = msg13(e);
        out.textContent = m;
        void clientLog("error", "writeBack failed", { error: m });
        shellNotice(
          e instanceof HostError && e.code === "changed" ? m + ' \u2014 "\uB2E4\uC2DC \uBD88\uB7EC\uC624\uAE30"\uB97C \uB204\uB978 \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694' : "\uBC18\uC601\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + m,
          "err"
        );
      } finally {
        apply.disabled = (state.changes?.conflicts ?? 0) > 0;
      }
    });
    const copy = el("button", { text: "\uBCF5\uC0AC\uBCF8\uC73C\uB85C \uC800\uC7A5" });
    copy.addEventListener("click", async () => {
      const name = (state.activeChat?.name || "chat") + " (Risu Hina)";
      copy.disabled = true;
      try {
        await state.saveCopy(name);
        await state.checkpoint("\uBCF5\uC0AC\uBCF8 \uC800\uC7A5 \uC9C1\uD6C4");
        await state.loadTurns();
        shellNotice(`\uBCF5\uC0AC\uBCF8 "${name}" \uC744 \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4. \uB85C\uC5B4\uBD81\uACFC \uC7A5\uAE30\uAE30\uC5B5\uB3C4 \uD568\uAED8 \uB2F4\uACBC\uC2B5\uB2C8\uB2E4. \uC774 \uCC57\uC758 \uC218\uC815\uC740 \uC544\uC9C1 \uBC18\uC601 \uC804 \uC0C1\uD0DC\uB85C \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4.`, "ok");
        close();
      } catch (e) {
        void clientLog("error", "saveCopy failed", { error: msg13(e) });
        shellNotice("\uBCF5\uC0AC\uBCF8 \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg13(e), "err");
      } finally {
        copy.disabled = false;
      }
    });
    const reset = el("button", { class: "ghost" });
    armed(reset, "\uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30", "\uC815\uB9D0 \uB418\uB3CC\uB9B4\uAE4C\uC694?", async () => {
      try {
        await state.reset();
        shellNotice("\uC791\uC5C5\uBCF8\uC744 \uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4.", "ok");
        close();
      } catch (e) {
        shellNotice("\uB418\uB3CC\uB9AC\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg13(e), "err");
      }
    });
    body.appendChild(el("div", { class: "row" }, [apply]));
    body.appendChild(el("div", { class: "row" }, [copy]));
    body.appendChild(el("div", { class: "row" }, [reset]));
    body.appendChild(out);
    body.appendChild(el("div", {
      class: "hint",
      text: "\uD134\xB7\uB85C\uC5B4\uBD81\xB7\uC7A5\uAE30\uAE30\uC5B5\uC774 \uD55C \uBC88\uC5D0 \uC4F0\uC785\uB2C8\uB2E4. \uC131\uACF5\uD558\uBA74 \uADF8 \uC0C1\uD0DC\uAC00 \uC0C8 \uAE30\uC900\uC120\uC774 \uB418\uBA74\uC11C \uC218\uC815 \uD45C\uC2DC\uAC00 \uC0AC\uB77C\uC9D1\uB2C8\uB2E4."
    }));
  }
  async function openVersions(anchor) {
    const body = el("div", { class: "verlist" }, [el("div", { class: "hint", text: "\uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" })]);
    const close = popover(anchor, body);
    try {
      const cps = await state.checkpoints();
      clear(body);
      if (!cps.length) {
        body.appendChild(el("div", { class: "hint", text: "\uC544\uC9C1 \uC2A4\uB0C5\uC0F7\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \u{1F516} \uC2A4\uB0C5\uC0F7 \uBC84\uD2BC\uC73C\uB85C \uC800\uC7A5\uD574 \uC8FC\uC138\uC694." }));
        return;
      }
      body.appendChild(el("div", { class: "verrow" }, [
        el("div", { class: "grow" }, [
          el("div", {}, [el("span", { text: "\uC9C0\uAE08 \uD3B8\uC9D1 \uC911\uC778 \uC0C1\uD0DC " }), el("span", { class: "badge now", text: "\uD604\uC7AC" })]),
          el("div", { class: "hint", text: "\uC2A4\uB0C5\uC0F7\uC774 \uC544\uB2D9\uB2C8\uB2E4. \uC544\uB798\uB294 \uC624\uB798\uB41C \uC21C\uC774 \uC544\uB2C8\uB77C \uCD5C\uADFC \uC21C\uC785\uB2C8\uB2E4." })
        ])
      ]));
      for (const [idx, c] of cps.slice(0, 12).entries()) {
        const b = el("button", { class: "ghost tiny", text: "\uB418\uB3CC\uB9AC\uAE30", title: "\uC791\uC5C5\uBCF8\uC744 \uC774 \uC2DC\uC810\uC73C\uB85C \uB418\uB3CC\uB9BD\uB2C8\uB2E4 (\uC9C1\uC804 \uC0C1\uD0DC\uB3C4 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uB0A8\uC2B5\uB2C8\uB2E4)" });
        b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            const r = await state.restore(c.id);
            close();
            shellNotice(
              r.lore === null && r.memory === null ? "\uD134\uC744 \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4 (\uC774 \uC2A4\uB0C5\uC0F7\uC740 \uD134\uB9CC \uB2F4\uACE0 \uC788\uC2B5\uB2C8\uB2E4). \uB418\uB3CC\uB9AC\uAE30 \uC9C1\uC804 \uC0C1\uD0DC\uB3C4 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uB0A8\uACA8 \uB450\uC5C8\uC2B5\uB2C8\uB2E4." : "\uD134\xB7\uB85C\uC5B4\uBD81\xB7\uC7A5\uAE30\uAE30\uC5B5\uC744 \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4. \uB418\uB3CC\uB9AC\uAE30 \uC9C1\uC804 \uC0C1\uD0DC\uB3C4 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uB0A8\uACA8 \uB450\uC5C8\uC2B5\uB2C8\uB2E4.",
              "ok"
            );
          } catch (e) {
            shellNotice("\uBCF5\uC6D0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg13(e), "err");
          }
        });
        const title = el("div", {}, [
          el("span", { text: c.label || "(\uBB34\uC81C)" }),
          idx === 0 ? el("span", { class: "badge", style: { marginLeft: "6px" }, text: "\uCD5C\uC2E0 \uC2A4\uB0C5\uC0F7" }) : null
        ]);
        const ren = el("button", { class: "ghost tiny", text: "\u270E", title: "\uC774\uB984 \uBC14\uAFB8\uAE30" });
        ren.addEventListener("click", () => {
          openSnapshotName(ren, c.label || "", async (label) => {
            await state.renameCheckpoint(c.id, label);
            title.firstChild.textContent = label;
          });
        });
        const row = el("div", { class: "verrow" });
        const del = el("button", { class: "ghost tiny", title: "\uC774 \uC2A4\uB0C5\uC0F7 \uC0AD\uC81C" });
        armed(del, "\u2715", "\uC0AD\uC81C \uD655\uC778", async () => {
          row.classList.add("deleting");
          del.disabled = true;
          try {
            await state.deleteCheckpoint(c.id);
            row.remove();
          } catch (e) {
            row.classList.remove("deleting");
            del.disabled = false;
            shellNotice("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg13(e), "err");
          }
        });
        row.append(
          el("div", { class: "grow" }, [
            title,
            el("div", { class: "hint", text: `${c.message_count}\uD134 \xB7 ${fmtTime(c.created_at * 1e3)}` })
          ]),
          ren,
          b,
          del
        );
        body.appendChild(row);
      }
      if (cps.length > 12) body.appendChild(el("div", { class: "hint", text: `\uADF8 \uC678 ${cps.length - 12}\uAC1C` }));
      body.appendChild(snapshotCleanup(cps.length, async (keep) => {
        const n = await state.clearCheckpoints(keep);
        close();
        shellNotice(`\uC2A4\uB0C5\uC0F7 ${n}\uAC1C\uB97C \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4.`, "ok");
      }));
    } catch (e) {
      clear(body);
      body.appendChild(el("div", { class: "hint", text: msg13(e) }));
    }
  }
  function snapshotCleanup(total, run) {
    const keep5 = el("button", { class: "ghost tiny", title: "\uCD5C\uADFC 5\uAC1C\uB9CC \uB0A8\uAE30\uACE0 \uC9C0\uC6C1\uB2C8\uB2E4" });
    const all = el("button", { class: "ghost tiny", title: "\uC2A4\uB0C5\uC0F7\uC744 \uC804\uBD80 \uC9C0\uC6C1\uB2C8\uB2E4" });
    const wrap = el("div", { class: "row", style: { marginTop: "8px", justifyContent: "flex-end" } }, [
      el("span", { class: "hint grow", text: `\uC2A4\uB0C5\uC0F7 ${total}\uAC1C` }),
      total > 5 ? keep5 : null,
      all
    ]);
    armed(keep5, "\uCD5C\uADFC 5\uAC1C\uB9CC \uB0A8\uAE30\uAE30", "\uC815\uB9D0?", async () => {
      try {
        await run(5);
      } catch (e) {
        shellNotice("\uC815\uB9AC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg13(e), "err");
      }
    });
    armed(all, "\uC804\uBD80 \uC0AD\uC81C", "\uC815\uB9D0 \uC804\uBD80?", async () => {
      try {
        await run(0);
      } catch (e) {
        shellNotice("\uC815\uB9AC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg13(e), "err");
      }
    });
    return wrap;
  }
  function openSnapshotName(anchor, initial, save) {
    const input = el("input", { value: initial, placeholder: "\uC2A4\uB0C5\uC0F7 \uC774\uB984 (\uC608: 3\uC7A5 \uC2DC\uC791 \uC804)" });
    const ok = el("button", { class: "primary tiny", text: "\uC800\uC7A5" });
    const cancel = el("button", { class: "ghost tiny", text: "\uCDE8\uC18C" });
    const out = el("div", { class: "hint" });
    const body = el("div", { class: "verlist" }, [
      el("label", { class: "field" }, [el("span", { text: "\uC2A4\uB0C5\uC0F7 \uC774\uB984" }), input]),
      el("div", { class: "row" }, [ok, cancel]),
      out
    ]);
    const close = popover(anchor, body);
    cancel.addEventListener("click", close);
    const submit = async () => {
      const label = input.value.trim();
      if (!label) {
        out.textContent = "\uC774\uB984\uC744 \uC785\uB825\uD574 \uC8FC\uC138\uC694.";
        return;
      }
      ok.disabled = true;
      try {
        await save(label);
        close();
      } catch (e) {
        out.textContent = msg13(e);
        ok.disabled = false;
      }
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  // src/ui/botbar.ts
  var bar2 = null;
  var applyBtn2 = null;
  var applyBadge2 = null;
  var summaryEl2 = null;
  function applyBlockReason() {
    if (!state.isLiveBot) {
      return "RisuAI\uC5D0\uC11C \uC774 \uBD07\uC744 \uC120\uD0DD\uD574\uC57C \uBC18\uC601\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4";
    }
    if (state.botChanges && !state.botChanges.full) {
      return "\uAD6C\uBC84\uC804 \uC5C5\uB85C\uB4DC \uC0C1\uD0DC\uC785\uB2C8\uB2E4. \uD328\uB110\uC744 \uB2EB\uC558\uB2E4 \uB2E4\uC2DC \uC5F4\uC5B4 \uC8FC\uC138\uC694";
    }
    return null;
  }
  function buildBotBar() {
    applyBadge2 = el("span", { class: "badge warn applybadge", style: { display: "none" } });
    applyBtn2 = el("button", {
      class: "tool",
      dataset: { tool: "card-apply" },
      title: "\uCE74\uB4DC\uB97C RisuAI\uC5D0 \uBC18\uC601 \xB7 \uBCF5\uC81C \uBD07 \uC0DD\uC131 \xB7 \uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30"
    }, [
      el("span", { class: "glyph", text: TOOL.apply }),
      el("span", { class: "tool-label", text: "\uBC18\uC601" }),
      applyBadge2
    ]);
    applyBtn2.addEventListener("click", () => {
      if (applyBtn2) openApply2(applyBtn2);
    });
    const snap = el("button", {
      class: "tool",
      dataset: { tool: "card-snapshot" },
      title: "\uCE74\uB4DC\xB7\uBD07 \uB85C\uC5B4\uBD81\xB7\uC2A4\uD06C\uB9BD\uD2B8\uB97C \uBD07 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uC800\uC7A5\uD569\uB2C8\uB2E4"
    }, [
      el("span", { class: "glyph", text: TOOL.snapshot }),
      el("span", { class: "tool-label", text: "\uC2A4\uB0C5\uC0F7" })
    ]);
    snap.addEventListener("click", () => {
      openSnapshotName(snap, "\uC218\uB3D9", async (label) => {
        await state.cardCheckpoint(label);
        shellNotice("\uBD07 \uC2A4\uB0C5\uC0F7\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4. \u{1F558} \uBC84\uC804\uC5D0\uC11C \uC774\uB984\uC744 \uBC14\uAFB8\uAC70\uB098 \uB418\uB3CC\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.", "ok");
      });
    });
    const versions = el("button", {
      class: "tool",
      dataset: { tool: "card-versions" },
      title: "\uBD07 \uC2A4\uB0C5\uC0F7 \uBAA9\uB85D\uC5D0\uC11C \uB418\uB3CC\uB9AC\uAE30"
    }, [
      el("span", { class: "glyph", text: TOOL.versions }),
      el("span", { class: "tool-label", text: "\uBC84\uC804" })
    ]);
    versions.addEventListener("click", () => void openVersions2(versions));
    charxBtn = el("button", {
      class: "tool",
      dataset: { tool: "card-charx" },
      title: "\uC791\uC5C5\uBCF8 \uCE74\uB4DC\uC640 \uC2A4\uD1A0\uC5B4\uC758 \uC5D0\uC14B\uC73C\uB85C charx \uD30C\uC77C\uC744 \uB9CC\uB4ED\uB2C8\uB2E4"
    }, [
      el("span", { class: "glyph", text: TOOL.export }),
      el("span", { class: "tool-label", text: "charx" })
    ]);
    charxBtn.addEventListener("click", () => {
      if (charxBtn) openCharx(charxBtn);
    });
    summaryEl2 = el("span", { class: "dim changesum", title: "\uC774 \uBD07\uC758 \uCE74\uB4DC\uC5D0\uC11C \uC544\uC9C1 RisuAI\uC5D0 \uC4F0\uC9C0 \uC54A\uC740 \uBCC0\uACBD" });
    bar2 = el("div", { class: "toolrow botbar" }, [applyBtn2, snap, versions, charxBtn, summaryEl2]);
    refreshBotBar();
    return bar2;
  }
  var charxBtn = null;
  function charxBlockReason() {
    return state.assetGateReason;
  }
  function openCharx(anchor) {
    const out = el("div", { class: "outbox" });
    const body = el("div", { class: "applypop" });
    const close = popover(anchor, body);
    const blocked = charxBlockReason();
    if (blocked) body.appendChild(el("div", { class: "notice", text: blocked }));
    const nameInput = el("input", {
      value: state.workspace?.characterName || "character",
      placeholder: "\uD30C\uC77C \uC774\uB984 (.charx)"
    });
    const build = el("button", { class: "primary", text: "charx \uB9CC\uB4E4\uAE30" });
    const buildAnyway = el("button", { class: "ghost", text: "\uBE60\uC9C4 \uC5D0\uC14B \uBE7C\uACE0 \uB9CC\uB4E4\uAE30" });
    build.disabled = !!blocked;
    buildAnyway.style.display = "none";
    const run = async (allowMissing) => {
      build.disabled = buildAnyway.disabled = true;
      clear(out);
      out.appendChild(el("div", { class: "hint", text: "\uB9CC\uB4DC\uB294 \uC911\uC785\uB2C8\uB2E4\u2026 \uC5D0\uC14B\uC774 \uB9CE\uC73C\uBA74 \uBA87 \uBD84 \uAC78\uB9BD\uB2C8\uB2E4." }));
      try {
        const r = await state.charxBuild({ allowMissing, name: nameInput.value.trim() });
        clear(out);
        shellNotice(`${r.file} \xB7 ${(r.size / 1048576).toFixed(1)}MB \xB7 \uC5D0\uC14B ${r.assets}\uAC1C` + (r.dropped ? ` (${r.dropped}\uAC1C \uC81C\uC678)` : "") + ` \u2014 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uD30C\uC77C \uD0ED\uC758 out/ \uC5D0\uC11C \uB0B4 PC\uC5D0 \uC800\uC7A5\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`, "ok");
        close();
      } catch (e) {
        clear(out);
        const missing = e.body?.missing;
        if (Array.isArray(missing) && missing.length) {
          out.appendChild(el("div", { class: "notice err", text: `\uC5D0\uC14B ${missing.length}\uAC1C\uAC00 \uC2A4\uD1A0\uC5B4\uC5D0 \uC5C6\uC5B4 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ` + missing.slice(0, 6).map((m) => m.name || m.type).join(", ") + (missing.length > 6 ? " \u2026" : "") }));
          buildAnyway.style.display = "";
        } else {
          out.appendChild(el("div", { class: "notice err", text: "charx \uB97C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg14(e) }));
        }
      } finally {
        build.disabled = !!charxBlockReason();
        buildAnyway.disabled = false;
      }
    };
    build.addEventListener("click", () => {
      void run(false);
    });
    buildAnyway.addEventListener("click", () => {
      void run(true);
    });
    body.appendChild(el("div", { class: "hint", text: "\uC791\uC5C5\uBCF8 \uCE74\uB4DC(\uBA54\uD0C0\xB7\uC778\uC0AC\uB9D0\xB7\uBD07 \uB85C\uC5B4\uBD81\xB7Regex\xB7\uD2B8\uB9AC\uAC70\xB7\uC5D0\uC14B \uC774\uB984)\uC640 \uC2A4\uD1A0\uC5B4\uC758 \uC774\uBBF8\uC9C0\uB85C charx \uB97C \uB9CC\uB4ED\uB2C8\uB2E4. \uBC18\uC601\uD558\uC9C0 \uC54A\uC740 \uD3B8\uC9D1\uB3C4 \uB4E4\uC5B4\uAC11\uB2C8\uB2E4. module.risum \uC5C6\uC774 card.json \uC5D0 \uC778\uB77C\uC778\uC73C\uB85C \uB2F4\uAE30\uBA70 RisuAI\xB7PocketRisu \uAC00 \uADF8\uB300\uB85C \uAC00\uC838\uC635\uB2C8\uB2E4." }));
    body.appendChild(el("div", { class: "row" }, [nameInput]));
    body.appendChild(el("div", { class: "row" }, [build, buildAnyway]));
    body.appendChild(out);
  }
  function refreshBotBar() {
    if (!bar2 || !summaryEl2 || !applyBadge2 || !applyBtn2) return;
    const c = state.botChanges;
    const parts = describe2(c);
    summaryEl2.textContent = parts.length ? parts.join(" \xB7 ") : state.botKey ? "\uBCC0\uACBD \uC5C6\uC74C" : "";
    const total = c?.total ?? 0;
    applyBadge2.textContent = String(total);
    applyBadge2.style.display = total ? "" : "none";
    const blocked = applyBlockReason();
    applyBtn2.classList.toggle("dimmed", !!blocked);
    if (charxBtn) {
      const cb = charxBlockReason();
      charxBtn.classList.toggle("dimmed", !!cb);
      charxBtn.title = cb ? cb : "\uC791\uC5C5\uBCF8 \uCE74\uB4DC\uC640 \uC2A4\uD1A0\uC5B4\uC758 \uC5D0\uC14B\uC73C\uB85C charx \uD30C\uC77C\uC744 \uB9CC\uB4ED\uB2C8\uB2E4";
    }
    applyBtn2.title = blocked ? blocked + " (\uBCF5\uC81C\xB7\uB418\uB3CC\uB9AC\uAE30\uB294 \uB20C\uB7EC\uC11C \uC4F8 \uC218 \uC788\uC2B5\uB2C8\uB2E4)" : "\uCE74\uB4DC\uB97C RisuAI\uC5D0 \uBC18\uC601 \xB7 \uBCF5\uC81C \uBD07 \uC0DD\uC131 \xB7 \uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30";
  }
  function describe2(c) {
    if (!c) return [];
    const out = [];
    if (c.fields) out.push(`\uBA54\uD0C0 ${c.fields}`);
    const g = c.greetings;
    if (g.total) out.push("\uC778\uC0AC\uB9D0 " + counts(g));
    const l = c.lore;
    if (l.total) out.push("\uB85C\uC5B4\uBD81 " + counts(l));
    if (c.customscript.total) out.push("Regex " + counts(c.customscript));
    if (c.triggerscript.total) out.push("\uD2B8\uB9AC\uAC70 " + counts(c.triggerscript));
    if (c.assetref && c.assetref.total) out.push("\uC5D0\uC14B " + counts(c.assetref));
    if (c.actions) out.push(`\uC81C\uC548 ${c.actions} \uB300\uAE30`);
    return out;
  }
  function counts(x) {
    const bits = [];
    if (x.added) bits.push(`+${x.added}`);
    if (x.edited) bits.push(`~${x.edited}`);
    if (x.deleted) bits.push(`\u2212${x.deleted}`);
    return bits.join(" ");
  }
  function msg14(e) {
    return e instanceof Error ? e.message : String(e);
  }
  function openApply2(anchor) {
    const out = el("div", { class: "hint" });
    const body = el("div", { class: "applypop" });
    const close = popover(anchor, body);
    const lines = describe2(state.botChanges);
    body.appendChild(el("div", { class: "hint", text: lines.length ? lines.join(" \xB7 ") : "\uBC18\uC601\uD560 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." }));
    const blocked = applyBlockReason();
    if (blocked) body.appendChild(el("div", { class: "notice", text: blocked }));
    const conflicts = state.botChanges?.conflicts ?? 0;
    if (conflicts) {
      const open4 = el("button", { class: "ghost tiny", text: `\uCDA9\uB3CC ${conflicts}\uAC74 \uC815\uB9AC` });
      open4.addEventListener("click", () => {
        close();
        openConflicts("card", () => {
          void state.refreshBotChanges();
        });
      });
      body.appendChild(el("div", { class: "notice" }, [
        el("div", { text: `RisuAI \uCABD\uC5D0\uC11C\uB3C4 \uBC14\uB010 \uD56D\uBAA9\uC774 ${conflicts}\uAC74 \uC788\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 \uC815\uB9AC\uD574 \uC8FC\uC138\uC694.` }),
        el("div", { class: "row", style: { marginTop: "6px" } }, [open4])
      ]));
    }
    const apply = el("button", { class: "primary", text: "RisuAI\uC5D0 \uBC18\uC601" });
    apply.disabled = !!blocked || conflicts > 0;
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      try {
        const r = await state.cardWriteBack();
        if (r.mode === "noop") {
          out.textContent = "\uBC18\uC601\uD560 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
        } else {
          shellNotice("\uCE74\uB4DC\uB97C RisuAI\uC5D0 \uBC18\uC601\uD558\uACE0 \uB2E4\uC2DC \uC77D\uC5C8\uC2B5\uB2C8\uB2E4.", "ok");
          close();
        }
      } catch (e) {
        const m = msg14(e);
        out.textContent = m;
        void clientLog("error", "cardWriteBack failed", { error: m });
        shellNotice("\uCE74\uB4DC \uBC18\uC601\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + m, "err");
      } finally {
        apply.disabled = !!applyBlockReason() || (state.botChanges?.conflicts ?? 0) > 0;
      }
    });
    const nameInput = el("input", {
      value: (state.workspace?.characterName || "\uBD07") + " (\uBC31\uC5C5)",
      placeholder: "\uBC31\uC5C5 \uBD07 \uC774\uB984"
    });
    const saveNew = el("button", { text: "\uC0C8 \uBD07\uC73C\uB85C \uC800\uC7A5", title: "\uAE30\uC900\uC120(\uD3B8\uC9D1 \uC804, RisuAI \uAC00 \uC9C0\uAE08 \uB4E4\uACE0 \uC788\uB294 \uCE74\uB4DC)\uC744 \uBC31\uC5C5 \uBD07\uC73C\uB85C \uBCF5\uC81C\uD55C \uB4A4, \uD3B8\uC9D1 \uC911\uC778 \uB0B4\uC6A9\uC744 \uC774 \uBD07\uC5D0 \uBC18\uC601\uD558\uACE0 \uACC4\uC18D \uD3B8\uC9D1\uD569\uB2C8\uB2E4" });
    saveNew.disabled = !!blocked;
    saveNew.addEventListener("click", async () => {
      saveNew.disabled = true;
      const was = saveNew.textContent;
      saveNew.textContent = "\uC800\uC7A5 \uC911\u2026";
      out.textContent = "\uBC31\uC5C5 \uBD07\uC744 \uB9CC\uB4DC\uB294 \uC911\uC785\uB2C8\uB2E4. RisuAI \uAC00 db \uAD8C\uD55C\uC744 \uBB3C\uC73C\uBA74 \uD5C8\uC6A9\uD574 \uC8FC\uC138\uC694.";
      try {
        const backup = nameInput.value.trim() || "\uBC31\uC5C5";
        const r = await state.saveAsNewBot(backup);
        const said = `\uD604\uC7AC \uD3B8\uC9D1 \uC911\uC778 \uBD07\uC744 \uC0C8 \uBD07\uC73C\uB85C \uC800\uC7A5\uD558\uC600\uC2B5\uB2C8\uB2E4. \uAE30\uC874 \uBD07\uC740 \u201C${backup}\u201D \uC774\uB984\uC73C\uB85C \uBCF5\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.` + (r.mode === "noop" ? " (\uBC18\uC601\uD560 \uBCC0\uACBD\uC740 \uC5C6\uC5C8\uC2B5\uB2C8\uB2E4.)" : ` \uBCC0\uACBD ${r.applied}\uAC74\uC774 \uC774 \uBD07\uC5D0 \uBC18\uC601\uB418\uC5B4 \uC0C8 \uAE30\uC900\uC120\uC774 \uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
        shellNotice(said, "ok");
        clear(body);
        const ok = el("button", { class: "primary tiny", text: "\uB2EB\uAE30" });
        ok.addEventListener("click", close);
        body.appendChild(el("div", { class: "notice ok", text: "\u2714 " + said }));
        body.appendChild(el("div", { class: "hint", text: "\uBC31\uC5C5 \uBD07\uC740 RisuAI \uBD07 \uBAA9\uB85D\uC5D0 \uC0C8 \uCE90\uB9AD\uD130\uB85C \uC788\uC2B5\uB2C8\uB2E4. \uCC57\uB3C4 \uD568\uAED8 \uBCF5\uC0AC\uB418\uC5C8\uACE0 \uC5D0\uC14B\uC740 \uACF5\uC720\uD569\uB2C8\uB2E4." }));
        body.appendChild(el("div", { class: "row", style: { marginTop: "8px" } }, [ok]));
      } catch (e) {
        void clientLog("error", "saveAsNewBot failed", { error: msg14(e) });
        shellNotice("\uC0C8 \uBD07\uC73C\uB85C \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg14(e), "err");
        out.textContent = "\uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg14(e);
        saveNew.disabled = !!applyBlockReason();
        saveNew.textContent = was;
      }
    });
    const clone = saveNew;
    const reset = el("button", { class: "ghost" });
    armed(reset, "\uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30", "\uC815\uB9D0 \uB418\uB3CC\uB9B4\uAE4C\uC694?", async () => {
      try {
        await state.cardReset();
        shellNotice("\uCE74\uB4DC \uC791\uC5C5\uBCF8\uC744 \uAE30\uC900\uC120\uC73C\uB85C \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4.", "ok");
        close();
      } catch (e) {
        shellNotice("\uB418\uB3CC\uB9AC\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg14(e), "err");
      }
    });
    body.appendChild(el("div", { class: "row" }, [apply]));
    body.appendChild(el("div", { class: "row" }, [nameInput, clone]));
    body.appendChild(el("div", { class: "row" }, [reset]));
    body.appendChild(out);
    body.appendChild(el("div", {
      class: "hint",
      text: "\uBC18\uC601: \uBA54\uD0C0\xB7\uC778\uC0AC\uB9D0\xB7\uBD07 \uB85C\uC5B4\uBD81\xB7Regex\xB7\uD2B8\uB9AC\uAC70\uAC00 \uD55C \uBC88\uC5D0 \uC4F0\uC785\uB2C8\uB2E4. \uCC57\uC740 \uC808\uB300 \uAC74\uB4DC\uB9AC\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uC0C8 \uBD07\uC73C\uB85C \uC800\uC7A5: \uAE30\uC900\uC120(\uD3B8\uC9D1 \uC804 \uC0C1\uD0DC)\uC744 \uBC31\uC5C5 \uBD07(\uCC57 \uD3EC\uD568, \uC0C8 \uCE90\uB9AD\uD130)\uC73C\uB85C \uB0A8\uAE30\uACE0 \uD3B8\uC9D1\uBCF8\uC744 \uC774 \uBD07\uC5D0 \uBC18\uC601\uD574 \uC0C8 \uAE30\uC900\uC120\uC73C\uB85C \uC0BC\uC2B5\uB2C8\uB2E4. \uCC98\uC74C \uD55C \uBC88 db \uAD8C\uD55C \uD5C8\uC6A9\uC774 \uD544\uC694\uD569\uB2C8\uB2E4."
    }));
  }
  async function openVersions2(anchor) {
    const body = el("div", { class: "verlist" }, [el("div", { class: "hint", text: "\uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4\u2026" })]);
    const close = popover(anchor, body);
    try {
      const cps = await state.cardCheckpoints();
      clear(body);
      if (!cps.length) {
        body.appendChild(el("div", { class: "hint", text: "\uC544\uC9C1 \uBD07 \uC2A4\uB0C5\uC0F7\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \u{1F516} \uC2A4\uB0C5\uC0F7 \uBC84\uD2BC\uC73C\uB85C \uC800\uC7A5\uD574 \uC8FC\uC138\uC694." }));
        return;
      }
      body.appendChild(el("div", { class: "verrow" }, [
        el("div", { class: "grow" }, [
          el("div", {}, [el("span", { text: "\uC9C0\uAE08 \uD3B8\uC9D1 \uC911\uC778 \uC791\uC5C5\uBCF8 " }), el("span", { class: "badge now", text: "\uD604\uC7AC" })]),
          el("div", { class: "hint", text: "\uC2A4\uB0C5\uC0F7\uC774 \uC544\uB2D9\uB2C8\uB2E4. \uC544\uB798\uB294 \uCD5C\uADFC \uC21C\uC785\uB2C8\uB2E4." })
        ])
      ]));
      for (const [idx, c] of cps.slice(0, 12).entries()) {
        const b = el("button", { class: "ghost tiny", text: "\uB418\uB3CC\uB9AC\uAE30", title: "\uC791\uC5C5\uBCF8\uC744 \uC774 \uC2DC\uC810\uC73C\uB85C \uB418\uB3CC\uB9BD\uB2C8\uB2E4 (\uC9C1\uC804 \uC0C1\uD0DC\uB3C4 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uB0A8\uC2B5\uB2C8\uB2E4)" });
        b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            await state.cardRestore(c.id);
            close();
            shellNotice("\uCE74\uB4DC\xB7\uBD07 \uB85C\uC5B4\uBD81\xB7\uC2A4\uD06C\uB9BD\uD2B8\uB97C \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4. \uB418\uB3CC\uB9AC\uAE30 \uC9C1\uC804 \uC0C1\uD0DC\uB3C4 \uC2A4\uB0C5\uC0F7\uC73C\uB85C \uB0A8\uACA8 \uB450\uC5C8\uC2B5\uB2C8\uB2E4.", "ok");
          } catch (e) {
            shellNotice("\uBCF5\uC6D0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + msg14(e), "err");
          }
        });
        const title = el("div", {}, [
          el("span", { text: c.label || "(\uBB34\uC81C)" }),
          idx === 0 ? el("span", { class: "badge", style: { marginLeft: "6px" }, text: "\uCD5C\uC2E0 \uC2A4\uB0C5\uC0F7" }) : null
        ]);
        const ren = el("button", { class: "ghost tiny", text: "\u270E", title: "\uC774\uB984 \uBC14\uAFB8\uAE30" });
        ren.addEventListener("click", () => {
          openSnapshotName(ren, c.label || "", async (label) => {
            await state.renameCardCheckpoint(c.id, label);
            title.firstChild.textContent = label;
          });
        });
        const row = el("div", { class: "verrow" });
        const del = el("button", { class: "ghost tiny", title: "\uC774 \uC2A4\uB0C5\uC0F7 \uC0AD\uC81C" });
        armed(del, "\u2715", "\uC0AD\uC81C \uD655\uC778", async () => {
          row.classList.add("deleting");
          del.disabled = true;
          try {
            await state.deleteCardCheckpoint(c.id);
            row.remove();
          } catch (e) {
            row.classList.remove("deleting");
            del.disabled = false;
            shellNotice("\uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + msg14(e), "err");
          }
        });
        row.append(
          el("div", { class: "grow" }, [
            title,
            el("div", { class: "hint", text: fmtTime(c.created_at * 1e3) })
          ]),
          ren,
          b,
          del
        );
        body.appendChild(row);
      }
      if (cps.length > 12) body.appendChild(el("div", { class: "hint", text: `\uADF8 \uC678 ${cps.length - 12}\uAC1C` }));
      body.appendChild(snapshotCleanup(cps.length, async (keep) => {
        const n = await state.clearCardCheckpoints(keep);
        close();
        shellNotice(`\uBD07 \uC2A4\uB0C5\uC0F7 ${n}\uAC1C\uB97C \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4.`, "ok");
      }));
    } catch (e) {
      clear(body);
      body.appendChild(el("div", { class: "hint", text: msg14(e) }));
    }
  }

  // src/ui/tab-assets.ts
  var FIELD_LABEL = {
    image: "\uD504\uB85C\uD544",
    emotion: "\uAC10\uC815 \uC774\uBBF8\uC9C0",
    additional: "\uCD94\uAC00 \uC5D0\uC14B",
    cc: "CC \uC5D0\uC14B",
    vits: "VITS \uC74C\uC131"
  };
  var FIELD_ORDER = ["image", "emotion", "additional", "cc", "vits"];
  var built7 = false;
  var gridMount = null;
  var noticeMount9 = null;
  var sideMount2 = null;
  var cells = [];
  var seenEpoch6 = -1;
  var seenKey4 = "";
  var seenSyncAt = 0;
  var seenBusy = false;
  var filterText4 = "";
  var thumbs2 = /* @__PURE__ */ new Map();
  function renderAssetsTab(mount) {
    if (!state.botKey) {
      clear(mount);
      built7 = false;
      mount.appendChild(el("div", { class: "pad" }, [
        el("div", { class: "empty", text: "\uBA3C\uC800 \uD328\uB110\uC744 \uC5F0 \uBD07\uC774 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4." })
      ]));
      return;
    }
    const syncAt = state.assetSync?.finishedAt ?? 0;
    const busy = syncBusy(state.assetSync);
    if (!built7 || !mount.querySelector(".split")) {
      clear(mount);
      const pane = threePane();
      sideMount2 = el("div", { class: "tree" });
      pane.left.appendChild(sideMount2);
      noticeMount9 = el("div");
      gridMount = el("div", { class: "pad" });
      pane.centre.appendChild(noticeMount9);
      pane.centre.appendChild(gridMount);
      mount.appendChild(pane.root);
      built7 = true;
      seenEpoch6 = state.epoch;
      seenKey4 = state.botKey;
      seenSyncAt = syncAt;
      seenBusy = busy;
      void refresh7();
    } else if (seenEpoch6 !== state.epoch || seenKey4 !== state.botKey || seenSyncAt !== syncAt || seenBusy !== busy) {
      seenEpoch6 = state.epoch;
      seenKey4 = state.botKey;
      seenSyncAt = syncAt;
      seenBusy = busy;
      void refresh7();
    }
    setToolbarSearch(filterText4, (v) => {
      filterText4 = v;
      drawGrid();
      refocusSearch(null);
    }, "\uC5D0\uC14B \uCC3E\uAE30");
    bindAgent({ notice: notice8 });
    const inner = mount.querySelector(".right-inner");
    if (inner) mountAgent(inner);
  }
  function notice8(text2, kind = "") {
    if (!noticeMount9) return;
    clear(noticeMount9);
    noticeMount9.appendChild(el("div", { class: "notice " + kind, style: { margin: "10px 14px 0" }, text: text2 }));
    setTimeout(() => {
      if (noticeMount9) clear(noticeMount9);
    }, 9e3);
  }
  async function refresh7() {
    let rows = [];
    let store = [];
    try {
      [rows, store] = await Promise.all([
        state.cardScripts("assetref"),
        state.assetList().then((r) => r.items).catch(() => [])
      ]);
    } catch (e) {
      notice8("\uC5D0\uC14B \uBAA9\uB85D\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + (e instanceof Error ? e.message : String(e)), "err");
    }
    const byKey = new Map(store.map((i) => [i.key, i]));
    const out = [];
    const portrait = store.find((i) => i.field === "image") ?? null;
    const image = String(state.character?.image ?? "");
    if (image) {
      out.push({
        row: null,
        field: "image",
        name: "\uD504\uB85C\uD544",
        key: image,
        ext: image.split(".").pop() || "png",
        state: portrait?.state ?? "unknown",
        size: portrait?.size ?? null,
        origin: "original"
      });
    }
    for (const r of rows) {
      const e = r.entry;
      const key = String(e.key ?? "");
      const st = byKey.get(key);
      out.push({
        row: r,
        field: String(e.field ?? "additional"),
        name: String(e.name ?? ""),
        key,
        ext: String(e.ext ?? (st?.ext ?? "png")),
        state: st?.state ?? "unknown",
        size: st?.size ?? null,
        origin: r.origin
      });
    }
    cells = out;
    drawSide2();
    drawGrid();
  }
  function editable() {
    return !syncBusy(state.assetSync);
  }
  function drawSide2() {
    if (!sideMount2) return;
    clear(sideMount2);
    const p = state.assetSync;
    const present = cells.filter((c) => c.state === "present").length;
    const bytes = cells.reduce((n, c) => n + (c.size || 0), 0);
    const counts2 = /* @__PURE__ */ new Map();
    for (const c of cells) counts2.set(c.field, (counts2.get(c.field) ?? 0) + 1);
    sideMount2.appendChild(el("div", { class: "treehead", text: `\uC5D0\uC14B ${cells.length}\uAC1C \xB7 ${mb(bytes)}` }));
    for (const f of FIELD_ORDER) {
      const n = counts2.get(f);
      if (n) sideMount2.appendChild(el("div", { class: "hint", style: { padding: "2px 8px" }, text: `${FIELD_LABEL[f] ?? f} ${n}` }));
    }
    sideMount2.appendChild(el("div", { class: "sectionline", style: { margin: "10px 6px" } }));
    const again = el("button", { class: "ghost tiny", text: syncBusy(p) ? "\uB3D9\uAE30\uD654 \uC911\u2026" : "\uB2E4\uC2DC \uB3D9\uAE30\uD654" });
    again.disabled = syncBusy(p);
    again.addEventListener("click", () => {
      state.syncAssets(true);
    });
    sideMount2.appendChild(el("div", { class: "hint", style: { padding: "0 8px 6px" }, text: p ? describeSync(p) : `\uC2A4\uD1A0\uC5B4 ${present}/${cells.length}` }));
    sideMount2.appendChild(el("div", { style: { padding: "0 6px" } }, [again]));
    if (!editable()) return;
    sideMount2.appendChild(el("div", { class: "sectionline", style: { margin: "10px 6px" } }));
    sideMount2.appendChild(el("div", { class: "sectiontitle", style: { padding: "0 8px" }, text: "\uB3C4\uAD6C" }));
    const strip2 = el("button", { class: "ghost tiny", text: "\uC774\uB984\uC758 \uD655\uC7A5\uC790 \uC77C\uAD04 \uC81C\uAC70" });
    strip2.title = '"face.png" \uCC98\uB7FC \uC774\uB984 \uB05D\uC5D0 \uBD99\uC740 .png/.webp \uB97C \uB5CD\uB2C8\uB2E4. CBS \uB294 \uD655\uC7A5\uC790 \uC5C6\uB294 \uC774\uB984\uC73C\uB85C \uD638\uCD9C\uD569\uB2C8\uB2E4.';
    strip2.addEventListener("click", async () => {
      strip2.disabled = true;
      try {
        const r = await transport.post("/card/assets/rename", { charKey: state.botKey, mode: "strip-ext" });
        notice8(r.changed ? `${r.changed}\uAC1C \uC774\uB984\uC5D0\uC11C \uD655\uC7A5\uC790\uB97C \uB5D0\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.` : "\uD655\uC7A5\uC790\uAC00 \uBD99\uC740 \uC774\uB984\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", r.changed ? "ok" : "");
        void state.refreshBotChanges();
        await refresh7();
      } catch (e) {
        notice8("\uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: " + (e instanceof Error ? e.message : String(e)), "err");
      } finally {
        strip2.disabled = false;
      }
    });
    const rx = el("button", { class: "ghost tiny", text: "\uC815\uADDC\uC2DD\uC73C\uB85C \uC77C\uAD04 \uC774\uB984 \uBCC0\uACBD" });
    rx.addEventListener("click", () => openRegexRename(rx));
    sideMount2.appendChild(el("div", { style: { padding: "0 6px" } }, [strip2]));
    sideMount2.appendChild(el("div", { style: { padding: "4px 6px" } }, [rx]));
  }
  function openRegexRename(anchor) {
    const pattern = el("input", { placeholder: "\uD328\uD134 (\uC815\uADDC\uC2DD), \uC608: ^Beatrice-" });
    const repl = el("input", { placeholder: "\uBC14\uAFC0 \uBB38\uC790\uC5F4, \uC608: \uBE44\uC5B4 \uC788\uC73C\uBA74 \uC0AD\uC81C" });
    const out = el("div", { class: "hint" });
    const body = el("div", { class: "applypop" });
    const close = popover(anchor, body);
    const run = el("button", { class: "primary", text: "\uC801\uC6A9" });
    run.addEventListener("click", async () => {
      run.disabled = true;
      try {
        const r = await transport.post("/card/assets/rename", {
          charKey: state.botKey,
          mode: "regex",
          pattern: pattern.value,
          repl: repl.value
        });
        notice8(`${r.changed}\uAC1C \uC774\uB984\uC744 \uBC14\uAFE8\uC2B5\uB2C8\uB2E4. \uBD07 \uBC14\uC758 \u201C\uBC18\uC601\u201D\uC744 \uB204\uB974\uBA74 RisuAI\uC5D0 \uC4F0\uC785\uB2C8\uB2E4.`, r.changed ? "ok" : "");
        void state.refreshBotChanges();
        await refresh7();
        close();
      } catch (e) {
        out.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        run.disabled = false;
      }
    });
    body.appendChild(el("div", { class: "hint", text: "\uBAA8\uB4E0 \uC5D0\uC14B \uC774\uB984\uC5D0 re.sub(\uD328\uD134, \uBC14\uAFC0 \uBB38\uC790\uC5F4) \uC744 \uC801\uC6A9\uD569\uB2C8\uB2E4." }));
    body.appendChild(el("div", { class: "row" }, [pattern]));
    body.appendChild(el("div", { class: "row" }, [repl]));
    body.appendChild(el("div", { class: "row" }, [run]));
    body.appendChild(out);
  }
  function mb(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";
  }
  function drawGrid() {
    if (!gridMount) return;
    clear(gridMount);
    if (!editable()) {
      gridMount.appendChild(el("div", { class: "notice", text: "\uC5D0\uC14B \uB3D9\uAE30\uD654 \uC911\uC785\uB2C8\uB2E4\u2026 \uB3D9\uAE30\uD654\uAC00 \uB05D\uB098\uAE30 \uC804\uAE4C\uC9C0 \uC5D0\uC14B \uD3B8\uC9D1\uC774 \uBD88\uAC00\uD569\uB2C8\uB2E4. \uB2E4\uB978 \uD0ED\uACFC \uBC18\uC601\uC740 \uADF8\uB300\uB85C \uC4F8 \uC218 \uC788\uC2B5\uB2C8\uB2E4." }));
    }
    const needle = filterText4.trim().toLowerCase();
    const shown = cells.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle));
    if (!shown.length) {
      gridMount.appendChild(el("div", { class: "empty", text: cells.length ? "\uAC80\uC0C9 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." : "\uC774 \uBD07\uC740 \uC5D0\uC14B\uC744 \uCC38\uC870\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }));
      return;
    }
    for (const f of FIELD_ORDER) {
      const list2 = shown.filter((c) => c.field === f);
      if (!list2.length) continue;
      gridMount.appendChild(el("div", { class: "sectiontitle", text: `${FIELD_LABEL[f] ?? f} \xB7 ${list2.length}` }));
      const grid = el("div", { class: "assetgrid" });
      for (const c of list2) grid.appendChild(cell(c));
      gridMount.appendChild(grid);
    }
    gridMount.appendChild(el("div", { class: "hint", style: { marginTop: "10px" }, text: "\uAC19\uC740 \uC774\uB984\uC774 \uC5EC\uB7FF\uC774\uBA74 RisuAI \uAC00 \uD638\uCD9C \uB54C \uBB34\uC791\uC704\uB85C \uD558\uB098\uB97C \uACE0\uB974\uB294 \uB79C\uB364 \uD480\uC785\uB2C8\uB2E4. \uC774\uB984\uC744 \uB204\uB974\uBA74 \uBC14\uAFC0 \uC218 \uC788\uACE0, \uC0AD\uC81C\uB294 \uCE74\uB4DC\uC758 \uCC38\uC870\uB9CC \uC9C0\uC6C1\uB2C8\uB2E4(\uD30C\uC77C\uC740 RisuAI \uAC00 \uC815\uB9AC). \uB458 \uB2E4 \uBC18\uC601 \uB54C \uC4F0\uC785\uB2C8\uB2E4." }));
  }
  function cell(c) {
    const box = el("div", { class: "assetcell" + (c.origin !== "original" ? " changed" : "") + (c.state === "failed" ? " failed" : "") });
    const pic = el("div", { class: "assetpic" });
    box.appendChild(pic);
    void loadThumb2(c, pic);
    const nameEl = el("div", { class: "assetname", text: c.name || "(\uC774\uB984 \uC5C6\uC74C)", title: `${c.key}${c.size ? " \xB7 " + mb(c.size) : ""}` });
    if (c.row && editable()) {
      nameEl.classList.add("editable");
      nameEl.addEventListener("click", () => beginRename(c, nameEl));
    }
    box.appendChild(nameEl);
    const meta = el("div", { class: "assetmeta" }, [
      el("span", { text: c.ext.toUpperCase() }),
      c.state === "missing" ? el("span", { class: "badge warn", text: "\uC5C6\uC74C" }) : null,
      c.state === "failed" ? el("span", { class: "badge err", text: "\uC2E4\uD328" }) : null,
      c.origin === "edited" ? el("span", { class: "badge warn", text: "\uC218\uC815" }) : null,
      c.origin === "added" ? el("span", { class: "badge ok", text: "\uCD94\uAC00" }) : null
    ]);
    if (c.row && editable()) {
      const del = el("button", { class: "ghost tiny", text: "\u2715", title: "\uCE74\uB4DC\uC5D0\uC11C \uC774 \uCC38\uC870\uB97C \uC9C0\uC6C1\uB2C8\uB2E4" });
      const row = c.row;
      armed(del, "\u2715", "\uC815\uB9D0?", async () => {
        try {
          await state.deleteScript(row.id);
          void state.refreshBotChanges();
          await refresh7();
        } catch (e) {
          notice8("\uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + (e instanceof Error ? e.message : String(e)), "err");
        }
      });
      meta.appendChild(del);
    }
    box.appendChild(meta);
    return box;
  }
  function beginRename(c, nameEl) {
    if (!c.row) return;
    const row = c.row;
    const input = el("input", { value: c.name, class: "assetrename" });
    const done = async (commit) => {
      const v = input.value.trim();
      if (!commit || !v || v === c.name) {
        input.replaceWith(nameEl);
        return;
      }
      try {
        await state.saveScript(row.id, { ...row.entry, name: v });
        void state.refreshBotChanges();
        await refresh7();
      } catch (e) {
        notice8("\uC774\uB984\uC744 \uBC14\uAFB8\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: " + (e instanceof Error ? e.message : String(e)), "err");
        input.replaceWith(nameEl);
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void done(true);
      else if (ev.key === "Escape") void done(false);
    });
    input.addEventListener("blur", () => void done(true));
    nameEl.replaceWith(input);
    input.focus();
    try {
      input.select();
    } catch {
    }
  }
  var THUMB_PARALLEL2 = 6;
  var thumbActive2 = 0;
  var thumbQueue2 = [];
  function thumbSlot() {
    return new Promise((resolve) => {
      const grant = () => {
        thumbActive2 += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          thumbActive2 -= 1;
          const next = thumbQueue2.shift();
          if (next) next();
        });
      };
      if (thumbActive2 < THUMB_PARALLEL2) grant();
      else thumbQueue2.push(grant);
    });
  }
  async function thumbBytes(c) {
    if (c.state === "present") {
      try {
        const bytes = await transport.postBinary("/assets/blob", { key: c.key });
        if (bytes.byteLength) return bytes;
      } catch {
      }
    }
    try {
      const bytes = await Risuai.readImage(c.key);
      if (bytes && bytes.byteLength) return bytes;
    } catch {
    }
    return null;
  }
  async function loadThumb2(c, mount) {
    const isImage = /^(png|jpe?g|gif|webp|avif|bmp)$/i.test(c.ext);
    if (!isImage) {
      mount.appendChild(el("div", { class: "assettype", text: c.ext.toUpperCase() }));
      return;
    }
    let url = thumbs2.get(c.key) || "";
    if (!url) {
      const release = await thumbSlot();
      try {
        if (!mount.isConnected) return;
        const view2 = await thumbBytes(c);
        if (view2) {
          const buf = new Uint8Array(view2.byteLength);
          buf.set(view2);
          url = URL.createObjectURL(new Blob([buf]));
          if (thumbs2.size > 400) {
            for (const [k, u] of thumbs2) {
              URL.revokeObjectURL(u);
              thumbs2.delete(k);
              break;
            }
          }
          thumbs2.set(c.key, url);
        }
      } finally {
        release();
      }
    }
    if (!url) {
      mount.appendChild(el("div", { class: "assettype", text: c.state === "missing" ? "\uC5C6\uC74C" : c.ext.toUpperCase() }));
      return;
    }
    if (!mount.isConnected) return;
    const img = el("img", { src: url, alt: c.name, loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(el("div", { class: "assettype", text: c.ext.toUpperCase() })));
    mount.appendChild(img);
  }

  // src/ui/shell.ts
  var mode = "bot";
  var CONTENT_TABS = [
    ["chats", "\uC120\uD0DD"],
    ["editor", "\uCC57 \uC5D0\uB527"],
    ["lore", "\uCC57 \uB85C\uC5B4\uBD81"],
    ["memory", "\uC7A5\uAE30\uAE30\uC5B5"],
    ["vars", "\uCC57 \uBCC0\uC218"],
    ["meta", "\uBA54\uD0C0"],
    ["botlore", "\uBD07 \uB85C\uC5B4\uBD81"],
    ["regex", "Regex"],
    ["trigger", "\uD2B8\uB9AC\uAC70"],
    ["assets", "\uC5D0\uC14B"],
    ["files", "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uD30C\uC77C"]
  ];
  var CHAT_TABS = /* @__PURE__ */ new Set(["editor", "lore", "memory", "vars"]);
  var BOT_TABS = /* @__PURE__ */ new Set(["meta", "botlore", "regex", "trigger", "assets"]);
  function setEditMode(m, tab) {
    mode = m;
    state.editMode = m;
    syncModeTabs();
    if (tab) setTab(tab);
    else if ((m === "chat" ? BOT_TABS : CHAT_TABS).has(active)) setTab("chats");
  }
  function currentMode() {
    return mode;
  }
  function syncModeTabs() {
    for (const id of CHAT_TABS) {
      const b = document.getElementById("tab-" + id);
      if (b) b.style.display = mode === "chat" ? "" : "none";
    }
    for (const id of BOT_TABS) {
      const b = document.getElementById("tab-" + id);
      if (b) b.style.display = mode === "bot" ? "" : "none";
    }
  }
  var ALL_TABS = [...CONTENT_TABS.map(([id]) => id), "settings"];
  var active = "chats";
  var mounted = false;
  var mounts = {};
  var healthEl = null;
  var toolbarSlot = null;
  var chatBarEl = null;
  var botBarEl = null;
  var tabSlot = null;
  var syncBadge = el("span", { class: "syncbadge", style: { display: "none" } });
  function refreshSyncBadge() {
    const p = state.assetSync;
    if (!p || !state.botKey) {
      syncBadge.style.display = "none";
      return;
    }
    const busy = syncBusy(p);
    let text2 = "";
    if (busy) {
      let ratio = -1;
      if (p.phase === "pulling" && p.pull && p.pull.total) ratio = p.pull.done / p.pull.total;
      else if (p.phase === "pushing" && p.toPush) ratio = (p.read + p.readFailed) / p.toPush;
      text2 = "\uC5D0\uC14B " + (ratio >= 0 ? Math.round(ratio * 100) + "%" : "\uB300\uC870 \uC911");
    } else if (p.phase === "error" || p.phase === "cancelled") {
      text2 = "\uC5D0\uC14B \uB3D9\uAE30\uD654 \uC911\uB2E8";
    } else if (p.total) {
      text2 = `\uC5D0\uC14B ${p.present}/${p.total}` + (p.failed ? ` (\uC2E4\uD328 ${p.failed})` : "");
    }
    syncBadge.textContent = text2;
    syncBadge.title = describeSync(p);
    syncBadge.className = "syncbadge" + (busy ? " busy" : p.phase === "error" ? " err" : "");
    syncBadge.style.display = text2 ? "" : "none";
  }
  function setToolbar(node) {
    if (!tabSlot) return;
    clear(tabSlot);
    if (node) tabSlot.appendChild(node);
    syncToolslot();
  }
  function setToolbarSearch(value, onInput, placeholder = "\uCC3E\uAE30") {
    setToolbar(searchBox(value, onInput, placeholder));
  }
  function syncToolslot() {
    if (!toolbarSlot || !chatBarEl || !botBarEl || !tabSlot) return;
    const showChat = !!state.activeChatKey && CHAT_TABS.has(active);
    const showBot = !!state.botKey && BOT_TABS.has(active);
    chatBarEl.style.display = showChat ? "" : "none";
    botBarEl.style.display = showBot ? "" : "none";
    const showTab2 = tabSlot.childElementCount > 0;
    tabSlot.style.display = showTab2 ? "" : "none";
    toolbarSlot.style.display = showChat || showBot || showTab2 ? "" : "none";
  }
  function setTab(tab) {
    active = tab;
    for (const id of ALL_TABS) {
      mounts[id]?.classList.toggle("active", id === tab);
      document.getElementById("tab-" + id)?.classList.toggle("active", id === tab);
    }
    document.getElementById("open-settings")?.classList.toggle("on", tab === "settings");
    renderActive();
    syncSettingsBar();
    syncToolslot();
    refreshTabBadges();
  }
  function syncSettingsBar() {
    const row = document.querySelector(".tabs");
    if (!row) return;
    const inSettings = active === "settings";
    for (const b of Array.from(row.querySelectorAll(".tab, .tabsep"))) {
      b.style.display = inSettings ? "none" : "";
    }
    if (!inSettings) syncModeTabs();
    syncBadge.style.visibility = inSettings ? "hidden" : "";
    const bar3 = getSettingsBar();
    if (bar3) {
      if (bar3.parentElement !== row) row.appendChild(bar3);
      bar3.style.display = inSettings ? "" : "none";
    }
  }
  function renderActive() {
    const node = mounts[active];
    if (!node) return;
    if (active !== "editor") setToolbar(null);
    if (active === "chats") renderChatsTab(node);
    else if (active === "editor") renderEditorTab(node);
    else if (active === "lore") renderLoreTab(node);
    else if (active === "memory") renderMemoryTab(node);
    else if (active === "vars") renderVarsTab(node);
    else if (active === "meta") renderMetaTab(node);
    else if (active === "botlore") renderBotLoreTab(node);
    else if (active === "regex") renderRegexTab(node);
    else if (active === "trigger") renderTriggerTab(node);
    else if (active === "assets") renderAssetsTab(node);
    else if (active === "files") renderFilesTab(node);
    else renderSettingsTab(node);
  }
  function refreshStatus() {
    if (!healthEl) return;
    clear(healthEl);
    const h = state.health;
    healthEl.className = "status" + (h ? h.agentReady ? "" : " warn" : " bad");
    healthEl.appendChild(el("span", { class: "healthdot" }));
    if (!h) {
      healthEl.appendChild(el("span", { text: "\uBC31\uC5D4\uB4DC \uC5F0\uACB0 \uC548 \uB428" }));
      healthEl.title = (state.connectError || "\uC124\uC815\uC5D0\uC11C URL\uACFC \uD1A0\uD070\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694") + (reconnectTimer ? ` (\uC790\uB3D9 \uC7AC\uC2DC\uB3C4 ${reconnectAttempts + 1}\uD68C\uC9F8)` : "");
      if (reconnectTimer) healthEl.appendChild(el("span", { class: "hint", text: "\uC7AC\uC2DC\uB3C4 \uC911" }));
    } else if (transport.versionGate) {
      healthEl.className = "status bad";
      healthEl.appendChild(el("span", { text: `\uBC31\uC5D4\uB4DC v${h.version} \xB7 \uD50C\uB7EC\uADF8\uC778 v${"0.9.2"} \u2014 \uBC84\uC804\uC774 \uB2E4\uB985\uB2C8\uB2E4` }));
      const go = el("button", { class: "primary tiny", text: transport.versionGate.includes("\uBC31\uC5D4\uB4DC\uB97C \uC5C5\uB370\uC774\uD2B8") ? "\uBC31\uC5D4\uB4DC \uC5C5\uB370\uC774\uD2B8\uB85C" : "\uC548\uB0B4 \uBCF4\uAE30" });
      go.addEventListener("click", () => setTab("settings"));
      healthEl.appendChild(go);
      healthEl.title = transport.versionGate;
    } else {
      healthEl.appendChild(el("span", { class: "hint", text: `\uBC31\uC5D4\uB4DC v${h.version}` }));
      if (!h.agentReady) {
        healthEl.appendChild(el("span", { class: "hint", text: "\xB7 AI \uBBF8\uC124\uC815" }));
      }
    }
    if (bootPhase) healthEl.appendChild(el("span", { class: "hint bootphase", text: "\xB7 " + bootPhase }));
    const botName = state.character?.name ? String(state.character.name) : "";
    if (botName) healthEl.appendChild(el("span", { class: "hint botname", text: `\xB7 ${botName}` }));
    const chat = state.activeChat;
    if (chat) {
      healthEl.appendChild(el("span", {
        class: "hint chatname",
        text: `\xB7 ${chat.name || chat.chatKey} \xB7 ${chat.turns}\uD134`
      }));
    }
  }
  function buildShell() {
    injectStyles();
    clear(document.body);
    healthEl = el("div", { class: "status" });
    const tabButton = (id, label) => {
      const b = el("button", { class: "tab", id: "tab-" + id }, [
        el("span", { text: label }),
        // Only the files tab ever fills this: the count of agent outputs the
        // user has not looked at. Cleared by opening the tab.
        el("span", { class: "badge warn tabbadge", style: { display: "none" } })
      ]);
      b.addEventListener("click", () => setTab(id));
      return b;
    };
    const close = el("button", { class: "ghost", html: ICON.close, title: "\uB2EB\uAE30" });
    close.addEventListener("click", async () => {
      try {
        await Risuai.hideContainer();
      } catch {
      }
    });
    const reload = el("button", {
      class: "iconbtn",
      html: ICON.reload,
      title: "RisuAI\uC5D0\uC11C \uD604\uC7AC \uC5F4\uB824 \uC788\uB294 \uBD07\uACFC \uCC57\uC744 \uB2E4\uC2DC \uC77D\uC5B4 \uC635\uB2C8\uB2E4"
    });
    reload.addEventListener("click", () => {
      void bootstrap(true);
    });
    const settingsBtn = el("button", {
      class: "iconbtn",
      id: "open-settings",
      html: ICON.gear,
      title: "\uC124\uC815 \u2014 \uBC31\uC5D4\uB4DC \uC5F0\uACB0 \xB7 \uC5D0\uC774\uC804\uD2B8 \uD504\uB9AC\uC14B \xB7 \uC2A4\uD0AC"
    });
    let cameFrom = "chats";
    settingsBtn.addEventListener("click", () => {
      if (active === "settings") setTab(cameFrom);
      else {
        cameFrom = active;
        setTab("settings");
      }
    });
    for (const id of ALL_TABS) {
      mounts[id] = el("div", { class: "panel" + (id === "chats" ? " active" : "") });
    }
    const shellNotice2 = el("div", { class: "shellnotice" });
    chatBarEl = buildChatBar(shellNotice2);
    botBarEl = buildBotBar();
    tabSlot = el("div", { class: "tabslot" });
    toolbarSlot = el("div", { class: "toolslot" }, [chatBarEl, botBarEl, tabSlot]);
    document.body.appendChild(el("div", { class: "wrap" }, [
      el("header", {}, [
        el("h1", { html: ICON.app + "<span>Risu Hina</span>" }),
        el("span", { class: "dim", text: "v0.9.2" }),
        healthEl,
        el("span", { class: "spacer" }),
        reload,
        settingsBtn,
        close
      ]),
      // The files tab sits right after 에셋, and the importer's badge goes at
      // the far end of the row on its own: it used to sit between the two with
      // margin-left:auto, which pushed 워크스페이스 파일 to the opposite edge
      // of the bar from the tab it belongs beside.
      el("div", { class: "tabs" }, [
        ...CONTENT_TABS.flatMap(([id, label]) => id === "files" ? [el("span", { class: "tabsep", title: "\uC5EC\uAE30\uBD80\uD130\uB294 \uD3B8\uC9D1 \uB300\uC0C1\uC774 \uC544\uB2C8\uB77C \uBD07\uC758 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC785\uB2C8\uB2E4" }), tabButton(id, label)] : [tabButton(id, label)]),
        syncBadge
      ]),
      toolbarSlot,
      shellNotice2,
      el("main", {}, ALL_TABS.map((id) => mounts[id]))
    ]));
    document.getElementById("tab-chats")?.classList.add("active");
    mounted = true;
    syncModeTabs();
    refreshStatus();
    syncToolslot();
  }
  function refreshTabBadges() {
    const badge = document.querySelector("#tab-files .tabbadge");
    if (badge) {
      const n = state.unseenOutputs.length;
      badge.textContent = String(n);
      badge.style.display = n && active !== "files" ? "" : "none";
    }
    const c = state.botChanges;
    const per = {
      meta: c ? c.fields + (c.greetings?.total ?? 0) : 0,
      botlore: c?.lore?.total ?? 0,
      regex: c?.customscript?.total ?? 0,
      trigger: c?.triggerscript?.total ?? 0,
      assets: c?.assetref?.total ?? 0
    };
    for (const [id, n] of Object.entries(per)) {
      const b = document.querySelector(`#tab-${id} .tabbadge`);
      if (!b) continue;
      b.textContent = String(n);
      b.title = n ? `\uAE30\uC900\uC120\uACFC \uB2E4\uB978 \uD56D\uBAA9 ${n}\uAC1C \u2014 \uAC01 \uD56D\uBAA9\uC5D0 \uCD94\uAC00/\uC218\uC815 \uD45C\uC2DC\uAC00 \uC788\uC2B5\uB2C8\uB2E4` : "";
      b.style.display = n ? "" : "none";
    }
    const stuck = (state.botChanges?.conflicts ?? 0) + (state.changes?.conflicts ?? 0);
    for (const id of ["meta", "botlore", "regex", "trigger", "editor", "lore", "memory"]) {
      const b = document.querySelector(`#tab-${id} .tabbadge`);
      if (b) b.classList.toggle("conflict", stuck > 0 && b.style.display !== "none");
    }
  }
  state.onChange(() => {
    if (!mounted) return;
    if (state.openTabRequest) {
      const tab = state.openTabRequest;
      state.openTabRequest = null;
      if (CHAT_TABS.has(tab)) setEditMode("chat", tab);
      else if (BOT_TABS.has(tab)) setEditMode("bot", tab);
      else if (tab === "files" || tab === "chats") setTab(tab);
      return;
    }
    if (state.openFileRequest && active !== "files") {
      setTab("files");
      return;
    }
    refreshStatus();
    refreshChatBar();
    refreshBotBar();
    refreshTabBadges();
    refreshSyncBadge();
    renderActive();
    syncToolslot();
  });
  async function bootstrap(force = false) {
    if (!mounted) buildShell();
    setTab(active);
    const t0 = Date.now();
    setBootPhase("\uBC31\uC5D4\uB4DC\uC5D0 \uC5F0\uACB0\uD558\uB294 \uC911\u2026");
    await transport.detectPlatform();
    const connected = await state.connect();
    const t1 = Date.now();
    setBootPhase("RisuAI\uC5D0\uC11C \uBD07\uC744 \uC77D\uB294 \uC911\u2026");
    await state.readHost();
    const t2 = Date.now();
    if (connected) {
      setBootPhase("\uBC31\uC5D4\uB4DC\uC5D0 \uC62C\uB9AC\uB294 \uC911\u2026");
      await uploadAfterConnect(force);
    } else {
      startReconnect(force);
    }
    const t3 = Date.now();
    setBootPhase("");
    refreshStatus();
    renderActive();
    const hostMs = t2 - t1;
    if (connected) {
      void clientLog(hostMs > 5e3 ? "warn" : "info", "boot", {
        connectMs: t1 - t0,
        hostMs,
        uploadMs: t3 - t2,
        platform: transport.hostPlatform,
        hostError: state.slotError.slice(0, 200)
      });
    }
  }
  var bootPhase = "";
  function setBootPhase(text2) {
    bootPhase = text2;
    refreshStatus();
  }
  var uploadInFlight = null;
  function announceMerge() {
    const m = state.lastMerge;
    state.lastMerge = null;
    if (!m) return;
    const bits = [];
    if (m.adopt) bits.push(`\uC218\uC815 ${m.adopt}\uAC74`);
    if (m.insert) bits.push(`\uCD94\uAC00 ${m.insert}\uAC74`);
    if (m.delete) bits.push(`\uC0AD\uC81C ${m.delete}\uAC74`);
    const conflicts = m.conflict ?? 0;
    if (!bits.length && !conflicts) return;
    const head = bits.length ? `RisuAI \uCABD \uBCC0\uACBD\uC744 \uBC1B\uC558\uC2B5\uB2C8\uB2E4 (${bits.join(" \xB7 ")}).` : "";
    const tail = conflicts ? ` \uD3B8\uC9D1 \uC911\uC774\uB358 ${conflicts}\uAC74\uC740 \uCDA9\uB3CC\uB85C \uD45C\uC2DC\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uBC18\uC601 \uC804\uC5D0 \uACE8\uB77C \uC8FC\uC138\uC694.` : "";
    shellNotice((head + tail).trim(), conflicts ? "err" : "ok");
  }
  async function uploadAfterConnect(force = false) {
    if (uploadInFlight) return uploadInFlight;
    if (!state.slot || state.slotError) return;
    uploadInFlight = (async () => {
      try {
        await state.upload({ force });
        announceMerge();
        if (state.activeChatKey) await state.loadTurns();
      } catch (e) {
        console.log("[risu-hina] upload failed", e);
        state.emit();
      }
    })();
    try {
      await uploadInFlight;
    } finally {
      uploadInFlight = null;
    }
  }
  var reconnectTimer = null;
  var reconnectAttempts = 0;
  var RECONNECT_DELAYS = [3e3, 5e3, 8e3, 12e3, 2e4, 3e4];
  function startReconnect(force) {
    if (reconnectTimer) return;
    let i = 0;
    const startedAt = Date.now();
    const tick = async () => {
      reconnectTimer = null;
      if (state.health) return;
      reconnectAttempts += 1;
      const lastError = state.connectError;
      const lastProbe = transport.probeInfo;
      const ok = await state.connect();
      if (ok) {
        void clientLog("warn", "connect recovered", {
          attempts: reconnectAttempts,
          seconds: Math.round((Date.now() - startedAt) / 1e3),
          lastError: lastError.slice(0, 300),
          // Who was answering while it failed. An HTML content-type or a
          // cacheable Cache-Control here means an intermediary replied and the
          // backend never saw the request.
          lastProbe: lastProbe.slice(0, 300),
          platform: transport.hostPlatform
        });
        reconnectAttempts = 0;
        if (!state.slot) await state.readHost();
        if (!state.workspace) await uploadAfterConnect(force);
        refreshStatus();
        renderActive();
        return;
      }
      refreshStatus();
      reconnectTimer = setTimeout(tick, RECONNECT_DELAYS[Math.min(i++, RECONNECT_DELAYS.length - 1)]);
    };
    reconnectTimer = setTimeout(tick, RECONNECT_DELAYS[Math.min(i++, RECONNECT_DELAYS.length - 1)]);
  }
  var sawConnected = false;
  state.onChange(() => {
    const ok = !!state.health;
    if (ok && !sawConnected && mounted && !state.workspace && state.slot && !state.slotError) {
      void uploadAfterConnect().then(() => {
        refreshStatus();
        renderActive();
      });
    }
    sawConnected = ok;
  });

  // src/index.ts
  var DEFAULT_URL = "http://127.0.0.1:6020";
  async function resolveConfig() {
    let url = "";
    let token2 = "";
    try {
      const stored = await Risuai.pluginStorage.getItem("backend");
      if (stored && typeof stored === "object") {
        url = String(stored.url ?? "");
        token2 = String(stored.token ?? "");
      }
    } catch {
    }
    return { url: url || DEFAULT_URL, token: token2 };
  }
  (async () => {
    "use strict";
    const parts = [];
    try {
      transport.configure(await resolveConfig());
    } catch (e) {
      console.log("[risu-hina] config resolve failed", e);
    }
    const open4 = async () => {
      try {
        await Risuai.showContainer("fullscreen");
        await bootstrap();
      } catch (e) {
        console.log("[risu-hina] open failed", e);
      }
    };
    try {
      parts.push(await Risuai.registerSetting("Risu Hina", open4, ICON.app, "html"));
    } catch (e) {
      console.log("[risu-hina] registerSetting failed", e);
    }
    try {
      parts.push(await Risuai.registerButton(
        { name: "Risu Hina", icon: ICON.app, iconType: "html", location: "hamburger" },
        open4
      ));
    } catch (e) {
      console.log("[risu-hina] registerButton failed", e);
    }
    try {
      await Risuai.onUnload(async () => {
        void clientLog("info", "unloaded by host (plugin reload or disable)", {
          platform: transport.hostPlatform,
          connected: !!transport.health
        });
        for (const p of parts) {
          if (p?.id) {
            try {
              await Risuai.unregisterUIPart(p.id);
            } catch {
            }
          }
        }
      });
    } catch {
    }
    console.log(`[risu-hina] v${"0.9.2"} loaded`);
  })();
})();
