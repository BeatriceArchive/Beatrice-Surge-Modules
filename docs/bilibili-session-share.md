# Bilibili Cookie 与分享回归修复

核验日期：2026-09-11；SESSION_ID：20260911-fullopt。

## 已确认的问题

手机报告 1.4.2 可以扫码登录，1.4.3 在扫码成功后主站补全失败。代码对比确认：`mergeHomeCookies()` 仍要求跳转，但请求助手忽略参数并将所有 3xx 作为失败。用原 main 重放 HOME 302 场景，得到相同的 `home_request_failed`；修复后通过。

1.5.0 恢复受控 HOME 跳转：最多三次，仅官方主站、移动主站和根域的 HTTPS 默认端口。每跳检查 Location，并合并中间响应 Cookie；底层自动跳转仍关闭，防止凭据被自动转发到未经检查的站点。QR 与 nav 请求不跳转。此实现不依赖 WebView 专有 API。Surge 的自动跳转、Cookie 和响应头语义见[官方 JavaScript API](https://manual.nssurge.com/scripting/api.html)。

旧版在申请二维码前删除旧 Cookie，后续失败无法恢复。现在仅在新会话具备 SESSDATA、bili_jct、DedeUserID、buvid3，且 nav 的登录状态和 UID 均验证成功后，单次写入 `betty.bilibili.cookie.session` 提交完整 Cookie/metadata 对。更新后的 Daily 优先读取此记录；没有该记录时兼容旧键。提交后刷新兼容镜像，镜像失败不损坏新记录。正常扫码失败不改旧会话；显式 Shortcuts 参数 `reset` 才执行销毁。Cookie 模块时间上限调整为 240 秒，以容纳扫码后新增的受控跳转，锁 TTL 为 270 秒。

## 分享专项：1.10.0 的依据与边界

手机已确认 Cookie 1.5.0 恢复正常；观看、主站会话和 nav 均正常，四个必需 Cookie 字段齐全，而 Daily 1.9.0 的 `bvid + csrf` 分享仍返回 `-403`、官方 `share=false`。因此最小参数只符合基础接口约定，不足以证明适合每日经验任务。具体风控触发条件尚未确认，本轮不改 Cookie 登录流程。

2026-09-11 重新读取远端源码与提交记录：

- **BLTH** 当前 mainline 为 `409aa6039c420db9f46f8df732d123d0c08f1ef2`。[分享请求](https://github.com/andywang425/BLTH/blob/409aa6039c420db9f46f8df732d123d0c08f1ef2/src/library/bili-api/index.ts)使用固定 PC-client 来源，注释直接说明 Web 来源与任务完成的差异。该文件 2026-08 仍有维护，2026-06 的提交修复过主站分享任务的候选空数组处理；这些更新证明维护活动，不等于特定账号的成功证据。[上游任务判断](https://github.com/andywang425/BLTH/blob/409aa6039c420db9f46f8df732d123d0c08f1ef2/src/modules/dailyTasks/mainSiteTasks/shareTask.ts)仍依赖 code 0/71000，故本仓只参考请求形态，独立保留官方状态确认。
- **BiliBiliToolPro 4.0.1** 当前 main 为 `c599b2c0da964e16ea8c454397aa07bb16212628`。[模型](https://github.com/RayWangQvQ/BiliBiliToolPro/blob/c599b2c0da964e16ea8c454397aa07bb16212628/src/Ray.BiliBiliTool.Agent/BiliBiliAgent/Dtos/ApiApi/Video/ShareVideoRequest.cs)仍用 aid/csrf、eab_x=1、ramval=3..19、source=web_normal、ga=1；[接口声明](https://github.com/RayWangQvQ/BiliBiliToolPro/blob/c599b2c0da964e16ea8c454397aa07bb16212628/src/Ray.BiliBiliTool.Agent/BiliBiliAgent/Interfaces/IApiApi.cs)要求主站 Origin，并提示缺少 buvid3 可导致 -403。模型最近一次路径提交是 2026-05 DTO 整理，不能误称为最近修复分享风控。
- **[BiliBiliToolPro issue #796](https://github.com/RayWangQvQ/BiliBiliToolPro/issues/796)**：2024-11 的真实请求采用 web_normal，收到 HTTP 200、API -403；用户反馈 App 内分享及经验正常。讨论延续至 2025-05，没有可泛化的参数修复证明。这是相同症状的历史证据，不是当前所有账号失败的结论。
- **PiliPlus** 当前树 `b8eeeb78c441ff5aef4471d2c2c37643f72252d1` 的[接口备注](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/b8eeeb78c441ff5aef4471d2c2c37643f72252d1/lib/http/api.dart)列出 aid/bvid 二选一及 csrf。此处是基础接口备注，不能当作每日 EXP 实际成功证据。[API 收集文档](https://github.com/pskdje/bilibili-API-collect/blob/1d4c2d9e63de341aeb5cb7ee0622e9f7c8568c96/docs/video/action.md)也区分基础参数和可选附加字段。
- 上轮参考的 BiliOutils 当前 main 仍停留在 2022-12，其 aid+csrf 实现不作为本轮近期任务成功的主要证据。

据此选择 **一套固定的 BLTH 风格请求**，不轮换候选参数或 UA。相较 1.9.0，它有明确针对每日任务来源归因的维护者证据；不是因为附加参数多就认为更有效。

| 字段 / 上下文 | 分类 | 最终处理 |
| --- | --- | --- |
| POST `/x/web-interface/share/add` | EVIDENCE-SUPPORTED | 多个当前实现一致；继续使用 |
| aid | REQUIRED（视频标识二选一） | 使用官方视频资料中的 aid；不认定 bvid 无效 |
| csrf | REQUIRED（本实现认证约束） | 使用当前 bili_jct；不同收集文档对服务端是否强制有分歧，不省略 |
| source | EVIDENCE-SUPPORTED（每日任务） | 固定 pc_client_normal；不循环尝试来源 |
| eab_x=2 / ramval=0 / ga=1 | EVIDENCE-SUPPORTED；各字段独立必要性 UNKNOWN | 保留同一维护实现的完整固定组合；文档仍列为可选，不能声称每项都强制 |
| Origin | EVIDENCE-SUPPORTED | https://www.bilibili.com |
| Referer | EVIDENCE-SUPPORTED | 当前视频页 https://www.bilibili.com/video/BV…/ |
| SESSDATA / bili_jct / DedeUserID / buvid3 | REQUIRED（本地安全边界） | 完整保留已验证会话；buvid3 有上游 -403 关联证据，不是保证通过的充分条件 |
| User-Agent | 保持会话一致；服务端具体影响 UNKNOWN | 继续使用现有 Cookie/Daily 的 iPhone Safari UA；不伪装新设备 |
| Sec-Fetch / Client Hints / WBI / 复杂设备指纹 | 此 endpoint 必要性 UNKNOWN | 不添加 |
| 随机 ramval / web_normal | 其他实现或旧版选择 | 本轮不用，也不作为失败后的第二次请求 |

实机验收已完成：2026-09-11 用户在 iPhone + Surge 上报告 `REQUEST CODE=0`、HTTP 200、`OFFICIAL SHARE STATE=true`、`RESULT=CONFIRMED`。验收入口与正式 Daily 的表单、Origin、Referer、UA 和 Cookie 请求上下文已通过行为测试核对一致。Daily 1.10.0 的 PC-client 请求实现保持不变。这是当前账号与设备的官方任务完成证据；不能据此确定旧 -403 的唯一触发条件，也不能证明每个附加字段单独不可缺少。

## 写入和恢复约束

正式 Daily 保留同账号、同北京时间自然日最多一次 POST，旧 `share_attempt` 按 day 兼容，不因请求升级清零。先查任务，先保存记录，再写入。损坏记录占用当天名额后次日恢复；超时、HTTP 错误与 -403 不重试。

实机验收完成后，临时手动测试入口及其专属测试已移除，不再提供每日额外写入路径。保留正式 Daily 行为测试，覆盖固定 PC-client 表单、请求上下文、code 0 未记账、官方状态确认、-403、同日去重、次日恢复、损坏记录和网络失败。删除临时入口不修改 Cookie、正式分享尝试记录或其他任务逻辑。
