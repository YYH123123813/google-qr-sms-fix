/* Google QR 自动降级短信助手 - 修复版 content.js (v1.5.2)
 *
 * v1.5.2 变更（应对「手机号页仍报错了点问题、贴不出具体失败请求」）：
 *   1. 「复制诊断日志」输出升级：失败请求置顶、POST 请求次之，
 *      每条 body 深挖 ["er"]/["e",N]/报错文本等错误结构并以 ⚠ 标注。
 *   2. 诊断规则 3 重写：报错横幅出现时结合捕获证据定位根因
 *      （桌面 UA 混入 / 最后一条失败请求 / 捕获盲区三分支），
 *      不再复读三条泛化可能。
 *
 * v1.5.0 变更（对应「降级后进手机号页扩展消失、报错无法复制」）：
 *   1. 面板挂载白名单加入「降级后的手机号页」：
 *      /v3/signin/challenge/iap?...&idv_xdevice=1（不含 /qrcode）。
 *      之前降级跳转成功后 content script 直接 return，面板消失，
 *      报错信息无处复制。现在此页显示为右下角胶囊，点开有完整
 *      诊断区 + 复制诊断日志按钮。
 *   2. 诊断规则 2 收紧：旧正则把 batchexecute 正常响应里的数字数组
 *      （国家码等数据）也误判成业务错误，在手机号页必误报 critical。
 *      改为只认 ["er",...] 硬错误结构。
 *
 * v1.4.5 变更（「标题下全是白色、降级按钮不显示」的真凶）：
 *   TDZ（暂时性死区）ReferenceError：renderNetLog() 在 mountPanel 里
 *   被立即调用 → scheduleDiagnosis() 执行到 `if (diagTimer)` 时，
 *   `let diagTimer` 声明还没执行到 → 抛 ReferenceError → mountPanel
 *   当场崩溃，按钮/状态栏/提示来不及赋值（面板只剩标题，下面全白）。
 *   且面板 DOM 已挂上，守卫误判健康，永远不会重建。
 *   v1.4.3 归因于 Shadow DOM 样式失效是错误结论。
 *   修复：diagTimer / lastDiagText 声明移到 renderNetLog 之前。
 *
 * v1.4.6 变更：
 *   修复 runDowngrade 里的 ReferenceError：改局部变量名时把
 *   `cont` 写成了不存在的 `targetContinue`，注入成功后跳转阶段
 *   崩溃报「targetContinue is not defined」。改回引用 cont。
 */
