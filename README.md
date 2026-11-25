# Google QR SMS 助手（修复版）— google-qr-sms-fix

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-1a73e8?style=flat-square" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Version-2.5.0-34a853?style=flat-square" alt="Version 2.5.0" />
</p>

将 Chrome 桌面端 Google 登录时强制弹出的「跨设备二维码验证」（扫二维码 → 手机端确认）**自动降级回传统的手机号 + 6 位短信验证码**，可直接在桌面浏览器内完成验证。

基于上游 [google-qr-sms](https://github.com/giauphan/google-qr-sms)（v1.0.1）重写，含两大体系：**降级主流程的可靠性工程**与**内置的全栈诊断系统**。

---

## ⚠️ 适用边界（先读这个）

**本降级流程只对特定入口的挑战有效。** 实测（2026-11，四轮 wire 级取证）确认：

| 入口 | 挑战模块族 | 降级是否有效 |
|---|---|---|
| **Cloud Console → Cloud Shell → Verify** | `DevicePhoneVerification` / `uplevelingstep` | ✅ **协议对口，有效** |
| Gemini 等第三方登录（`flowName=GlifWebSignIn`） | `idvanyphonechallenge`（QR-only） | ❌ **无效**（见下） |

GlifWebSignIn 类入口的挑战在服务端**没有开放短信方法**（数据岛 `ds:3` 方法清单为空，`confirm-gateway` 回读三次证实降级状态从未被写入）。这类挑战请直接用**手机扫码**完成验证——客户端无法打通不存在的服务端出口。

---

## 📖 背景

Google 在桌面浏览器上逐步强制 `/v3/signin/challenge/iap/qrcode` 验证，要求手机扫码后走：
1. Android GMS Constellation 静默验证，或
2. MO-SMS（手机外发国际短信）。

在没有可用 Android 设备/国际短信能力的环境里，本扩展自动化**跨设备降级协议**（`idv_xdevice=1` + YDtwf `GetVerificationStatus` 写入 `[3,null,4]`），并在 `uplevelingstep` / `IdvUplevelingUi` 的完整生命周期内保持一致的 iPad Mini 请求头/navigator 指纹。

---

## 🚀 安装

1. 打开 `chrome://extensions/`，开启右上角**开发者模式**；
2. **移除旧版本**（如装过上游版/旧 fix 版，两套 DNR 动态规则会冲突）；
3. **加载已解压的扩展程序**，选择本文件夹。

> ⟳ 重载扩展后**务必关闭所有 accounts.google.com 标签页**再重测——Chrome 的重载不会刷新已打开的页面，旧 content script 会驻留旧页面，导致新版本从未被测试（本项目开发中真实踩过的坑）。

---

## 🧭 使用（四步）

1. 登录后打开 https://console.cloud.google.com/ ；
2. 点右上角 `[>_]` 激活 Cloud Shell，在弹出的 Verify 窗口点 **Verify**（或用悬浮面板按钮自动点击）；
3. 二维码页点 **「⚡ 一键降级到短信选择框」**（喝了服务端一致性确认汤后才跳转）；
4. 进入选择页选「短信」，输手机号，收到 `G-xxxxxx` 填入即可。

---

## ✨ 版本史与关键修复（v1.x → v2.5.0）

| 版本 | 修复/新增 |
|---|---|
| v1.4.x | TDZ 崩溃、重复声明、`targetContinue` 引用错——面板白屏三连修 |
| v1.5.x | 面板挂载白名单扩到降级后的手机号页；DNR 规则 4/5 覆盖 fallback 入口；诊断规则改成证据驱动四分支 |
| v1.6–1.7 | 重试/双指纹插桩、`[3,null,4]` 出现位置请查、版本号动态读 manifest（防旧代码伪装新版） |
| v1.8/v2.0 | 7 通道 JS 探针；**跳转目标重写**：合成 `uplevelingstep/selection`（v1.x 的 `/challenge/iap` 兜底是两台会话机错位，为死路） |
| v2.1 | 落地闭环：跳转后自动三信号健康检查，失败自动用 QR 会话指纹自愈重跳（防死循环） |
| v2.2 | wire 层抓取（webRequest）；报错时自动触发后台重放探针，直接拿服务端权威回答 |
| v2.3 | **AF_initDataCallback 数据岛解析**——直接读服务端状态本体（方法清单/SMS 开放性/错误岛） |
| v2.4 | UA 实况验证（onSendHeaders）；失败端点字节镜像；**G 段字节级终审**：输出手机号不通过的「唯一原因」 |
| v2.5.0 | **确认后才跳转**：降级写入后回读 begin 端点，指数退避最多 4 次探测，见到降级/SMS 特征才跳转；未确认也不死锁 |

---

## 🔬 内置诊断体系（报错时自动工作，不用开 DevTools）

出错后**右下角胶囊「🔍 降级助手诊断」**展开，复制出的日志包含：

```
── 深度分析（自动归因）──
E. 降级RPC语义核验   [3,null,4] 在业务载荷层还是元数据层（H1）
A. 会话指纹           降级会话 tl vs 提交携带 TL 对照（H2）
C. UA 一致性矩阵      每类请求的 UA 聚类，桌面泄漏直接定位（H4）
B. 失败聚类           同端点重复失败 → 确定性拒绝
D. 关键时间线         最后 12 条 POST/失败/导航/console
F. 数据岛解析         服务端方法清单/SMS 开放性/错误状态岛
G. 字节级终审         手机号不通过的【唯一原因】（五分支裁决）

── RPC 链路插桩 ──        init-begin → MypxBd → YDtwf → confirm-gateway → downgrade-done 全时间线
── 网络层（wire）记录 ──  失败 POST + UA 实况 + 字节镜像（Web 工程师需求的地面真相）
```

三层捕获互为印证：**JS 钩子层**（fetch/XHR/beacon/form/location/console 七通道）→ **数据岛层**（服务端状态本体）→ **wire 层**（扩展进程视角，页面 JS 被绕过也抓得到）。

---

## 💉 实测取证结论（为什么有「适用边界」）

对 GlifWebSignIn 入口的 QR 挑战，四轮 wire 级实测全部呈现同一模式：

1. YDtwf 响应含 `[3,null,4]`（表面成功）；
2. **confirm-gateway 回读 4 次均未确认**——降级状态从未生效；
3. 挑战页数据岛 `ds:3`（方法清单）为**空数组**；
4. 页面 JS 模块族识别为 `idvanyphonechallengeqrcode`（QR-only）。

结论：该家族挑战在服务端未开放任何短信出口，且不消费 `devicephoneverification` 会话机。**这是 Google 的服务端设计，客户端扩展无法突破。** 数据详见诊断日志的 F/G 段。

---

## 🙁 排查清单

1. 面板标题不是 **v2.5.0** → ⟳ 重载扩展 + 关掉所有 Google 标签页；
2. 报「二维码过期（ds:0 error [9]）」→ 正常拦截，重新 Verify 拿新码；
3. 落地面板显示「❌ 落地失败且无法自愈」→ 复制诊断日志（含双 TL 尝试记录）；
4. 验证一路不通且反复失败 → 退出账号、清 `accounts.google.com` Cookie 重登（会话会积累不良状态）；
5. ⚠️ 只对 **Cloud Shell → Verify** 入口有效；第三方登录页的 QR 挑战请用手机扫码。

---

## 📁 结构

```
google-qr-sms-fix/
├── manifest.json      # MV3 配置（v2.5.0）
├── background.js      # DNR 规则 + 降级 RPC 链 + wire 层抓取 + 确认网关 + 重放探针
├── content.js         # 悬浮面板 + 三段式跳转 + 落地自愈 + 六维深度归因（A–F+G 终审）
├── island_parser.js   # AF_initDataCallback 数据岛解析（MAIN world）
├── net_recorder.js    # 7 通道 JS 探针（fetch/XHR/beacon/form/nav/console/perf）
├── ua_spoof.js        # 分路径 navigator 伪装（仅 IDV 子流程）
└── diagnostics.js     # 证据驱动四分支诊断引擎
```

---

## 📄 License

MIT（继承上游 [google-qr-sms](https://github.com/giauphan/google-qr-sms)）
