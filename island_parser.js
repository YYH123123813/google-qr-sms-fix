/* Google 数据岛解析器（v2.3.0）— 注入 MAIN world，document_start。
 *
 * 深度解析的靶心：AF_initDataCallback 数据岛。
 * Google accounts 每个页面的「服务端状态真相」全部以
 *   AF_initDataCallback({key: "ds:N", data: [...], ...})
 * 形式内嵌在首屏 HTML 里。页面 JS 只是这些数据的视图。
 * 之前所有轮次只碰过 ds:0 的 token 字符串——本解析器dump全部岛：
 *   - 当前挑战允许哪些验证方式（SMS/Voice 是否在列表里）
 *   - 挑战会话的 method/status 字段（降级被认账与否的直接证据）
 *   - 表单绑定的会话指纹（与降级会话对照）
 *   - Google 侧错误数据岛（比前端横幅更早、更具体）
 * 这些是「服务端已经告诉页面的答案」，主动读它就是最深的解析。
 *
 * 注入后：AF_initDataCallback 被劫持（Google 自己调用它注册数据，
 * 我们既记录已注册的、也解析 HTML 里静态的），每 2s 增量上报
 * CustomEvent → content script → storage.session 持久。 */
(() => {
  if (window.__gqsIslandParserInstalled) return;
  window.__gqsIslandParserInstalled = true;

  const seen = new Map(); // key → summary

  function summarizeValue(v, depth = 0) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "…" : v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (depth > 2) return `[…×${v.length}]`;
      return "[" + v.slice(0, 4).map(x => summarizeValue(x, depth + 1)).join(",") + (v.length > 4 ? `,…×${v.length}` : "") + "]";
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (!keys.length) return "{}";
      if (depth > 2) return `{…${keys.length}k}`;
      return "{" + keys.slice(0, 6).map(k => `${k}:${summarizeValue(v[k], depth + 1)}`).join(",") + (keys.length > 6 ? ",…" : "") + "}";
    }
    return "?";
  }

  function digestIsland(key, data, extra) {
    try {
      const summary = {
        key,
        data: summarizeValue(data),
        hash: (JSON.stringify(data) || "").length,
        errorHasStatus: !!(extra && extra.errorHasStatus),
        sideChannel: !!(extra && extra.sideChannel),
        isCommand: !!(extra && extra.isCommand)
      };
      const prev = seen.get(key);
      if (!prev || prev.data !== summary.data) {
        seen.set(key, summary);
        return summary; // 新岛或内容变化
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function reportIslands(newOnes) {
    if (!newOnes.length) return;
    try {
      window.dispatchEvent(new CustomEvent("gqs-net-log", {
        detail: {
          kind: "island",
          method: "AF_DATA",
          status: -3,
          url: location.href.slice(0, 200),
          body: JSON.stringify(newOnes).slice(0, 3500),
          note: `数据岛快照 ×${newOnes.length}（服务端状态真相）`,
          ua: "page-data-island"
        }
      }));
      if (window.top !== window) {
        window.top.postMessage({ __gqsType: "netlog", entry: {
          kind: "island", method: "AF_DATA", status: -3,
          url: location.href.slice(0, 200),
          body: JSON.stringify(newOnes).slice(0, 3500),
          note: `数据岛快照 ×${newOnes.length}`,
          ua: "page-data-island"
        }}, "*");
      }
    } catch (_) {}
  }

  /* ---- 劫持 AF_initDataCallback：Google 前端注册数据岛时截获 ---- */
  let newOnes = [];
  const patchAF = () => {
    if (typeof window.AF_initDataCallback !== "function") {
      // Google 页面自己定义 AF_initDataCallback 后会重写它——我们抢先
      // 定义成转发器：Google 把它 assign 成真实现（页面 JS 会直接给
      // window.AF_initDataCallback 赋值），劫持用 defineProperty 拦 assign。
      try {
        let real = null;
        Object.defineProperty(window, "AF_initDataCallback", {
          configurable: true,
          get: () => (obj) => {
            try {
              const d = digestIsland(obj?.key, obj?.data, obj);
              if (d) newOnes.push(d);
            } catch (_) {}
            if (real) real(obj);
          },
          set: (fn) => { real = typeof fn === "function" ? fn : null; }
        });
      } catch (_) {}
    }
  };
  patchAF();

  /* ---- 解析静态 HTML 里的数据岛（首屏批)---- */
  function parseStaticIslands() {
    try {
      const html = document.documentElement.innerHTML;
      const re = /AF_initDataCallback\(\{key:\s*'([^']+)'[\s\S]*?data:(.*?)(?=AF_initDataCallback|<\/script>)/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        try {
          const raw = m[2].replace(/\}\);?$/, "").trim();
          // 只试着解析前 5000 字符，防超大岛
          const data = JSON.parse(raw.slice(0, 5000).replace(/,\s*$/, ""));
          const d = digestIsland(m[1], data, null);
          if (d) newOnes.push(d);
        } catch (_) { /* JSON 截断的岛跳过——原样存字符串尾部 */
          const d = digestIsland(m[1], raw.slice(0, 600), null);
          if (d) newOnes.push(d);
        }
      }
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      parseStaticIslands();
      if (newOnes.length) reportIslands(newOnes.splice(0));
    }, { once: true });
  } else {
    parseStaticIslands();
    if (newOnes.length) reportIslands(newOnes.splice(0));
  }

  // 动态注册的岛（Google 前端 assign 真实现后陆续喂进来）
  setInterval(() => {
    if (newOnes.length) reportIslands(newOnes.splice(0));
  }, 2000);
})();
