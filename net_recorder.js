/* 网络探针（v1.8.0）— 完整抓包工具，对标 DevTools Network 面板。
 *
 * 核心目标：出错后页面被 Google 重置/重定向，DevTools Network 面板
 * 清空，永远抓不到失败的那个请求。本探针把每条记录实时写进
 * storage.session（扩展后台）+ sessionStorage（同tab），页面死了记录不死。
 *
 * v1.8.0 新增探针（v1.7.0 只有 fetch/XHR）：
 *   1. navigator.sendBeacon 劫持 —— prefetch/ping 等无回调通道
 *   2. <form> submit 劫持 —— 导航型提交（AJAX 探针的盲区）
 *   3. location 赋值/replace 劫持 —— 出错时的静默导航（隐形杀手）
 *   4. performance.getEntriesByType("resource") 轮询 —— 兜底，
 *      上面的钩子全被绕过（新 API、WebRTC 层）时最后依旧能感知
 *   5. console.error 钩子 —— Google 前端自己报的响应错误
 *   6. 已有 fetch/XHR：v1.8.0 增加请求头快照 + 错误响应的完整快照
 *
 * 通道：CustomEvent(同帧) + window.top.postMessage(跨frame) +
 *       sessionStorage(同tab跨导航) 三路冗余，见 record()。
 */