(() => {
  const isCloudConsole = location.hostname === "console.cloud.google.com";
  const isQrPage = location.pathname.includes("/challenge/iap/qrcode");
  const isUpleveling = location.pathname.startsWith("/uplevelingstep");
  // v1.5.0：降级后的手机号输入页也在 /challenge/iap 下（URL 带 idv_xdevice=1）。
  // 之前只认二维码页，降级跳转后 name 面板直接消失——报错根本无从复制。
  const isPhonePage = location.pathname.startsWith("/v3/signin/challenge/iap")
    && !isQrPage
    && new URLSearchParams(location.search).get("idv_xdevice") === "1";

  if (!isCloudConsole && !isQrPage && !isUpleveling && !isPhonePage) {
    return;
  }

  /* ============ 网络日志收集 ============ */
  const netLog = [];
  let renderNetLog = () => {};

  function pushNetLog(entry) {
    entry.pageUrl = location.href.slice(0, 200);
    netLog.push(entry);
    if (netLog.length > 120) netLog.shift();
    try {
      chrome.runtime.sendMessage({ action: "appendNetLog", entry }).catch(() => {});
    } catch (_) {}
    renderNetLog();
  }

  window.addEventListener("gqs-net-log", (e) => {
    try { pushNetLog(e.detail); } catch (_) {}
  });

  // v1.6.0: iframe 里的 net_recorder 通过 postMessage 转发（CustomEvent 不跨 frame）
  window.addEventListener("message", (e) => {
    if (e.source === window) return; // Chrome 扩展自身消息源
    const d = e.data;
    if (d && d.__gqsType === "netlog" && d.entry) {
      try { pushNetLog(d.entry); } catch (_) {}
    }
  });

  // v1.6.0: 同 tab 导航后的 sessionStorage 回填（页面重置也丢不了记录）
  try {
    const ss = JSON.parse(sessionStorage.getItem("gqsNetLogSS") || "[]");
    for (const en of ss) {
      if (!netLog.some(x => x.t === en.t && x.url === en.url)) netLog.push(en);
    }
  } catch (_) {}

  /* ============ 深度分析引擎（v1.8.0）============
   * 输入：全量捕获(all) + RPC 插桩(rpcTrace) + 当前页 URL。
   * 输出：一段人话归因。每条结论都引用具体记录（时间+kind），
   * 拒绝泛化话术。覆盖五个判别维度：
   *   A. 会话指纹交叉验证（qrTl vs 提交的 TL vs 页面 TL → H2）
   *   B. 错误请求聚类（同端点重复失败 → 排除偶发；错误结构一致 → 定性）
   *   C. UA 一致性矩阵（每类请求的 UA → H4）
   *   D. 时间线重建（提交 → 报错 → 导航的因果顺序）
   *   E. YDtwf 语义核验（ctx34 上下文位置 → H1）
   */
  function deepAnalyze({ all, rpcTrace, wireLog, pageUrl }) {
    if (!all.length && !rpcTrace.length) return null;
    const out = [];

    /* ---- E. YDtwf 语义核验（H1）---- */
    const yd = rpcTrace.find(t => t.step === "YDtwf");
    if (yd) {
      if (yd.matched && yd.ctx34) {
        // [3,null,4] 的位置语义：在 wrb.fr 业务载荷内 vs 嵌套元数据
        const payloadish = /wrb\.fr[^]{0,80}\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(yd.raw || "")
          || (yd.ctx34 || "").includes("wrb.fr");
        out.push(`E. 降级RPC语义核验: matched=${yd.matched}，[3,null,4] 呈现形式${payloadish ? "在业务载荷层（倾向真实降级确认，H1 减弱）" : "不在业务载荷核心层（语义存疑，H1 未排除——需人工看 ctx34 全文）"}`);
      } else {
        out.push(`E. 降级RPC语义核验: matched=${yd.matched ?? "?"} — 降级未被服务端文本层面确认（H1 强信号）`);
      }
    } else {
      out.push("E. 降级RPC语义核验: 无 YDtwf 插桩记录（本 tab 未执行降级，或扩展版本过旧）");
    }

    /* ---- A. 会话指纹（H2）---- */
    const done = rpcTrace.find(t => t.step === "downgrade-done");
    const qrTl = done?.qrTl;
    const submitPosts = all.filter(e => (e.method || "").toUpperCase() === "POST" && /batchexecute/.test(e.url || ""));
    const lastSubmit = submitPosts[submitPosts.length - 1];
    const submitTl = lastSubmit?.reqBody?.match(/TL=([A-Za-z0-9_-]{10,})/)?.[1]
      || lastSubmit?.url?.match(/[?&](?:TL|tl)=([A-Za-z0-9_-]{10,})/)?.[1]
      || (lastSubmit?.reqBody && /AAxq|ADG-/.test(lastSubmit.reqBody) ? (lastSubmit.reqBody.match(/(AAxq[A-Za-z0-9_-]*|ADG-[A-Za-z0-9_-]*)/)?.[1]) : null);
    const pageTlHere = pageUrl.match(/[?&]TL=([A-Za-z0-9_-]{10,})/)?.[1];
    if (qrTl && submitTl) {
      const same = submitTl === qrTl || submitTl.includes(qrTl) || qrTl.includes(submitTl);
      out.push(`A. 会话指纹: 降级会话 tl=${qrTl.slice(0, 20)}… 提交携带=${submitTl.slice(0, 20)}… ${same ? "→ 同源（H2 排除）" : "→ 不同源！降级写进了另一个会话（H2 证实）"}`);
    } else if (qrTl) {
      out.push(`A. 会话指纹: 有降级会话 tl=${qrTl.slice(0, 20)}… 但未从提交请求中解析出 TL（reqBody 缺失或编码形态未知——把 reqBody 发维护者）`);
    } else if (submitTl) {
      out.push(`A. 会话指纹: 提交带 TL=${submitTl.slice(0, 20)}… 但无降级会话记录对照（本 tab 降级记录丢失或跨 tab）`);
    }

    /* ---- C. UA 一致性矩阵（H4）---- */
    const uaGroups = {};
    for (const e of all) {
      if (!e.ua) continue;
      const kind = /iPad/.test(e.ua) ? "iPad" : /iPhone/.test(e.ua) ? "iPhone" : /Macintosh|Windows/.test(e.ua) ? "桌面" : "其他";
      (uaGroups[kind] = uaGroups[kind] || []).push(e);
    }
    const uaSummary = Object.entries(uaGroups).map(([k, v]) => `${k}:${v.length}`).join(" ") || "无UA记录";
    const posts = all.filter(e => (e.method || "").toUpperCase() === "POST");
    const desktopPost = posts.find(e => /Macintosh|Windows/.test(e.ua || ""));
    out.push(`C. UA矩阵: ${uaSummary}${desktopPost ? ` ⚠ POST 中存在桌面身份（${(desktopPost.url || "").slice(0, 80)}）→ H4 证实（DNR 未盖住此路径）` : posts.length ? " POST 全部移动身份 → H4 排除" : " 无 POST 捕获 → H4 无法判"}`);

    /* ---- B. 错误聚类 ---- */
    const fails = all.filter(e => (e.status >= 400 || e.status === 0) && e.status !== -1 && e.status !== -2);
    if (fails.length) {
      const byUrl = {};
      for (const f of fails) {
        const key = (f.url || "").split("?")[0];
        (byUrl[key] = byUrl[key] || []).push(f);
      }
      const lines = Object.entries(byUrl).map(([u, list]) =>
        `${u.slice(0, 100)} ×${list.length} 状态=[${[...new Set(list.map(x => x.status))].join(",")}]`);
      out.push(`B. 失败聚类: ${fails.length} 条硬失败 →\n  ${lines.join("\n  ")}${Object.values(byUrl).some(l => l.length >= 2) ? "\n  （同端点重复失败 → 排除偶发/网络抖动，是确定性拒绝）" : ""}`);
    }

    /* ---- D. 时间线 ---- */
    const interesting = all.filter(e =>
      e.kind === "nav" ||
      (e.method || "").toUpperCase() === "POST" ||
      e.status >= 400 ||
      e.kind === "console" ||
      e.kind === "form" ||
      e.kind === "beacon"
    ).slice(-12);
    if (interesting.length) {
      out.push("D. 关键时间线（最后12条: POST/失败/导航/console）:\n  "
        + interesting.map(e => `${(e.t || "").slice(11, 23)} ${e.kind} ${e.status} ${(e.url || "").slice(0, 90)}`).join("\n  "));
    }

    /* ---- F. 数据岛解析（v2.3.0：服务端状态真相）----
     * AF_initDataCallback 数据岛是 Google 页面的服务端状态本体。
     * 从捕获的 island 记录里提取结构化事实：
     *   - 验证方式列表里有没有 SMS/短信 → 挑战是否允许短信路径
     *   - method/status/类字段 → 降级被认账与否的直接证据
     *   - 会话指纹（AAxq/ADG/S- 开头字符串）→ 与降级会话对照 */
    const islands = all.filter(e => e.kind === "island");
    if (islands.length) {
      const lines = [];
      const flat = islands.map(e => {
        try { return JSON.parse(String(e.body || "[]")); }
        catch (_) { return []; }
      }).flat();
      // 1. 验证方式清单：找含 SMS/voice/verification 关键词的岛
      const raw = JSON.stringify(flat);
      const smsHit = /sms|短信/.test(raw);
      const voiceHit = /voice|语音/.test(raw);
      const qrHit = /qrcode|二维码|qr_code/i.test(raw);
      lines.push(`方式清单信号: SMS=${smsHit ? "✔ 在数据岛里" : "✘ 未出现"} Voice=${voiceHit ? "✔" : "✘"} QR=${qrHit ? "✔" : "✘"}`);
      if (!smsHit) {
        lines.push(`→ ⚠ 服务端数据岛里找不到 SMS 路径证据 —— 此挑战在服务端可能根本未开放短信验证（降级未生效的最终实锤）；若页面却显示了短信表单，那就是客户端渲染的假象`);
      }
      // 2. 状态数字特征：[3,null,4] 同源结构的岛
      const fallbackIsland = flat.find(d =>
        /\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(String((d && d.data) || "")));
      if (fallbackIsland) {
        lines.push(`降级状态岛: ${fallbackIsland.key} 含 [3,null,4] —— 服务端页内数据承认降级状态`);
      }
      // 3. 会话指纹对照
      const islandTls = [...new Set((raw.match(/(?:AAxq[A-Za-z0-9_-]{8,}|ADG-[A-Za-z0-9_-]{4,}|S\d+-\d{4,})/g) || []).slice(0, 6))];
      if (islandTls.length) lines.push(`岛内会话指纹: ${islandTls.map(s => s.slice(0, 18) + "…").join(", ")}`);
      // 4. 错误岛
      const errIslands = flat.filter(d => d && d.errorHasStatus);
      if (errIslands.length) lines.push(`⚠ 错误状态岛: ${errIslands.map(d => d.key).join(", ")} — ${JSON.stringify(errIslands[0].data || null).slice(0, 200)}`);
      out.push("F. 数据岛解析（服务端状态真相）:\n  " + lines.join("\n  "));
    } else {
      out.push("F. 数据岛解析: 未捕获到 island 记录（扩展 <2.3.0 或 parseStaticIslands 未命中）");
    }

    /* ---- G. 字节级终审（v2.4.0）：手机号不通过的最终定罪 ----
     * 汇聚三个最深层证据源做出唯一裁决：
     *   1. wire-headers 的 verdictUA（DNR 是否真的上了网）
     *   2. mirror 的响应体字节（服务端拒绝的原文+错误结构特征）
     *   3. F 段的 SMS 开放性（服务端是否开了这条路径）
     * G 段存在的意义：用户拿到的不再是一堆证据，而是「不通过的唯一原因」。 */
    const wire = wireLog || [];
    const uaVerdicts = wire.filter(w => w.kind === "wire-headers");
    const mirrors = wire.filter(w => w.kind === "mirror");
    const lines2 = [];
    // 证据1：DNR 是否真的把 UA 换掉了（wire 层事实，不是 DNR 意图）
    const desktopLeak = uaVerdicts.find(w => w.verdictUA && w.verdictUA.includes("未转换"));
    if (uaVerdicts.length) {
      lines2.push(`wire-UA实况: ${uaVerdicts.slice(-3).map(w => w.verdictUA).join(" | ")}${desktopLeak ? " ⚠ 有桌面泄漏" : " ✅ 无桌面泄漏"}`);
    }
    // 证据2：镜像响应体的错误结构
    const mirrorBody = mirrors[0]?.body || "";
    const mirrorFeats = mirrors[0]?.feats || [];
    if (mirrors.length) {
      const erMatch = mirrorBody.match(/\[\s*"er"[^\]]*\]/);
      lines2.push(`镜像字节: status=${mirrors[0].status} feats=${JSON.stringify(mirrorFeats)}${erMatch ? `\n  拒绝原文: ${erMatch[0].slice(0, 200)}` : ""}`);
    }
    // 证据3：F 段已推入的 SMS 判据（从 out 里回收）
    const fLine = out.find(l => l.startsWith("F."));
    const smsBlocked = fLine && /SMS=✘/.test(fLine);
    // ---------- 唯一裁决 ----------
    let verdict;
    if (smsBlocked) {
      verdict = "【终审】不通过的唯一原因：服务端挑战配置里没有 SMS 路径（数据岛实证）。手机表单是客户端渲染的假象。任何提交层的修补都无效——需要换入口（Cloud Shell）或换降级策略（重写入后立即消费）。";
    } else if (desktopLeak) {
      verdict = `【终审】不通过的唯一原因：有 POST 以桌面 UA 上网（${desktopLeak.url.slice(0, 90)}），DNR 规则未覆盖该路径。下一步：把该 URL 模式补进 DNR 规则即可（这是可修的）。`;
    } else if (mirrors.length && /er-array|err-keywords/.test(JSON.stringify(mirrorFeats))) {
      verdict = "【终审】提交以正确身份发出但仍被拒；镜像字节已捕获服务端拒绝原文——把「G. 字节级终审」+「🔍字节镜像」两段发维护者，下一步照单修。";
    } else if (mirrors.length === 0 && uaVerdicts.length === 0) {
      verdict = "【终审待定】wire 层两队探针未上岗（版本 <2.4.0 或 POST 未发生）——⟳重载后重走，产生失败 POST 后 G 段自动定罪。";
    } else {
      verdict = "【终审待定】证据不足以唯一归因：UA 无泄漏、SMS 在配置中、镜像形态中性。把完整日志（含 wire 区）发维护者做人工终审。";
    }
    lines2.push(verdict);
    out.push("G. 字节级终审（手机号不通过的唯一原因）:\n  " + lines2.join("\n  "));
    return out.length ? out.filter(x => x !== null).join("\n") : null;
  }

  let ui = null;
  let mountTries = 0;

  function tryMount() {
    if (document.getElementById("gqs-fix-panel")) return true;
    if (!document.body) return false;
    mountPanel();
    return !!document.getElementById("gqs-fix-panel");
  }

  function mountWhenReady() {
    const done = tryMount();
    // 兜底：Google 前端框架可能在 DOMContentLoaded 后重建/清空 body，把面板一起带走。
    // 最多观察 15 秒，发现面板被移除就重新挂载。
    if (!done && mountTries++ < 30) {
      setTimeout(mountWhenReady, 500);
      return;
    }
    const guard = setInterval(() => {
      if (!document.body || !document.getElementById("gqs-fix-panel")) {
        tryMount();
      } else if (document.getElementById("gqs-fix-panel")?.isConnected !== false) {
        // 面板健康；一直保留守卫（开销可忽略：一个 getElementById）
      }
    }, 2000);
    void guard;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountWhenReady(), { once: true });
  } else {
    mountWhenReady();
  }

  function mountPanel() {
    if (document.getElementById("gqs-fix-panel")) return;

    /* ---- 全内联样式（与原版 v1.1.0 相同的、在该页面验证过的渲染方式） ---- */
    const panel = document.createElement("div");
    panel.id = "gqs-fix-panel";
    panel.style.cssText = [
      "position:fixed", "top:80px", "right:16px", "left:auto",
      "z-index:2147483647", "background:#1a73e8", "color:#fff",
      "padding:12px 14px", "border-radius:10px",
      "box-shadow:0 4px 16px rgba(0,0,0,0.35)",
      "font-family:system-ui,-apple-system,sans-serif", "font-size:13px",
      "display:flex", "flex-direction:column", "gap:8px",
      "width:310px", "box-sizing:border-box",
      "cursor:default"
    ].join(";");
    if (isUpleveling || isPhonePage) panel.style.display = "none";

    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;font-size:13px;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;gap:8px;";
    const tlabel = document.createElement("span");
    // v1.7.0：版本号直接读 manifest，不再手写——错版本号误导了好几轮排查
    tlabel.textContent = "⚡ 降级助手（读取版本…）";
    try {
      chrome.runtime.sendMessage({ action: "getVersion" }).then(v => {
        tlabel.textContent = `⚡ 降级助手 v${v?.version || "?"}（拖我）`;
      }).catch(() => {});
    } catch (_) {}
    title.appendChild(tlabel);
    const fold = document.createElement("span");
    fold.textContent = "收起";
    fold.style.cssText = "font-size:11px;font-weight:400;color:#bbccff;cursor:pointer;padding:2px 4px;";
    title.appendChild(fold);
    panel.appendChild(title);

    // 主操作按钮 —— 紧随标题第二行，样式全部内联（原版同款配色）
    const btn = document.createElement("button");
    btn.style.cssText = "background:#fff;color:#1a73e8;border:none;padding:9px 12px;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;";
    panel.appendChild(btn);

    const statusEl = document.createElement("div");
    statusEl.style.cssText = "font-size:12px;color:#e8f0fe;word-break:break-word;line-height:1.4;";
    panel.appendChild(statusEl);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px;color:#bbccff;line-height:1.4;";
    panel.appendChild(hint);

    const netlogEl = document.createElement("div");
    netlogEl.id = "gqs-netlog";
    netlogEl.style.cssText = "font-size:11px;color:#bbccff;";
    panel.appendChild(netlogEl);

    const diagEl = document.createElement("div");
    diagEl.id = "gqs-diagnosis";
    diagEl.style.cssText = "font-size:11px;color:#fff;background:rgba(0,0,0,0.25);padding:8px;border-radius:6px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow-y:auto;";
    panel.appendChild(diagEl);

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋 复制诊断日志";
    copyBtn.style.cssText = "background:#e8f0fe;color:#1a73e8;border:none;padding:6px 10px;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;font-family:inherit;";
    panel.appendChild(copyBtn);

    document.body.appendChild(panel);

    /* ---- 收起胶囊 ---- */
    const pill = document.createElement("div");
    pill.id = "gqs-fix-pill";
    pill.textContent = "🔍 降级助手诊断";
    pill.style.cssText = "position:fixed;bottom:20px;right:16px;z-index:2147483647;background:#1a73e8;color:#fff;padding:8px 12px;border-radius:16px;font:600 11px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.3);";
    if (!isUpleveling && !isPhonePage) pill.style.display = "none";
    document.body.appendChild(pill);

    fold.onclick = () => { panel.style.display = "none"; pill.style.display = "block"; };
    pill.onclick = () => { panel.style.display = "flex"; pill.style.display = "none"; };

    /* ---- 拖拽：用 left/top 定位（右定位在拖拽时换算） ---- */
    // 初始化时把 right 换成 left，保证拖拽坐标计算简单
    {
      const rect = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.left = rect.left + "px";
    }
    let dragging = null;
    title.addEventListener("pointerdown", (ev) => {
      if (ev.target === fold) return;
      const rect = panel.getBoundingClientRect();
      dragging = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
      title.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    title.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const x = Math.min(Math.max(0, ev.clientX - dragging.dx), window.innerWidth - 60);
      const y = Math.min(Math.max(0, ev.clientY - dragging.dy), window.innerHeight - 40);
      panel.style.left = x + "px";
      panel.style.top = y + "px";
    });
    title.addEventListener("pointerup", () => { dragging = null; });

    /* ---- 复制诊断（v1.7.0：版本硬标记 + RPC 插桩区 + 失败置顶 + reqBody）---- */
    copyBtn.onclick = async () => {
      let persisted = [];
      let rpcTrace = [];
      let wireLog = [];
      let extVersion = "?";
      try {
        const v = await chrome.runtime.sendMessage({ action: "getVersion" });
        extVersion = v?.version || "?";
      } catch (_) {}
      try {
        const res = await chrome.runtime.sendMessage({ action: "getNetLog" });
        persisted = res?.entries || [];
      } catch (_) {}
      try {
        const res2 = await chrome.runtime.sendMessage({ action: "getRpcTrace" });
        rpcTrace = res2?.entries || [];
      } catch (_) {}
      try {
        const res3 = await chrome.runtime.sendMessage({ action: "getWireLog" });
        wireLog = res3?.entries || [];
      } catch (_) {}
      // persisted 在前：storage 里的旧记录更早；时间的逆序不影响失败置顶
      const all = [...persisted, ...netLog];
      const isFail = e => e.status >= 400 || e.status === 0;
      const isPost = e => (e.method || "").toUpperCase() === "POST";
      // 失败请求 > POST 请求 > 其余，各自按时间升序
      const ordered = [
        ...all.filter(e => isFail(e)),
        ...all.filter(e => !isFail(e) && isPost(e)),
        ...all.filter(e => !isFail(e) && !isPost(e))
      ];
      const hdr = [
        `=== gqs 降级助手 v${extVersion} 诊断日志 ===`,
        `导出时间: ${new Date().toISOString()}`,
        `页面: ${location.href.slice(0, 200)}`,
        `navigator UA: ${navigator.userAgent.slice(0, 100)}`,
        `总记录: ${all.length}（失败 ${all.filter(isFail).length} / POST ${all.filter(isPost).length}）`,
        extVersion < "1.6.0" ? "⚠ 扩展版本过旧：无全POST捕获/iframe通道/RPC插桩，多处判别证据缺失。请⟳重载并刷新页面！" : "",
        `=====================================`,
        ``
      ].filter(Boolean).join("\n");
      const fmtEntry = e => {
        const lines = [`[${e.t}] ${e.kind}${e.frame ? "@" + e.frame : ""} ${e.method} ${e.status} ${e.url}`];
        lines.push(`  ua: ${(e.ua || "").slice(0, 80)}`);
        if (e.page) lines.push(`  page: ${e.pageUrl || e.page || ""}`);
        if (e.note) lines.push(`  note: ${e.note}`);
        if (e.reqHeaders && Object.keys(e.reqHeaders).length) {
          lines.push(`  reqHeaders: ${JSON.stringify(e.reqHeaders).slice(0, 400)}`);
        }
        if (e.reqBody) lines.push(`  reqBody: ${e.reqBody.slice(0, 500)}`);
        if (e.body) {
          lines.push(`  body: ${(e.body || "").slice(0, 600)}`);
          // 深挖 batchexecute 错误结构：Google 把业务错误藏在这些形态里
          const b = e.body;
          const errLines = [];
          const erM = b.match(/\[\s*"er"[^\]]*\]/g);
          if (erM) errLines.push(...erM.slice(0, 3));
          // "Something went wrong" 等文本错误
          const textErr = b.match(/(?:something went wrong|出了点问题|请重试)[^"\]]{0,50}/gi);
          if (textErr) errLines.push(...textErr.slice(0, 3));
          // wrb.e 错误载荷: ["e",N,...] 形态
          const eM = b.match(/\[\s*"e"\s*,\s*\d+[^\]]*\]/g);
          if (eM) errLines.push(...eM.slice(0, 3));
          if (errLines.length) lines.push(`  ⚠ 错误结构: ${errLines.join(" | ")}`);
        }
        return lines.join("\n");
      };
      /* ---- 深度分析引擎（v1.8.0）：从原始捕获做归因，不再让人肉读日志 ---- */
      const analysis = deepAnalyze({ all: ordered, rpcTrace, wireLog, pageUrl: location.href });

      const text = ordered.length || rpcTrace.length
        ? hdr
          + (analysis ? "── 深度分析（自动归因）──\n" + analysis + "\n\n" : "")
          + (rpcTrace.length
              ? "── RPC 链路插桩（H1/H2 判别证据）──\n"
                + rpcTrace.map(tr => {
                    // 通用渲染：所有字段都导出，不漏任何一个插桩点
                    const lines = [`[${tr.t || "?"}] ${tr.step || "?"}`];
                    for (const [k, v] of Object.entries(tr)) {
                      if (k === "t" || k === "step") continue;
                      if (v === undefined || v === null || v === "") continue;
                      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
                    }
                    return lines.join("\n");
                  }).join("\n\n")
                + "\n\n"
              : "")
          + (ordered.length ? ordered.map(fmtEntry).join("\n\n") : "（netLog 无记录）")
          + (wireLog.length
              ? "\n\n── 网络层（wire）记录：失败 + 全部POST，地面真相 ──\n"
                + wireLog.map(w => {
                    if (w.kind === "mirror") {
                      return `[${w.t}] 🔍字节镜像 ${w.status} ${w.url.slice(0, 110)}\n  ${w.verdict || ""}\n  feats=${JSON.stringify(w.feats || [])}\n  body: ${(w.body || "").slice(0, 800)}`;
                    }
                    if (w.kind === "wire-headers") {
                      return `[${w.t}] 🛡 UA验证 ${w.verdictUA} → ${w.url.slice(0, 110)} (${w.notes})`;
                    }
                    return `[${w.t}] ${w.wirePhase || w.kind} ${w.method} ${w.status} @${w.fromFrame} ${w.url.slice(0, 120)}${w.err ? ` err=${w.err}` : ""}`;
                  }).join("\n")
              : "")
        : hdr + "（无记录）";
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "✅ 已复制";
      } catch (_) {
        const w = window.open("", "_blank", "width=600,height=400");
        if (w) { w.document.title = "诊断日志"; w.document.body.textContent = text; }
      }
      setTimeout(() => { copyBtn.textContent = "📋 复制诊断日志"; }, 4000);
    };

    /* ---- 日志计数 + 诊断 ---- */
    // 注意：这两个声明必须放在 renderNetLog 定义和首次调用之前，
    // 否则 scheduleDiagnosis 读到 TDZ 未初始化变量 → ReferenceError →
    // mountPanel 中断，按钮/状态栏全部空白（v1.4.3 的真凶）。
    let diagTimer = null;
    let lastDiagText = null;
    renderNetLog = function () {
      const fails = netLog.filter(e => e.status >= 400);
      netlogEl.textContent =
        `📡 已捕获 ${netLog.length} 个验证请求` +
        (fails.length ? `，${fails.length} 个失败 ⚠️` : "");
      scheduleDiagnosis();
    };
    renderNetLog();

    function detectErrorBanner() {
      const text = document.body?.innerText || "";
      return (window.__gqsErrorBanners || []).some(b => text.includes(b))
        && /重试|Try again|something went wrong/i.test(text);
    }

    function scheduleDiagnosis() {
      if (diagTimer) return;
      diagTimer = setTimeout(async () => {
        diagTimer = null;
        try {
          if (typeof window.__gqsDiagnose !== "function") {
            diagEl.textContent = "⚠️ 诊断引擎未加载（请重载扩展）";
            return;
          }
          let persisted = [];
          try {
            const res = await chrome.runtime.sendMessage({ action: "getNetLog" });
            persisted = res?.entries || [];
          } catch (_) {}
          const findings = window.__gqsDiagnose({
            entries: [...persisted, ...netLog],
            pageUrl: location.href,
            errorBanner: detectErrorBanner()
          });
          const icon = { critical: "🚨", high: "⚠️", ok: "✅" };
          const text = findings.map(f =>
            `${icon[f.severity]} ${f.title}\n${f.detail}\n→ ${f.action}`
          ).join("\n\n");
          if (text !== lastDiagText) {
            lastDiagText = text;
            diagEl.textContent = text;
            const sev = findings[0]?.severity;
            diagEl.style.background =
              sev === "critical" ? "rgba(139,0,0,0.45)"
              : sev === "high" ? "rgba(180,100,0,0.35)"
              : "rgba(0,0,0,0.25)";
            if (panel.style.display === "none") {
              pill.textContent = sev === "critical"
                ? "🚨 降级助手：检测到问题，点开"
                : "🔍 降级助手诊断";
            }
            /* v2.2.0：诊断判定「提交被拒」时自动触发后台重放一次。
             * 每个页面生命周期只触发一次（防反复重放打扰会话）。 */
            if (sev === "critical" && !window.__gqsReplayFired
                && (detectErrorBanner() || /HTTP 4\d\d|HTTP 400/.test(text))) {
              window.__gqsReplayFired = true;
              triggerReplay(text);
            }
          }
        } catch (_) {}
      }, 600);
    }

    new MutationObserver(() => scheduleDiagnosis())
      .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(() => scheduleDiagnosis(), 3000);

    /* ---- v2.2.0：被动诊断 → 主动重放 ----
     * 重放引擎在后台（replaySubmitWithSession）：用降级会话凭证
     * 直接询问 devicephoneverification 会话机的权威状态。
     * 这里只做触发与结果展示，把「会话是否还活着」的权威回答
     * 第一时间亮到面板上——不再让用户等维护者离线分析。 */
    async function triggerReplay(diagText) {
      try {
        const lastPost = [...netLog].reverse().find(e => (e.method || "").toUpperCase() === "POST");
        const res = await chrome.runtime.sendMessage({
          action: "replaySubmit",
          capturedReqBody: (lastPost?.reqBody || "").slice(0, 500)
        });
        const verdict = res?.trace?.verdict || res?.error || "无结论";
        hint.textContent = `🔁 自动重放结果: ${verdict}`;
        netLog.push({
          t: new Date().toISOString(), kind: "replay", method: "PROBE",
          status: res?.trace?.status ?? res?.ok ? 200 : 0,
          url: "background:replaySubmitWithSession",
          body: String(verdict), ua: "extension-bg"
        });
        renderNetLog();
      } catch (_) {}
     }

    /* ---- 各页面分支 ---- */
    if (isCloudConsole) {
      statusEl.textContent = "第 1 步：点击右上角 [>_] 唤出 Verify 弹窗，或点下方按钮";
      hint.textContent = "必须从 Cloud Shell → Verify 进入";
      btn.textContent = "1. 自动点击 Cloud Shell 图标";
      btn.onclick = () => {
        const shellBtn = document.querySelector('button[aria-label*="Cloud Shell"], button[mattooltip*="Cloud Shell"], [id*="cloudshell"]');
        if (shellBtn) {
          shellBtn.click();
          statusEl.textContent = "✅ 已点击终端图标，等待 Verify 按钮...";
          setTimeout(() => {
            const verifyBtn = Array.from(document.querySelectorAll("button, a"))
              .find(b => b.textContent.trim() === "Verify");
            if (verifyBtn) {
              verifyBtn.click();
              statusEl.textContent = "✅ 已自动点击 Verify！";
            }
          }, 2500);
        } else {
          statusEl.textContent = "⚠️ 未找到终端按钮，请手动点击右上角 [>_]";
        }
      };
    } else if (isQrPage) {
      statusEl.textContent = "已检测到二维码页，点击按钮注入 [3,null,4] 并跳转短信选择页";
      hint.textContent = "若提示二维码过期，关闭弹窗重新点 Verify 换新码";
      btn.textContent = "⚡ 一键降级到短信选择框";
      btn.onclick = () => runDowngrade();
    } else if (isUpleveling) {
      /* ---- v2.1.0 闭环：落地健康检查 + 双指纹自愈 ----
       * 合成跳转（b 分支）是一次性赌注：pageTl 若不被 selection 页认账，
       * 页面会渲染 Google 报错或重定向回挑战页，用户只会看到「又失败了」。
       * 现在落地后主动校验三个健康信号：
       *   1) URL 带 idv_xdevice=1（降级开关到达）
       *   2) 后台存在有效降级会话（最近 30 分钟内）
       *   3) 页面渲染了真正的选择组件（短信/语音/fallback 文案或表单元素）
       * 三个信号任一缺失 → 判定 landing 失败 → 自动用另一个 TL 指纹
       * （qrTl：降级状态实际写入的会话钥匙）重新合成跳转（只自愈一次，
       * 防死循环）。选择页 TL 有两个候选：pageTl（v3 AAxq）与 qrTl（ADG）。
       * 离线无法判知哪个被认账，但工程上不需要判——主跳 pageTl，
       * 落地失败换 qrTl，两条都失败则明确报告并停机。 */
      btn.textContent = "清除降级会话记录";
      btn.onclick = async () => {
        await chrome.runtime.sendMessage({ action: "clearSession" });
        statusEl.textContent = "已清除会话记录。";
      };
      hint.textContent = "展开胶囊查看自动诊断；Google 报错时这里会给出原因";
      verifyLandingAndHeal(statusEl, hint);
    } else if (isPhonePage) {
      // v2.0.0：正常流程不会再落到这页（跳转目标已改为合成的 selection）。
      // 仍在此页说明走了旧版代码或流程被 Google 打回——明确警示。
      statusEl.textContent = "⚠️ 本页是 v1.x 的死路分支（/challenge/iap 的手机表单是客户端画的，服务端不认）。若面板标题不是 v2.0.0+，请⟳重载扩展并关掉所有Google标签页重试。若是 v2.0.0+ 落到这，说明合成跳转被打回——复制诊断日志。";
      hint.textContent = "正确流程应落在 uplevelingstep/selection（选短信/语音的那页），不是这页。";
      btn.textContent = "清除降级会话记录";
      btn.onclick = async () => {
        await chrome.runtime.sendMessage({ action: "clearSession" });
        statusEl.textContent = "已清除会话记录。";
      };
    }

    ui = { statusEl, btn, hint };
  }

  /* ============ v2.1.0 落地闭环：健康检查 + 双指纹自愈 ============ */
  async function verifyLandingAndHeal(statusEl, hint) {
    const params = new URLSearchParams(location.search);
    const hasX = params.get("idv_xdevice") === "1";
    const landedTl = params.get("TL") || params.get("tl") || "";
    let session = null;
    try {
      session = await chrome.runtime.sendMessage({ action: "getSession" });
    } catch (_) {}

    const sessionFresh = session && (Date.now() - (session.savedAt || 0)) < 30 * 60 * 1000;

    // 健康信号3：等页面渲染稳定后检查选择组件（Google 报错时 body 是挑战页文案）
    const looksHealthy = await new Promise(resolve => {
      let tries = 0;
      const check = () => {
        const text = (document.body?.innerText || "").slice(0, 4000);
        const hasRadio = document.querySelector('input[type="radio"], [role="radio"]');
        const hasPhoneForm = document.querySelector('input[type="tel"], input[name*="phone" i]');
        const hasError = /抱歉，出了点问题|something went wrong|请重试|try again|unable to verify|无法验证/i.test(text);
        if (hasError) return resolve(false);
        if (hasRadio || hasPhoneForm) return resolve(true);
        if (++tries < 20) return setTimeout(check, 500); // 最多等 10s
        resolve(null); // 判不出（可能还在加载）
      };
      check();
    });

    try {
      if (hasX && sessionFresh && looksHealthy !== false) {
        statusEl.textContent = `✅ 落地健康（TL=${landedTl.slice(0, 16)}…）。选验证方式 → 输手机号 → 输入短信验证码即可。此页扩展不干预请求。`;
        if (looksHealthy === null) hint.textContent = "组件识别超时但无报错·若页面显示的不是选择/手机组件，清除记录重头走。诊断照常运行。";
        return;
      }

      /* ---- landing 失败 → 自愈 ---- */
      const otherTl = session && sessionFresh && session.tl
        ? session.tl
        : null;
      const usedOther = sessionStorage.getItem("gqsHealedWith") === "1";

      if (!usedOther && otherTl && otherTl.slice(0, 16) !== landedTl.slice(0, 16)) {
        sessionStorage.setItem("gqsHealedWith", "1");
        const u = new URL(location.href);
        u.searchParams.set("TL", otherTl);
        statusEl.textContent = `⚠️ 落地校验失败（x=${hasX} 会话=${sessionFresh ? "有效" : "无"} 健康=${looksHealthy}），正在用 QR 会话指纹（tl=${String(otherTl).slice(0, 14)}…）重新跳转…`;
        try { await chrome.runtime.sendMessage({ action: "appendRpcTrace", trace: { step: "landing-heal", fromTl: landedTl.slice(0, 40), toTl: String(otherTl).slice(0, 40), why: `x=${hasX},fresh=${sessionFresh},healthy=${looksHealthy}` } }); } catch (_) {}
        setTimeout(() => { location.href = u.toString(); }, 800);
        return;
      }

      // 两条指纹都试过或无第二指纹 → 明确停机报告
      statusEl.textContent = `❌ 落地失败且无法自愈（已试 TL=${landedTl.slice(0, 14)}…${usedOther ? " + QR指纹" : ""}；无第二指纹可用）。本会话的 selection 页不认任何已知指纹——复制诊断日志，然后清除记录、重新 Verify 拿全新二维码重走。`;
      try { await chrome.runtime.sendMessage({ action: "appendRpcTrace", trace: { step: "landing-fail-final", landedTl: landedTl.slice(0, 40), healed: usedOther } }); } catch (_) {}
    } catch (_) {}
  }

  /* ============ 二维码页：降级流程（与 v1.4.1 相同）============ */
  async function extractQrUrlFromPage() {
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const mediaEls = Array.from(document.querySelectorAll("img, canvas"));
      for (const el of mediaEls) {
        try {
          if (el.clientWidth > 80 && el.clientHeight > 80) {
            const c = document.createElement("canvas");
            c.width = el.naturalWidth || el.clientWidth || 300;
            c.height = el.naturalHeight || el.clientHeight || 300;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(el, 0, 0, c.width, c.height);
            const codes = await detector.detect(c);
            if (codes?.length > 0 && codes[0].rawValue) {
              return codes[0].rawValue;
            }
          }
        } catch (_) {}
      }
    }
    const bodyText = document.body?.innerText || "";
    const shortMatch = bodyText.match(/g\.co\/verify\/[A-Za-z0-9_-]+/);
    if (shortMatch) return "https://" + shortMatch[0];
    const html = document.documentElement.innerHTML;
    const m = html.match(/https:\/\/accounts\.google\.com\/devicephoneverification\/begin\?[^"'\s<>]+/);
    if (m) return m[0].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
    throw new Error("未能在当前页面识别到二维码，请确认二维码图片已完全加载");
  }

  function extractPageTl() {
    const params = new URLSearchParams(location.search);
    if (params.get("TL")) return params.get("TL");
    if (params.get("tl")) return params.get("tl");
    const cont = params.get("continue");
    if (cont) {
      try {
        const contUrl = new URL(cont, location.origin);
        if (contUrl.searchParams.get("TL")) return contUrl.searchParams.get("TL");
        if (contUrl.searchParams.get("tl")) return contUrl.searchParams.get("tl");
      } catch (_) {}
    }
    return document.documentElement.innerHTML.match(/ADG-[A-Za-z0-9_-]+/)?.[0] || null;
  }

  async function runDowngrade() {
    if (!ui) return;
    const { statusEl, btn } = ui;
    try {
      btn.disabled = true;
      btn.textContent = "正在识别二维码...";
      sessionStorage.setItem("gqsHealedWith", "0"); // v2.1.0: 新一轮降级重置自愈标记
      const qrUrl = await extractQrUrlFromPage();
      const pageTl = extractPageTl();

      statusEl.textContent = "已提取二维码，正在后台注入降级状态 [3,null,4]...";
      const params = new URLSearchParams(location.search);
      const cont = params.get("continue") || "";

      const res = await chrome.runtime.sendMessage({
        action: "downgradeQr",
        qrUrl,
        pageTl,
        targetContinue: cont
      });
      if (!res || !res.ok) {
        throw new Error(res ? res.error : "后台请求失败");
      }
      if (!/\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(res.ydResp)) {
        statusEl.textContent = "⚠️ 服务端未确认降级状态：\n" + res.ydResp.slice(0, 100);
        btn.disabled = false;
        btn.textContent = "重试一键降级";
        return;
      }

      statusEl.textContent = "✅ 降级状态注入成功！正在等待服务端确认（写读一致性网关）...";

      /* ---- v2.5.0：确认后才跳转 ----
       * YDtwf 返回 ≠ 服务端已可读。轮询 begin 端点回读，
       * 直到降级/SMS 特征出现（后台 confirmDowngrade，最多 4 次
       * 指数退避 ~5.4s）。未确认也继续跳（行为同旧版），但结果
       * 留痕进插桩时间线；确认了则带着 attempts 信息跳。 */
      let confirmed = null, confirmAttempts = 0;
      try {
        confirmed = await chrome.runtime.sendMessage({
          action: "confirmDowngrade",
          dsh: res.dsh, tl: res.qrTl, plt: res.plt
        });
        confirmAttempts = confirmed?.attempts || 0;
      } catch (_) {}
      if (confirmed?.confirmed) {
        statusEl.textContent = `✅ 服务端已确认降级状态（${confirmed.signal}，第 ${confirmAttempts} 次探测命中）！正在跳转...`;
      } else {
        statusEl.textContent = "⚠️ 降级已提交但 4 次回读均未见确认特征——仍尝试跳转（可能复制延迟大于窗口）；若落地失败，自愈引擎会接手。";
      }

      /* ---- v2.0.0 核心修复：三段式跳转目标构造 ----
       * 之前的 fallback（退回 /challenge/iap + 补 idv_xdevice=1）是死路：
       * 该页属于 v3/signin 挑战机，降级状态写的是 devicephoneverification
       * 会话机，提交手机号必然被拒（「出了点问题」八轮未解的真因）。
       * 正确目标只有一个：uplevelingstep/selection —— 上游 Cloud Shell
       * 入口的 continue 天生指向它，且降级状态与它同会话机。
       *
       * 优先级：
       *   a) continue 本身就是 uplevelingstep → 直接用（上游原生路径）
       *   b) continue 是其他站（GlifWebSignIn 等）→ 用会话指纹合成
       *      uplevelingstep/selection URL（TL 用页面自己的，这是 v3 会话
       *      与降级状态共用的桥；authuser/dsh/flowName 从当前 URL 继承）
       *   c) 兜底不再跳 iap —— 明确报错，宁可停下也不能进假短信流程 */
      let targetUrl;

      // a) continue 天生指向 uplevelingstep（Cloud Shell 入口）
      if (cont.startsWith("https://accounts.google.com/uplevelingstep/")) {
        const u = new URL(cont);
        u.searchParams.set("idv_xdevice", "1");
        if (u.searchParams.has("authuser") && u.searchParams.get("authuser") === "") {
          u.searchParams.set("authuser", "0");
        }
        if (!u.searchParams.has("TL") && pageTl) {
          u.searchParams.set("TL", pageTl);
        }
        targetUrl = u.toString();
      } else if (pageTl) {
        // b) v2.0.0：合成 uplevelingstep/selection（与上游 Cloud Shell 入口
        //    生成同构：TL=...&authuser=0&flowName=GlifWebSignIn&sarp=1&scc=1）
        const here = new URL(location.href);
        const u = new URL("https://accounts.google.com/uplevelingstep/selection");
        u.searchParams.set("TL", pageTl);
        u.searchParams.set("authuser", here.searchParams.get("authuser") || "0");
        const flowName = here.searchParams.get("flowName");
        if (flowName) u.searchParams.set("flowName", flowName);
        u.searchParams.set("sarp", "1");
        u.searchParams.set("scc", "1");
        u.searchParams.set("idv_xdevice", "1");
        targetUrl = u.toString();
        statusEl.textContent = `✅ 注入成功！continue 非验证页（${(cont || "空").slice(0, 40)}…），已合成 uplevelingstep/selection 跳转（TL 来自本页会话）...`;
      } else {
        // c) 无会话指纹：明确失败，绝不进入假流程
        statusEl.textContent = "❌ 页面缺少 TL 会话指纹，无法构造合法的 selection 页跳转。请回到 Cloud Shell → Verify 重新进入（勿用第三方入口的旧标签页）。";
        btn.disabled = false;
        btn.textContent = "重试一键降级";
        return;
      }
      location.href = targetUrl;
    } catch (e) {
      statusEl.textContent = "❌ " + (e?.message || e);
      btn.disabled = false;
      btn.textContent = "重试一键降级";
    }
  }
})();
