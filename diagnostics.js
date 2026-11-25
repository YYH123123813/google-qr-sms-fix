/* 诊断引擎（v1.5.0）— 自动分析网络日志和页面状态，给出人话诊断。
 *
 * v1.5.0：规则 2 大修——旧正则 /\]\]\s*,\s*\[\s*"?\[?\s*\d+\s*,/ 会把
 * batchexecute 正常响应（手机号国家列表、tas null 等数据负载）判成
 * 「业务错误」，在降级后的手机号页稳误报 critical，掩盖真问题。
 * 新增 batchexecuteHasRealError()：只认 ["er",...] 硬错误结构。
 *
 * 与 net_recorder.js（记录原始请求）配合：
 *   net_recorder 负责捕数据，本文件负责下结论。
 *
 * 用法：content.js 收集到 { entries, pageUrl, errorBanner } 后调用
 *   window.__gqsDiagnose(ctx) → 返回 [{severity, title, detail, action}] 按严重度排序
 */

(() => {
  // Google accounts 前端的常见报错文案（中英双语环境都可能遇到）
  const ERROR_BANNERS = [
    "抱歉，出了点问题",
    "出了点问题",
    "请重试",
    "Something went wrong",
    "Sorry, something went wrong",
    "Try again",
    "Unable to verify",
    "无法验证"
  ];

  function findEntries(entries, pred) {
    return entries.filter(pred);
  }

  function isBatchexecute(url) { return /batchexecute/.test(url || ""); }
  function isIdvSubmit(url) { return /IdvUplevelingUi.*batchexecute/.test(url || ""); }
  function isQrChallenge(url) { return /challenge\/iap\/qrcode/.test(url || ""); }

  /* 判断 batchexecute 的 200 响应是不是「业务失败」。
   * Google 正常响应里也大量出现 ["er",...] / 数字数组（嵌套 payload），
   * 旧版规则 2 只看正则形状，把手机号下拉列表、国家码等正常数据也判成
   * 「业务错误」——在手机号页直接误报 critical。必须抓网络视图强度。
   * batchexecute 的 gutter 格式：)]}'\n\n[["wrb.fr",...]]，
   * 真正的 er 行是 ["er",[["...", N, ...],...],...] 二级结构。 */
  function batchexecuteHasRealError(body) {
    if (!body) return false;
    // 硬特征：wrb.e / wrb.fr 之外的独立 "er" 行（服务端错误数组）
    if (/^\s*\[\s*"er"/m.test(body)) return true;
    // batchexecute 硬错误格式：…)]]\n,["er",null,"...,N,…] 或行首 ["er"
    if (/,\s*\[\s*"er"/.test(body)) return true;
    return false;
  }

  /* 从 batchexecute 响应正文里提取 Google 的错误码结构。
   * Google 的错误形如 [["er","","[[\\"er\\"... ]]] 或 [9,"..."] 。
   * 我们只提取可读的数字特征。 */
  function extractGoogleErrorCodes(body) {
    const codes = new Set();
    if (!body) return codes;
    // ds 错误：[N, "message"] 形式
    const dsMatches = body.matchAll(/"?\[\s*(\d+)\s*,\s*(?:"[^"]*")?\s*\]/g);
    for (const m of dsMatches) {
      const n = Number(m[1]);
      if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 19, 20].includes(n)) codes.add(`[${n},...]`);
    }
    if (body.includes("er")) codes.add("er-structure");
    return codes;
  }

  window.__gqsDiagnose = function diagnose(ctx) {
    const { entries = [], pageUrl = "", errorBanner = false } = ctx || {};
    const findings = [];

    /* ---------- 规则 1：提交接口 HTTP 层失败 ---------- */
    const failedSubmits = findEntries(entries, e =>
      isIdvSubmit(e.url) && (e.status >= 400 || e.status === 0)
    );
    if (failedSubmits.length > 0) {
      const last = failedSubmits[failedSubmits.length - 1];
      const codes = [...extractGoogleErrorCodes(last.body)];
      let why;
      switch (last.status) {
        case 400: why = "请求结构被拒——通常意味着会话参数（TL/dsh/rid）与服务端状态对不上，或降级状态未真正生效"; break;
        case 403: why = "被风控/环境校验拒绝——大概率是 UA 伪装与真实指纹矛盾被识破（注意是否开了桌面端 Chrome 专有特征）"; break;
        case 404: why = "接口路由不存在——version 可能过期，或此流程根本没走到降级后的路径"; break;
        case 0: why = "请求被网络层切断——检查本地代理（127.0.0.1 端口）是否拦截了 accounts.google.com"; break;
        default: why = `服务端返回了非预期状态码 ${last.status}`;
      }
      findings.push({
        severity: "critical",
        title: `提交手机号/验证码的请求失败（HTTP ${last.status}）`,
        detail: `${why}${codes.length ? `；响应中的错误特征: ${codes.join(", ")}` : ""}`,
        action: "把面板上的「复制诊断日志」内容发给维护者，附上本条诊断；同时确认是从 Cloud Shell → Verify 入口进入的。"
      });
    }

    /* ---------- 规则 2：batchexecute HTTP 200 但 body 里带真实业务错误 ----------
     * v1.5.0：正则收紧为只认 ["er",...] 硬错误结构，见 batchexecuteHasRealError。 */
    const erSubmits = findEntries(entries, e =>
      isBatchexecute(e.url) && e.status === 200 && batchexecuteHasRealError(e.body || "")
    );
    const lastEr = erSubmits[erSubmits.length - 1];
    if (lastEr) {
      const codes = [...extractGoogleErrorCodes(lastEr.body)];
      findings.push({
        severity: "critical",
        title: "服务端在 HTTP 200 里返回了业务错误",
        detail: `Google 常把错误藏在 200 响应里${codes.length ? `，特征码: ${codes.join(", ")}` : ""}。这通常是会话 token 失效或降级状态 [3,null,4] 没有真正写入。`,
        action: "回 Cloud Shell 重新点 Verify 拿全新二维码，重新走一次降级；若再次出现，复制诊断日志发给维护者。"
      });
    }

    /* ---------- 规则 3：页面显示了错误横幅（v1.7.0：证据驱动，零泛化话术）----------
     * 用户实测吐槽：诊断只复读「①②③常见原因」，一个问题都看不出来。
     * 本版原则：每句话必须有捕获到的原始数据背书；数据没覆盖到的
     * 结论一律明说「本条为推断，判别证据见日志 X 区」。 */
    if (errorBanner) {
      const rev = [...entries].reverse();
      const lastFail = rev.find(e => e.status >= 400 || e.status === 0);
      const lastBizErr = rev.find(e =>
        e.status === 200 && batchexecuteHasRealError(e.body || "")
      );
      const lastPost = rev.find(e => (e.method || "").toUpperCase() === "POST");
      const submitUa = rev.find(e =>
        (isIdvSubmit(e.url) || isBatchexecute(e.url)) && (e.method || "").toUpperCase() === "POST"
      )?.ua;
      const desktopUa = submitUa && /iPad|iPhone/.test(submitUa) === false && /Macintosh|Windows/.test(submitUa);

      const evidence = [
        `【证据】Post描到 ${entries.filter(e => (e.method||"").toUpperCase()==="POST").length} 条 | 失败 ${entries.filter(e => e.status >= 400 || e.status === 0).length} 条 | 总 ${entries.length} 条`,
        submitUa ? `【证据】最后一次提交的 UA: ${(submitUa || "").slice(0, 70)}` : "【证据】未捕获到任何 POST 提交（若扩展版本 ≥1.6.0 应当能捕获到——这条本身就是异常信号）"
      ].join("\n");

      let detail, action;
      if (desktopUa) {
        detail = evidence + "\n【结论·证实】提交以桌面 UA（Macintosh/Windows）发出 → 与降级时的 iPhone/iPad 身份矛盾 → 风控拒绝。这是 DNR 未生效的铁证——要么扩展没重载，要么该请求走的路径不在规则 4/5 覆盖内（把日志里的 URL 发给维护者分析路径归属）。";
        action = "① chrome://extensions 看扩展版本号并 ⟳ 重载 ② 关闭所有 accounts.google.com 标签页后重新走全流程（⟳ 不刷新已开页面，旧页面上依然是旧代码）③ 复发则复制诊断日志。";
      } else if (lastFail || lastBizErr) {
        const src = lastFail || lastBizErr;
        const which = lastFail ? "HTTP 第" + lastFail.status + "层被拒" : "HTTP 200 内嵌业务错误";
        detail = evidence + `\n【结论·证实】最后一次提交在${which}：[${src?.method}] ${(src?.url || "").slice(0, 140)}。请求体前 400 字符见日志该条目的 reqBody——核对它带的 TL 与降级会话的 tl 是否同源（不同源 = H2 降级写进旧会话）。`;
        action = "复制完整诊断日志（含 RPC 链路插桩区）发给维护者。此证据已足以离线定位，重试无意义。";
      } else if (lastPost) {
        detail = evidence + `\n【结论·强推断】Post全部成功（最后一条 [${lastPost.method}] ${lastPost.status}），但页面仍报错 → 错误不来自本页面可见的 XHR/fetch，而在（a）预取/ping 等无回调通道 或（b）同源 iframe 内的提交 且 postMessage 通道也没送达（扩展 <1.6.0）或（c）服务端在导航层直接拒绝。判别证据在日志 reqBody/UA 两行有无异常。`;
        action = "① 确认扩展版本 ≥1.6.0（v1.6.0 起 iframe 记录经 postMessage 送达，扩展更旧则这条推断无法排除）→ ② 复制完整诊断日志。";
      } else {
        detail = evidence + "\n【结论·捕获盲区】零 POST 被捕获到。优先怀疑扩展版本过旧（v1.6.0 才引入全 POST 捕获 + iframe postMessage + sessionStorage 三通道），其次怀疑提交发生在更早的页面路由。";
        action = "① 面板标题核对版本号，<1.6.0 则 ⟳ 重载扩展并刷新页面 ② 重走流程后若仍零 POST，复制诊断日志（版本号会印在日志头部）。";
      }
      findings.push({
        severity: "critical",
        title: "Google 页面显示了「抱歉，出了点问题。请重试」",
        detail,
        action
      });
    }

    /* ---------- 规则 4：被重定向回二维码页（降级被打回） ---------- */
    if (isQrChallenge(pageUrl)) {
      const afterDowngrade = entries.some(e => /uplevelingstep/.test(e.url));
      if (afterDowngrade) {
        findings.push({
          severity: "critical",
          title: "流程被重置回了二维码页",
          detail: "uplevelingstep 流程开始后又回到了挑战页，说明 Google 把整个验证会话作废。continue 参数来自非 Cloud Shell 入口（嵌套重定向）或环境校验失败，二者都会触发整流程回退。",
          action: "确认入口是 console.cloud.google.com 的 Cloud Shell → Verify；若已确认，复制诊断日志发给维护者，需要看被打回前最后的请求。"
        });
      }
    }

    /* ---------- 规则 5：降级 RPC（YDtwf）链路失败 ---------- */
    const failedDgRpc = findEntries(entries, e =>
      /devicephoneverification/.test(e.url) && (e.status >= 400 || e.status === 0)
    );
    if (failedDgRpc.length > 0) {
      const last = failedDgRpc[failedDgRpc.length - 1];
      findings.push({
        severity: "high",
        title: `降级注入 RPC 失败（HTTP ${last.status}）`,
        detail: "MypxBd/YDtwf 调用被拒。二维码可能已过期（ds:0 error 9），或者二维码会话已被另一次尝试消费。",
        action: "关闭验证弹窗，重新从 Cloud Shell 点 Verify 获取全新二维码后重试降级。"
      });
    }

    /* ---------- 规则 6：UA 环境一致性 ----------
     * 请求头层由 DNR 保证，但页面 JS 层读到的 navigator.userAgent
     * （net_recorder 在 ua_spoof 之后注入）必须在 IDV 流程里始终是 iPad。
     * 若同一流程内混入桌面 UA，环境矛盾正是「抱歉，出了点问题」的经典诱因。 */
    const idvEntries = findEntries(entries, e =>
      isIdvSubmit(e.url) || /uplevelingstep/.test(e.url)
    );
    const mixedUa = idvEntries.length > 0 && idvEntries.some(e =>
      e.ua && /iPad|iPhone/.test(e.ua) === false && /Macintosh|Windows/.test(e.ua)
    );
    if (mixedUa) {
      const offender = idvEntries.find(e => e.ua && /Macintosh|Windows/.test(e.ua));
      findings.push({
        severity: "high",
        title: "IDV 提交流程中检测到环境混用",
        detail: `在 uplevelingstep / IdvUplevelingUi 请求里发现桌面 UA（${(offender?.ua || "").slice(0, 60)}…）与 iPad UA 并存。Google 风控对这种前后矛盾零容忍——请求头说 iPad、JS 环境说桌面，直接判异常。`,
        action: "重新加载扩展（chrome://extensions ⟳）后重试；若复现，说明 ip 或 cookie 层有其他信号暴露桌面环境，复制诊断日志发给维护者。"
      });
    }

    /* ---------- 规则 7：一切正常 ---------- */
    if (findings.length === 0) {
      const recentOk = entries.filter(e => isBatchexecute(e.url) && e.status === 200).length;
      findings.push({
        severity: "ok",
        title: recentOk
          ? `流程健康：捕获到 ${entries.length} 个请求，无失败`
          : "尚未捕获到失败信号（流程可能还没走到提交步骤）",
        detail: recentOk
          ? "如果页面仍显示错误，说明错误发生在扩展监控不到的环节（如同源 iframe 或 WebSocket）。"
          : "继续操作到出错位置，诊断会自动更新。",
        action: "如果已出现错误但这里仍显示无失败，点「复制诊断日志」发给我。"
      });
    }

    const order = { critical: 0, high: 1, ok: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return findings;
  };

  window.__gqsErrorBanners = ERROR_BANNERS;
})();
