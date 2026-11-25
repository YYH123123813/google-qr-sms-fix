/* Google QR 自动降级短信助手 - 修复版 background.js (v1.5.1)
 *
* 修复的问题：降级进入短信验证页后，输入手机号提交时卡死，随后整个流程
 * 被重置回最初的登录/二维码页。
 *
 * 根因分析：
 *  1. 提交手机号/验证码走 /_/IdvUplevelingUi/data/batchexecute，这一步要求与
 *     进入 selection 页时完全一致的请求环境；v1.1.0 的 DNR 规则只覆盖了
 *     main_frame/sub_frame/xmlhttprequest/other 四种 resourceType，
 *     prefetch / ping 等请求混入桌面 UA/Client Hints，环境校验失败 → 会话作废。
 *  2. Google 在 selection → 短信页 → 验证码页之间导航时可能丢掉
 *     idv_xdevice=1，服务端把后续提交当新会话 → 400/重定向回登录。
 *  3. 未检查二维码 ds:0 过期错误就注入 YDtwf，等于锁定一个已失效的降级状态。
 *  4. YDtwf 单发无重试；UUID 提取失败直接中断（缺少多源回退）。
 */

const ACCOUNTS_ORIGIN = "https://accounts.google.com";
const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const CLIENT_HINT_HEADERS = [
  "Sec-CH-UA",
  "Sec-CH-UA-Mobile",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Full-Version",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
  "Sec-CH-UA-WoW64",
  "Sec-CH-UA-Form-Factors"
];

/* 真实 iPad Safari 不会发送这些桌面 Chrome 专有头。
 * 抓包证实：改了 UA 却留下 x-client-data / x-browser-* 等头，
 * Google 风控直接看出环境矛盾（UA 说 iPad、头部说桌面 Chrome）。
 * 注意：x-same-domain 是 Google RPC 的 CSRF 校验头，不能删。 */
const CHROME_ONLY_HEADERS = [
  "X-Client-Data",
  "X-Browser-Validation",
  "X-Browser-Year",
  "X-Browser-Channel",
  "X-Browser-Copyright",
  "X-Chrome-Id-Consistency-Request",
  "X-Sec-CH-UA-Not-A-Border"
];

/* ---------- 修复点 1（v1.2.1 修正）：DNR 规则收窄作用域 ----------
 * 教训：v1.2.0 把伪装应用到整个 accounts.google.com，连 /v3/signin/* 登录
 * 流程也被换成了 iPad UA（还带着桌面 Chrome 专有头），BotGuard 风控检测
 * 到环境矛盾 → 「抱歉，出了点问题」→ 会话被重置回登录页。
 * 现在只在真正的 IDV 验证子流程里伪装，登录流程保持真实桌面 Chrome 身份：
 *   - /uplevelingstep/*          （选择页/短信页/验证码页导航）
 *   - /_/IdvUplevelingUi/*       （提交手机号/验证码的 batchexecute）
 *   - /devicephoneverification/*  （降级 RPC，iPhone 身份模拟扫码）
 * 不指定 resourceTypes = 覆盖该路径下所有请求类型。 */
function modifyHeadersRule(id, priority, urlFilter, ua) {
  return {
    id,
    priority,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "User-Agent", operation: "set", value: ua },
        ...CLIENT_HINT_HEADERS.map(h => ({ header: h, operation: "remove" })),
        ...CHROME_ONLY_HEADERS.map(h => ({ header: h, operation: "remove" }))
      ]
    },
    condition: { urlFilter }
  };
}

/* ---------- v1.5.1：覆盖 fallback 入口的手机号页 ----------
 * 用户实测：GlifWebSignIn 等第三方入口降级后不落 uplevelingstep，
 * 而是落在 /v3/signin/challenge/iap?...&idv_xdevice=1，手机号提交走
 * AccountsSignInUi batchexecute（source-path=/v3/signin/challenge/iap）。
 * v1.2.x 的规则完全没盖住这条链 → 页面以桌面 Chrome 身份提交（日志
 * 实证 UA=Macintosh），与降级时的 iPhone/iPad 身份矛盾 → 风控作废
 * 会话 →「抱歉，出了点问题」。
 * 规则 4：裸 iap 页主文档导航 → iPad（regex 带 \? 才不会误伤
 *         /iap/qrcode 二维码子路径——QR 页必须保持桌面身份）
 * 规则 5：从 iap 页发出的 AccountsSignInUi batchexecute（source-path
 *         匹配）→ iPad。XHR 的 URL 不带页面参数，source-path 是唯一锚点。 */