(() => {
  if (window.__gqsRecorderInstalled) return;
  window.__gqsRecorderInstalled = true;

  const SS_KEY = "gqsNetLogSS";
  const MAX_BODY = 2000;

  function isWatched(url) {
    if (!url) return false;
    return (
      url.indexOf("accounts.google.com") !== -1 ||
      url.indexOf("googleusercontent") !== -1 ||
      url.indexOf("gstatic") !== -1 ||
      url.indexOf("googleapis") !== -1
    );
  }

  function persistSS(entry) {
    try {
      const arr = JSON.parse(sessionStorage.getItem(SS_KEY) || "[]");
      arr.push(entry);
      while (arr.length > 250) arr.shift();
      sessionStorage.setItem(SS_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  function record(entry) {
    entry.t = new Date().toISOString();
    entry.frame = (window === window.top) ? "top" : "iframe";
    persistSS(entry);
    try {
      window.dispatchEvent(new CustomEvent("gqs-net-log", { detail: entry }));
    } catch (_) {}
    try {
      if (window.top !== window) window.top.postMessage({ __gqsType: "netlog", entry }, "*");
      else window.postMessage({ __gqsType: "netlog", entry }, "*"); // 无嵌套时也发给top-listener
    } catch (_) {}
  }

  function extractBody(b, len) {
    if (b === null || b === undefined) return "";
    try {
      if (typeof b === "string") return b.slice(0, len || 800);
      if (typeof b === "object" && b.toString && b.toString() !== "[object Object]") {
        return b.toString().slice(0, len || 800);
      }
      if (typeof b === "object") {
        // FormData/URLSearchParams 等：读可枚举内容
        try { return JSON.stringify(b).slice(0, len || 800); } catch (_) {}
        try {
          const parts = [];
          if (b instanceof URLSearchParams) return b.toString().slice(0, len || 800);
        } catch (_) {}
      }
    } catch (_) {}
    return String(b).slice(0, len || 800);
  }

  /* ============ 1. fetch 探针（增强版）============ */
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      let url = "", method = "GET";
      try {
        url = typeof input === "string" ? input : (input && input.url) ? input.url : String(input);
        method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      } catch (_) {}
      const watched = isWatched(url) || method === "POST";
      const reqHeaders = {};
      try {
        const h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof h.forEach === "function") h.forEach((v, k) => reqHeaders[k] = String(v).slice(0, 120));
          else Object.assign(reqHeaders, h);
        }
      } catch (_) {}
      const reqBody = watched ? extractBody(init && init.body, MAX_BODY) : "";
      return origFetch.apply(this, arguments).then(resp => {
        if (watched) {
          const clone = resp.clone();
          clone.text().then(txt => {
            record({
              kind: "fetch", method, status: resp.status,
              url: url.slice(0, 300), reqHeaders, reqBody,
              body: txt.slice(0, MAX_BODY),
              respHeaders: {
                "content-type": resp.headers?.get?.("content-type") || "",
                "x-serving-frame": resp.headers?.get?.("x-serving-frame") || ""
              },
              ua: String(navigator.userAgent || "")
            });
          }).catch(() => {
            record({ kind: "fetch", method, status: resp.status, url: url.slice(0, 300), reqHeaders, reqBody, body: "(body unreadable)", ua: String(navigator.userAgent || "") });
          });
        }
        return resp;
      }).catch(err => {
        if (watched) {
          record({
            kind: "fetch", method, status: 0, url: url.slice(0, 300), reqHeaders, reqBody,
            body: `网络层失败: ${String(err && err.message || err)}`,
            ua: String(navigator.userAgent || "")
          });
        }
        throw err;
      });
    };
  }

  /* ============ 2. XHR 探针（增强版）============ */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetH = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const m = String(method || "GET").toUpperCase();
      const u = String(url || "");
      this.__gqsMeta = { method: m, url: u, watched: isWatched(u) || m === "POST", reqHeaders: {} };
    } catch (_) { this.__gqsMeta = null; }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__gqsMeta) this.__gqsMeta.reqHeaders[k] = String(v).slice(0, 120); } catch (_) {}
    return origSetH.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const meta = this.__gqsMeta;
    if (meta && meta.watched) {
      const reqBody = extractBody(arguments[0], MAX_BODY);
      this.addEventListener("loadend", () => {
        let body = "";
        try { body = String(this.responseText || "").slice(0, MAX_BODY); } catch (_) {}
        try {
          record({
            kind: "xhr", method: meta.method, status: this.status,
            url: meta.url.slice(0, 300), reqHeaders: meta.reqHeaders, reqBody, body,
            ua: String(navigator.userAgent || "")
          });
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  /* ============ 3. sendBeacon 探针 ============ */
  const origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (origBeacon) {
    Object.defineProperty(navigator, "sendBeacon", {
      writable: true, configurable: true,
      value: function (url, data) {
        record({
          kind: "beacon", method: "BEACON", status: -1,
          url: String(url || "").slice(0, 300),
          reqBody: extractBody(data, MAX_BODY),
          ua: String(navigator.userAgent || "")
        });
        return origBeacon.apply(navigator, arguments);
      }
    });
  }

  /* ============ 4. form submit 探针（导航型提交）============ */
  try {
    const origSubmit = HTMLFormElement.prototype.submit;
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      writable: true, configurable: true,
      value: function () {
        try {
          const action = this.action || location.href;
          const fields = {};
          for (const el of this.elements) {
            if (el.name) fields[el.name] = String(el.value || "").slice(0, 120);
          }
          record({
            kind: "form", method: (this.method || "GET").toUpperCase(), status: -1,
            url: action.slice(0, 300), reqBody: JSON.stringify(fields).slice(0, 800),
            ua: String(navigator.userAgent || "")
          });
        } catch (_) {}
        return origSubmit.apply(this, arguments);
      }
    });
  } catch (_) {}

  /* ============ 5. location 导航劫持（静默杀手）============ */
  try {
    const origReplace = location.replace.bind(location);
    location.replace = function (url) {
      try {
        record({
          kind: "nav", method: "NAV", status: -1,
          url: String(url || "").slice(0, 300),
          note: "location.replace 被调用（页面即将被静默替换）",
          ua: String(navigator.userAgent || "")
        });
      } catch (_) {}
      return origReplace(url);
    };
  } catch (_) {}

  /* ============ 6. console.error 钩子（Google 前端的自我报告）============ */
  try {
    const origErr = console.error;
    console.error = function () {
      try {
        const s = Array.from(arguments).map(a => {
          try { return typeof a === "string" ? a : JSON.stringify(a)?.slice(0, 300); }
          catch (_) { return String(a).slice(0, 200); }
        }).join(" | ");
        if (s && (s.includes("http") || s.includes("fetch") || s.toLowerCase().includes("error"))) {
          record({
            kind: "console", method: "JS", status: -1,
            url: (s.match(/https?:\/\/[^\s"']{10,200}/) || ["(无URL)"])[0],
            body: s.slice(0, 800),
            note: "Google 前端主动 report 的错误",
            ua: String(navigator.userAgent || "")
          });
        }
      } catch (_) {}
      return origErr.apply(console, arguments);
    };
  } catch (_) {}

  /* ============ 7. performance resource 轮询（兜底）============ */
  let seenRes = new Set();
  setInterval(() => {
    try {
      const list = performance.getEntriesByType("resource");
      for (const r of list) {
        const id = r.name + ":" + Math.round(r.startTime);
        if (seenRes.has(id)) continue;
        seenRes.add(id);
        // 只登记失败候选：transferSize=0 且非 css/img（可能是被拒请求）
        if (r.transferSize === 0 && !/\.(css|png|jpg|svg|woff)/.test(r.name) && isWatched(r.name)) {
          record({
            kind: "perf", method: "?", status: -2,
            url: r.name.slice(0, 300),
            note: `transferSize=0 duration=${Math.round(r.duration)}ms initiator=${r.initiatorType}`,
            ua: String(navigator.userAgent || "")
          });
        }
      }
      if (seenRes.size > 3000) seenRes = new Set();
    } catch (_) {}
  }, 3000);
})();
