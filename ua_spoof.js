/* Google QR 自动降级短信助手 - 修复版 ua_spoof.js (v1.5.1)
 *
 * v1.2.1 变更：只在上 IDV 验证子流程的页面伪装 navigator。
 * 实测发现：把整个 accounts.google.com 的 navigator 都硬编码成 iPad 会污染
 * 登录流程——accounts 前端发现 UA 与桌面 Chrome 特征（window.chrome、
 * x-client-data 头等）矛盾时判定环境异常 → 「抱歉，出了点问题」。
 * 本脚本由 manifest 对整域注入，这里在运行时判断路径：
 * 非 IDV 流程页面（如 /v3/signin/*）直接退出，不进行任何伪装。
 */
(() => {
  // 仅 IDV 验证子流程需要 iPad navigator：
  //   /uplevelingstep/*           选择页/短信页/验证码页
  //   /_/IdvUplevelingUi/*        batchexecute 提交接口的页面上下文
  //   /devicephoneverification/*  后台降级 RPC
  //   /v3/signin/challenge/iap?...&idv_xdevice=1  （v1.5.1 新增）
  //     第三方入口降级后的手机号页（GlifWebSignIn 等不落 uplevelingstep）
  const p = location.pathname;
  const isIdvFlow =
    p.startsWith("/uplevelingstep") ||
    p.startsWith("/_/IdvUplevelingUi") ||
    p.startsWith("/devicephoneverification") ||
    (p.startsWith("/v3/signin/challenge/iap") &&
      !p.includes("/qrcode") &&
      new URLSearchParams(location.search).get("idv_xdevice") === "1");
  if (!isIdvFlow) return;

  const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
  const IPAD_MINI_APP_VERSION = "5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

  // 不改 innerWidth/innerHeight：宽度突变会触发 Closure 布局重算，导致页面状态重置。
  try {
    Object.defineProperty(navigator, "userAgent", { get: () => IPAD_MINI_UA, configurable: true });
    Object.defineProperty(navigator, "appVersion", { get: () => IPAD_MINI_APP_VERSION, configurable: true });
    Object.defineProperty(navigator, "platform", { get: () => "iPad", configurable: true });
    Object.defineProperty(navigator, "vendor", { get: () => "Apple Computer, Inc.", configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5, configurable: true });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => false, configurable: true });
  } catch (_) {}
})();