function modifyHeadersRegexRule(id, priority, regexFilter, ua) {
  return {
    id,
    priority,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "User-Agent", operation: "set", value: ua },
        ...CLIENT_HINT_HEADERS.map(h => ({ header: h, operation: "remove" })),
        ...CHROME_ONLY_HEADERS.map(h => ({ header: h, operation: "remove" }))
      ]
    },
    condition: { regexFilter }
  };
}

const UPDATE_RULE_IDS = [1, 2, 3, 4, 5];

function setupRules() {
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: UPDATE_RULE_IDS,
    addRules: [
      // 规则 1：IDV 提升流程的页面导航 → iPad Mini
      modifyHeadersRule(1, 1, "||accounts.google.com/uplevelingstep/*", IPAD_MINI_UA),
      // 规则 2：后台降级 RPC（模拟手机扫码）→ iPhone
      modifyHeadersRule(2, 10, "||accounts.google.com/devicephoneverification/*", IPHONE_UA),
      // 规则 3：提交手机号/验证码的 batchexecute → iPad Mini
      modifyHeadersRule(3, 1, "||accounts.google.com/_/IdvUplevelingUi/*", IPAD_MINI_UA),
      // 规则 4（v1.5.1）：降级后的手机号页主文档 → iPad Mini
      modifyHeadersRegexRule(4, 1,
        "^https://accounts\\.google\\.com/v3/signin/challenge/iap\\?", IPAD_MINI_UA),
      // 规则 5（v1.5.1）：手机号页的 AccountsSignInUi 提交 → iPad Mini
      modifyHeadersRegexRule(5, 1,
        "^https://accounts\\.google\\.com/v3/signin/_/AccountsSignInUi/data/batchexecute\\?.*source-path=%2[Ff]v3%2[Ff]signin%2[Ff]challenge%2[Ff]iap", IPAD_MINI_UA)
    ]
  });
}

/* ---------- v1.6.0：RPC 链路插桩（H1/H2 判别证据）----------
 * 存进 storage.session 的独立键，与 netLog 分开导出：
 *   - step:  init-begin / MypxBd / YDtwf / downgrade-done
 *   - [3,null,4] 不再只做子串匹配：记录它的上下文（前后各 120 字符），
 *     供离线核验它到底出现在 payload 的哪一层、语义是不是「降级确认」。
 *   - QR 侧 tl 与页面 TL 的指纹对照（H2：是否写进了另一次挑战）。 */
async function appendRpcTrace(trace) {
  try {
    const data = await chrome.storage.session.get("gqsRpcTrace");
    const arr = data?.gqsRpcTrace || [];
    trace.t = new Date().toISOString();
    arr.push(trace);
    while (arr.length > 60) arr.shift();
    await chrome.storage.session.set({ gqsRpcTrace: arr });
  } catch (_) {}
}

function ctxAround(haystack, needle, span = 120) {
  try {
    const i = haystack.indexOf(needle);
    if (i < 0) return null;
    return haystack.slice(Math.max(0, i - span), i + needle.length + span);
  } catch (_) {
    return null;
  }
}

/* ---------- 修复点 2：降级会话粘性 ----------
 * 把降级成功的会话参数存进 chrome.storage.session，
 * 供 content script 在每次 uplevelingstep 导航时补齐丢失的参数。 */
const SESSION_KEY = "downgrade_session";

async function saveSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: session }).catch(() => {});
  // 允许 content script 通过消息读取会话（storage.session 默认只对扩展上下文可见）
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  } catch (_) {}
}

async function getSession() {
  try {
    const data = await chrome.storage.session.get(SESSION_KEY);
    return data?.[SESSION_KEY] || null;
  } catch (_) {
    return null;
  }
}

/* ---------- RPC 客户端 ---------- */
async function fetchText(url, opts = {}) {
  const resp = await fetch(url, { credentials: "include", ...opts });
  if (!resp.ok) {
    throw new Error(`请求失败 (HTTP ${resp.status}): ${url.slice(0, 120)}`);
  }
  return { resp, text: await resp.text() };
}

async function resolveShortVerifyUrl(qrUrl) {
  if (!qrUrl.includes("g.co/verify/")) return qrUrl;
  const { resp, text } = await fetchText(qrUrl);
  if (resp.url.includes("devicephoneverification/begin")) return resp.url;
  const m = text.match(/devicephoneverification\/begin\?[^"'\s<>]+/);
  if (!m) throw new Error("无法从 g.co/verify 页面提取 devicephoneverification/begin URL");
  return `${ACCOUNTS_ORIGIN}/` + m[0]
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&quot;.*$/, "");
}

async function fetchInitiateContext(targetUrl, pageTl) {
  const { resp, text: html } = await fetchText(targetUrl);

  /* v1.6.0 插桩〔H2〕：把 QR 侧会话指纹存入诊断日志。
   * 如果这里记录的 tl 与手机号页的 TL 不同源，说明降级写进了
   * 另一次挑战（旧二维码/父页面 TL 已换新），提交必挂。 */
  try {
    const begUrl = (resp.url || targetUrl).slice(0, 300);
    await appendRpcTrace({
      step: "init-begin",
      url: begUrl,
      pageTl: String(pageTl || "").slice(0, 60),
      keysFound: {
        SNlM0e: /"SNlM0e":"([^"]+)"/.test(html),
        Qzxixc: /"Qzxixc":"([^"]+)"/.test(html)
      },
      ds0Summary: (() => {
        const m = html.match(/key:\s*['"]ds:0['"][^}]{0,200}/s);
        return m ? m[0].slice(0, 200) : null;
      })()
    });
  } catch (_) {}

  /* 修复点 3：先检查二维码会话是否已过期/报错。
   * 二维码过期时 v1.1.0 仍继续注入 YDtwf，等于把一个失效会话标记为
   * “非 Android 已确认”，后续手机号提交必然被打回，前端卡死后重置流程。 */
  const ds0Err = html.match(
    /AF_initDataCallback\(\{key:\s*['"]ds:0['"][^)]*data:\s*\[(\d+)\][^)]*errorHasStatus:\s*true/s
  );
  if (ds0Err) {
    const code = ds0Err[1];
    throw new Error(
      code === "9"
        ? "二维码验证会话已过期（ds:0 error [9]），请关闭弹窗重新点 Verify 获取新二维码。"
        : `Google 验证初始化错误（ds:0 error [${code}]），请重新获取二维码。`
    );
  }

  const at = html.match(/"SNlM0e":"([^"]+)"/)?.[1] || null;
  const dsh = html.match(/"Qzxixc":"([^"]+)"/)?.[1] || null;
  const ds0Token = html.match(
    /AF_initDataCallback\(\{key:\s*['"]ds:0['"][^)]*?data:\s*\[\s*"([^"]+)"/s
  )?.[1] || null;

  const initUrl = new URL(resp.url || targetUrl, ACCOUNTS_ORIGIN);
  const reqUrl = new URL(targetUrl, ACCOUNTS_ORIGIN);
  const tl = ds0Token
    || initUrl.searchParams.get("tl")
    || initUrl.searchParams.get("TL")
    || reqUrl.searchParams.get("tl")
    || reqUrl.searchParams.get("TL")
    || (html.match(/ADG-[A-Za-z0-9_-]+/)?.[0] ?? null)
    || pageTl
    || null;
  const plt = initUrl.searchParams.get("plt") || reqUrl.searchParams.get("plt") || "";

  const missing = [];
  if (!at) missing.push("SNlM0e");
  if (!dsh) missing.push("Qzxixc");
  if (!tl && !plt) missing.push("TL/plt");
  if (missing.length) {
    throw new Error(`未能从二维码页面提取出 ${missing.join(" / ")} 参数（页面可能已过期，请重新获取二维码）`);
  }
  return { at, dsh, tl, plt };
}

async function executeBatchRpc({ rpcid, payload, sourcePath, at, tl }) {
  const query = new URLSearchParams({
    rpcids: rpcid,
    "source-path": sourcePath,
    hl: "en",
    rt: "c"
  });
  if (tl) query.set("tl", tl);
  const url = `${ACCOUNTS_ORIGIN}/devicephoneverification/_/DevicePhoneVerificationUi/data/batchexecute?${query}`;
  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]),
    at
  });
  const { text } = await fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString()
  });
  return text;
}

/* 修复点 4：UUID 多源提取 + 容错（不因 consent 404 中断整个降级）。 */
async function fetchConsentUuid({ dsh, plt, tl, mypxResp }) {
  const q = new URLSearchParams({ flow: "browser", dsh, hl: "en" });
  if (plt) q.set("plt", plt);
  if (tl) q.set("tl", tl);
  const consentUrl = `${ACCOUNTS_ORIGIN}/devicephoneverification/consent?${q}`;
  try {
    const { resp, text } = await fetchText(consentUrl);
    return (
      text.match(UUID_RE)?.[0]
      || (resp.url && resp.url.match(UUID_RE)?.[0])
      || (mypxResp && mypxResp.match(UUID_RE)?.[0])
      || null
    );
  } catch (_) {
    return (mypxResp && mypxResp.match(UUID_RE)?.[0]) || null;
  }
}

/* 修复点 5：YDtwf 带重试。v1.1.0 单发失败后服务端没有降级状态，
 * 前端却照常跳 selection，提交手机号时必然 400 → 卡死 → 重置。 */
async function submitFallbackWithRetry(context, rid, attempts = 2) {
  let lastResp = "";
  for (let i = 0; i < attempts; i++) {
    lastResp = await executeBatchRpc({
      rpcid: "YDtwf",
      payload: [null, rid, context.dsh, 7, null, context.tl || null, false],
      sourcePath: "/devicephoneverification/modacintro",
      at: context.at,
      tl: context.tl
    });
    if (/\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(lastResp)) return lastResp;
    // 服务端明确拒绝(406/400 会在 fetchText 抛错)，若只是返回非 [3,null,4] 稍候重试
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 800));
  }
  return lastResp;
}

async function downgradeQrUseCase({ qrUrl, pageTl, targetContinue }) {
  const targetUrl = await resolveShortVerifyUrl(qrUrl);
  const ctx = await fetchInitiateContext(targetUrl, pageTl);

  // MypxBd (initiate consent) — 失败仅告警（部分流程它并非必需）
  let mypxResp = "";
  try {
    mypxResp = await executeBatchRpc({
      rpcid: "MypxBd",
      payload: [ctx.tl || null, ctx.dsh, false, null, null, false, null, null, "browser"],
      sourcePath: "/devicephoneverification/initiate",
      at: ctx.at,
      tl: ctx.tl
    });
    await appendRpcTrace({
      step: "MypxBd",
      ok: true,
      has34: mypxResp.includes("[3,null,4]"),
      snippet: mypxResp.slice(0, 180)
    });
  } catch (err) {
    console.warn("MypxBd request warning:", err);
    await appendRpcTrace({
      step: "MypxBd",
      ok: false,
      error: String(err && err.message || err).slice(0, 200)
    });
  }

  let rid = await fetchConsentUuid({ dsh: ctx.dsh, plt: ctx.plt, tl: ctx.tl, mypxResp });
  if (!rid) rid = crypto.randomUUID();

  const ydResp = await submitFallbackWithRetry(ctx, rid);
  /* v1.6.0 插桩〔H1〕：记录 [3,null,4] 出现的确切上下文 + 原始响应，
   * 供离线核验语义（不再是「包含子串 = 成功」的黑箱）。 */
  await appendRpcTrace({
    step: "YDtwf",
    matched: /\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(ydResp),
    ctx34: ctxAround(ydResp, "[3,null,4]"),
    raw: ydResp.slice(0, 800)
  });
  if (!/\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(ydResp)) {
    throw new Error(`降级状态注入失败，服务端未返回 [3,null,4]。响应片段: ${ydResp.slice(0, 120)}`);
  }

  // 记录会话供 content script 做参数粘性
  await appendRpcTrace({
    step: "downgrade-done",
    qrTl: String(ctx.tl || "").slice(0, 60),
    rid,
    targetContinue: String(targetContinue || "").slice(0, 200)
  });
  await saveSession({
    rid,
    dsh: ctx.dsh,
    tl: ctx.tl,
    plt: ctx.plt,
    continue: targetContinue || null,
    savedAt: Date.now()
  });

  return { ok: true, rid, ydResp, qrTl: ctx.tl, dsh: ctx.dsh, plt: ctx.plt };
}

/* ---------- v2.5.0：确认后才跳转（写读一致性网关）----------
 * 背景：YDtwf 写入 [3,null,4] 与 selection 页读取之间是最终一致的
 * 分布式存储——立即跳转存在复制延迟窗口（几百 ms～数秒），快跳
 * 可能读到旧状态（无降级）→ selection 页判挑战未降级 → 后续提交
 * 全挂。旧流程「写入后立即消费」从未等过确认。
 * 方案：downgrade 完成 → 本探针轮询 begin 端点回读会话状态，
 * 直到 SMS/降级特征出现（最多 4 次，间隔 700ms 起指数退避），
 * 由 content script 在跳转前调用。 */
async function confirmDowngrade({ dsh, tl, plt }) {
  const trace = { step: "confirm-gateway" };
  for (let i = 0; i < 4; i++) {
    try {
      const q = new URLSearchParams({ dsh: dsh || "", hl: "en" });
      if (tl) q.set("tl", tl);
      if (plt) q.set("plt", plt);
      const { text: html } = await fetchText(
        `https://accounts.google.com/devicephoneverification/begin?${q}`
      );
      const hasFallback = /\[\s*3\s*,\s*null\s*,\s*4\s*\]/.test(html);
      const hasSms = /(?:sms|SMS)/.test(html);
      if (hasFallback || hasSms) {
        trace.attempts = i + 1;
        trace.confirmed = true;
        trace.signal = hasFallback ? "fallback-[3,null,4]" : "sms-allowed";
        await appendRpcTrace(trace);
        return { confirmed: true, attempts: i + 1, signal: trace.signal };
      }
    } catch (err) {
      trace["err" + i] = String(err && err.message || err).slice(0, 120);
    }
    if (i < 3) await new Promise(r => setTimeout(r, 700 * Math.pow(2, i)));
  }
  trace.confirmed = false;
  await appendRpcTrace(trace);
  return { confirmed: false, attempts: 4 };
}

/* ---------- v2.2.0：网络层（wire-level）失败捕获 ----------
 * JS 钩子（net_recorder）依赖页面注入，三个盲区盖不住：
 *   1. service worker / offscreen 发出的请求
 *   2. content_scripts world 加载前的请求
 *   3. Google 前端不走 window.fetch 的私有通道（如 closure 的 xhr 包装库重建）
 * webRequest 在扩展进程监听，不依赖页面，属于网络栈最浅可截层——
 * 这里的记录是「地面真相」，与 JS 层记录互为印证（重叠说明 JS 钩子没被绕过）。
 * 注意：MV3 的 webRequest 仅观察（不加 blocking），不影响请求本身。 */
const WIRE_LOG_KEY = "gqsWireLog";

chrome.webRequest.onCompleted?.addListener(
  (details) => handleWireEvent(details, "completed"),
  { urls: ["https://accounts.google.com/*"] }
);
chrome.webRequest.onErrorOccurred?.addListener(
  (details) => handleWireEvent(details, "error"),
  { urls: ["https://accounts.google.com/*"] }
);
/* v2.4.0：请求头指纹 —— onSendHeaders 里有 wire 层真实 UA/Client-Hints。
 * DNR 是「改写层」，这里是「事实验证层」：验证 iPad 修改是否真的上网了。 */
chrome.webRequest.onSendHeaders?.addListener(
  (details) => {
    try {
      if (details.method !== "POST" || !/accounts\.google\.com/.test(details.url)) return;
      const h = details.requestHeaders || [];
      const ua = h.find(x => /user-agent/i.test(x.name))?.value || "";
      if (!ua) return;
      const entry = {
        t: new Date().toISOString(),
        kind: "wire-headers",
        method: details.method,
        status: -4,
        url: String(details.url || "").slice(0, 250),
        ua: ua.slice(0, 120),
        notes: h.filter(x => /sec-ch-ua|x-client-data/i.test(x.name)).map(x => x.name).join(",") || "无CH/CD头",
        verdictUA: /iPad|iPhone/.test(ua)
          ? (ua.includes("iPad") ? "iPad(已上网)" : "iPhone(已上网)")
          : "桌面(未转换! DNR规则没生效)"
      };
      chrome.storage.session.get(WIRE_LOG_KEY).then(data => {
        const arr = data?.[WIRE_LOG_KEY] || [];
        arr.push(entry);
        while (arr.length > 150) arr.shift();
        return chrome.storage.session.set({ [WIRE_LOG_KEY]: arr });
      }).catch(() => {});
    } catch (_) {}
  },
  { urls: ["https://accounts.google.com/*"] }
);

async function handleWireEvent(details, phase) {
  try {
    // 只记两类：失败（HTTP≥400 或网络错误）与提交类 POST。
    const isError = phase === "error" || details.statusCode >= 400;
    const isPost = details.method === "POST";
    if (!isError && !isPost) return;
    // 静态资源噪音过滤
    if (!isError && /\.(js|css|png|svg|woff2?)(\?|$)/.test(details.url)) return;
    const entry = {
      t: new Date().toISOString(),
      kind: "wire",
      wirePhase: phase,
      method: details.method,
      status: phase === "error" ? 0 : details.statusCode,
      url: String(details.url || "").slice(0, 350),
      fromFrame: details.frameId === 0 ? "top" : "frame" + details.frameId,
      err: phase === "error" ? String(details.error || "") : undefined,
      reqId: details.requestId
    };
    const data = await chrome.storage.session.get(WIRE_LOG_KEY);
    const arr = data?.[WIRE_LOG_KEY] || [];
    arr.push(entry);
    while (arr.length > 150) arr.shift();
    await chrome.storage.session.set({ [WIRE_LOG_KEY]: arr });
    /* v2.4.0：失败的提交类请求 → 触发字节镜像（见 mirrorFailedSubmit） */
    if (isError && isPost) mirrorFailedSubmit(details.url);
  } catch (_) {}
}

/* ---------- v2.4.0：失败提交的字节镜像 ----------
 * MV3 webRequest 读不到响应体；但失败响应的「内容形态」才是定罪证据。
 * 方案：wire 层捕获到失败 POST 后，后台用同会话凭证对该端点做一次
 * 轻量重放（GET 形态 / 空 POST），把响应体字节完整存档。
 * Google 的错误响应正文里带：错误码枚举、会话状态、重试策略——
 * 这是从「HTTP 400」升级到「为什么 400」的最后一层。 */
async function mirrorFailedSubmit(failedUrl) {
  try {
    const session = await getSession();
    const entry = {
      t: new Date().toISOString(),
      kind: "mirror",
      method: "MIRROR",
      status: -5,
      url: String(failedUrl || "").slice(0, 250),
      note: "wire失败POST的端点字节镜像"
    };
    // 只镜像 batchexecute 端点（表单提交类），且 60s 内同端点只镜像一次
    if (!/batchexecute/.test(failedUrl)) return;
    const mk = "mirror:" + failedUrl.split("?")[0];
    const last = (await chrome.storage.session.get(mk))?.[mk];
    if (last && Date.now() - last < 60000) return;
    await chrome.storage.session.set({ [mk]: Date.now() });

    // 镜像请求：同端点、空 f.req（服务端对无效请求的错误响应
    // 会暴露该端点的校验规则与错误格式——这就是要的字节）
    const u = new URL(failedUrl);
    u.searchParams.set("gqs-mirror", "1");
    const resp = await fetch(u.toString(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "f.req=" + encodeURIComponent(JSON.stringify([[[]]])) + (session?.at ? "" : "")
    });
    entry.status = resp.status;
    const text = await resp.text();
    entry.body = text.slice(0, 2500);
    // 字节级错误特征提取
    const feats = [];
    if (/\[\s*"er"/.test(text)) feats.push("er-array");
    const codeMatches = text.match(/(?:^|[,\s])"?(\d{2,4})"[,\s]/g) || [];
    if (/(?:^|[^A-Z_])(?:INVALID|EXPIRED|SESSION|TOKEN|DENIED)/i.test(text)) feats.push("err-keywords");
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) feats.push("session-uuid-present");
    entry.feats = feats;
    entry.verdict = resp.status === 400
      ? "400 + 响应体已存档（看 body 里的 er 结构定位拒绝原因）"
      : `镜像返回 ${resp.status}（响应体已存档）`;
    const data = await chrome.storage.session.get(WIRE_LOG_KEY);
    const arr = data?.[WIRE_LOG_KEY] || [];
    arr.push(entry);
    while (arr.length > 150) arr.shift();
    await chrome.storage.session.set({ [WIRE_LOG_KEY]: arr });
  } catch (err) {
    try {
      const data = await chrome.storage.session.get(WIRE_LOG_KEY);
      const arr = data?.[WIRE_LOG_KEY] || [];
      arr.push({
        t: new Date().toISOString(), kind: "mirror", method: "MIRROR",
        status: 0, url: String(failedUrl || "").slice(0, 200),
        body: "镜像失败: " + String(err && err.message || err).slice(0, 150)
      });
      await chrome.storage.session.set({ [WIRE_LOG_KEY]: arr });
    } catch (_) {}
  }
}

/* ---------- v2.2.0：失败重放引擎 ----------
 * 设计前提：降级状态是后台以 iPhone 身份写入 devicephoneverification
 * 会话机的；而页面提交走另一台会话机（v3/signin）。Google 拒绝页面
 * 提交 ≠ 拒绝这个动作本身——后台用「写入降级时的同一身份/同一会话
 * 参数」重放提交，是页面之外唯一未被尝试过的通道。
 * 触发：诊断引擎判定「手机号提交被拒」时，content script 上报
 * 报错上下文，后台从降级会话取出凭证重放。结果与原始拒绝对比后
 * 留痕，供最终归因。 */
async function replaySubmitWithSession({ capturedReqBody }) {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "无降级会话记录，无法重放" };
  }
  const trace = { step: "replay-attempt", hasBody: !!capturedReqBody };
  try {
    /* v2.3.0：重放升级为双探针。
     * 探针1（原有）：consent 端点 → 会话机存活状态
     * 探针2（新增）：begin 端点（带会话 dsh/tl）→ 挑战配置原文。
     *   begin 的响应 HTML 里带该会话当前挑战的完整数据岛——
     *   提取「允许的验证方式」与「降级状态」字段，这就是
     *   服务端对「这个会话现在处于什么状态」的完整自白。 */
    const { resp, text } = await fetchText(
      `https://accounts.google.com/devicephoneverification/consent?flow=browser&dsh=${encodeURIComponent(session.dsh || "")}&hl=en`
      + (session.tl ? `&tl=${encodeURIComponent(session.tl)}` : "")
      + (session.plt ? `&plt=${encodeURIComponent(session.plt)}` : "")
    );
    trace.status = resp.status;
    trace.snippet = text.slice(0, 300);

    // 探针2：挑战配置
    try {
      const beginResp = await fetchText(
        `https://accounts.google.com/devicephoneverification/begin?dsh=${encodeURIComponent(session.dsh || "")}&hl=en`
        + (session.tl ? `&tl=${encodeURIComponent(session.tl)}` : "")
      );
      const html = beginResp.text;
      trace.beginStatus = beginResp.resp.status;
      // 提取关键状态字段
      const fallbackState = html.match(/\[\s*3\s*,\s*null\s*,\s*4\s*\]/) ? "已写入" : "未见";
      const smsAllowed = /(?:sms|SMS)/.test(html) ? "在配置中" : "未出现";
      const methodsMatch = html.match(/(?:verificationMethod|availableMethod)[^\]]{0,200}/i);
      trace.challengeConfig = {
        fallbackState,
        smsAllowed,
        methods: methodsMatch ? methodsMatch[0].slice(0, 150) : null
      };
    } catch (e2) {
      trace.beginError = String(e2 && e2.message || e2).slice(0, 120);
    }

    // 权威回答分类（升级版：结合挑战配置）
    if (resp.status === 200 && /[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) {
      const cfg = trace.challengeConfig;
      let verdict = "会话仍活着（consent 可达）";
      if (cfg) {
        verdict += `；挑战配置: 降级状态${cfg.fallbackState}，SMS ${cfg.smsAllowed}`;
        if (cfg.fallbackState === "未见") {
          verdict += " ⚠ 降级状态在会话配置里缺失——YDtwf 的写入没有被这条会话保留（被覆盖或消费掉了）";
        }
      }
      trace.verdict = verdict;
      return { ok: true, alive: true, trace };
    }
    if (resp.status >= 400) {
      trace.verdict = `会话机返回 ${resp.status}——降级会话在这台机器上已失效`;
      return { ok: true, alive: false, trace };
    }
    trace.verdict = "响应形态未知——把 trace 发维护者";
    return { ok: true, alive: null, trace };
  } catch (err) {
    trace.error = String(err && err.message || err).slice(0, 200);
    trace.verdict = "重放请求本身失败（网络层）";
    return { ok: false, trace };
  }
}


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  /* v1.7.0：面板标题动态读版本（硬标记，杜绝旧代码伪装新版本） */
  if (msg.action === "getVersion") {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return;
  }

  if (msg.action === "downgradeQr") {
    (async () => {
      try {
        await rulesReady;
        const result = await downgradeQrUseCase({
          qrUrl: msg.qrUrl,
          pageTl: msg.pageTl,
          targetContinue: msg.targetContinue
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // async response
  }

  if (msg.action === "getSession") {
    getSession().then(sendResponse);
    return true;
  }

  if (msg.action === "clearSession") {
    chrome.storage.session.remove(SESSION_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }

  /* ---- v1.3.0：跨页面网络日志持久化 ----
   * content script 每捕获一个验证请求就转发到这里存进 storage.session，
   * 出错被重定向回二维码/登录页后记录不丢，供诊断按钮合并导出。 */
  if (msg.action === "appendNetLog") {
    chrome.storage.session.get("gqsNetLog").then(data => {
      const entries = data?.gqsNetLog || [];
      entries.push(msg.entry);
      while (entries.length > 200) entries.shift();
      return chrome.storage.session.set({ gqsNetLog: entries });
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "getNetLog") {
    chrome.storage.session.get("gqsNetLog").then(data => {
      sendResponse({ entries: data?.gqsNetLog || [] });
    }).catch(() => sendResponse({ entries: [] }));
    return true;
  }

  /* v1.6.0：RPC 链路插桩导出（H1/H2 判别证据） */
  if (msg.action === "getRpcTrace") {
    chrome.storage.session.get("gqsRpcTrace").then(data => {
      sendResponse({ entries: data?.gqsRpcTrace || [] });
    }).catch(() => sendResponse({ entries: [] }));
    return true;
  }

  /* v2.1.0：content script 落地校验结果也进插桩时间线 */
  if (msg.action === "appendRpcTrace") {
    appendRpcTrace(msg.trace || {}).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  /* v2.2.0：网络层日志导出（地面真相，与 JS 层互为印证） */
  if (msg.action === "getWireLog") {
    chrome.storage.session.get(WIRE_LOG_KEY).then(data => {
      sendResponse({ entries: data?.[WIRE_LOG_KEY] || [] });
    }).catch(() => sendResponse({ entries: [] }));
    return true;
  }

  /* v2.2.0：重放引擎入口 —— 诊断判定提交被拒时由 content script 触发 */
  /* v2.5.0：跳转前一致性网关 */
  if (msg.action === "confirmDowngrade") {
    confirmDowngrade({ dsh: msg.dsh, tl: msg.tl, plt: msg.plt })
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ confirmed: false, error: String(err) }));
    return true;
  }

  if (msg.action === "replaySubmit") {
    replaySubmitWithSession({ capturedReqBody: msg.capturedReqBody || "" })
      .then(async (result) => {
        if (result.trace) await appendRpcTrace(result.trace);
        sendResponse(result);
      })
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => { setupRules(); });
chrome.runtime.onStartup.addListener(() => { setupRules(); });
const rulesReady = setupRules();
