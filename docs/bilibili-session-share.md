# Bilibili Cookie 与分享回归修复

核验日期：2026-09-11；SESSION_ID：20260911-fullopt。

## 已确认的问题

手机报告 1.4.2 可以扫码登录，1.4.3 在扫码成功后主站补全失败。代码对比确认：`mergeHomeCookies()` 仍要求跳转，但请求助手忽略参数并将所有 3xx 作为失败。用原 main 重放 HOME 302 场景，得到相同的 `home_request_failed`；修复后通过。

1.5.0 恢复受控 HOME 跳转：最多三次，仅官方主站、移动主站和根域的 HTTPS 默认端口。每跳检查 Location，并合并中间响应 Cookie；底层自动跳转仍关闭，防止凭据被自动转发到未经检查的站点。QR 与 nav 请求不跳转。此实现不依赖 WebView 专有 API。Surge 的自动跳转、Cookie 和响应头语义见[官方 JavaScript API](https://manual.nssurge.com/scripting/api.html)。

旧版在申请二维码前删除旧 Cookie，后续失败无法恢复。现在仅在新会话具备 SESSDATA、bili_jct、DedeUserID、buvid3，且 nav 的登录状态和 UID 均验证成功后，单次写入 `betty.bilibili.cookie.session` 提交完整 Cookie/metadata 对。更新后的 Daily 优先读取此记录；没有该记录时兼容旧键。提交后刷新兼容镜像，镜像失败不损坏新记录。正常扫码失败不改旧会话；显式 Shortcuts 参数 `reset` 才执行销毁。Cookie 模块时间上限调整为 240 秒，以容纳扫码后新增的受控跳转，锁 TTL 为 270 秒。

## 分享请求证据与限度

手机已确认：观看可完成、nav 可验证，但分享返回 `-403`，每日状态仍是 false。这证明分享操作被拒绝，不能证明 SESSDATA 失效，也不能仅据此定位具体的设备、账号或请求字段风控条件。

| 项目 | 证据与处理 |
| --- | --- |
| Endpoint、POST、form encoding | 近期维护实现仍使用 `/x/web-interface/share/add`；保留 |
| aid / bvid | API 收集文档列为二选一；本实现选择已有的 bvid，非认定 aid 已失效 |
| csrf | 使用当前 Cookie 的 bili_jct；最小表单为 bvid + csrf |
| SESSDATA / buvid3 | 保留完整的官方扫码与主站设备会话，不伪造设备值 |
| eab_x / ramval / source / ga | 不同实现取值冲突，没有证据证明旧组合必需；从最小基线移除 |
| Origin / Referer / UA | 官方主站 Origin、对应视频 Referer；保留与 Cookie 获取一致的 UA |
| Sec-Fetch / WBI / 指纹 | 未证实此 endpoint 需要；不添加猜测字段或伪造浏览器指纹 |

对照来源：

- [API 收集文档的分享接口](https://github.com/pskdje/bilibili-API-collect/blob/1d4c2d9e63de341aeb5cb7ee0622e9f7c8568c96/docs/video/action.md)：列出 bvid/aid、csrf 和非必要附加字段。文件最近修改于 2025-04，不能作为 2026 实机成功证明。
- [BiliOutils 请求实现](https://github.com/onlyLTY/BiliOutils/blob/171ca05534c380f70f39902bb973b13101557845/src/net/video.request.ts)：采用 aid + csrf 最小形式。
- [BLTH 请求实现](https://github.com/andywang425/BLTH/blob/409aa6039c420db9f46f8df732d123d0c08f1ef2/src/library/bili-api/index.ts)：近期维护版本使用另一套附加字段，并称 PC 来源有助任务记账。但其分享任务仍凭 code 0/71000 判断完成，因此没有照搬这套参数作为已证实解决方案。

直接读取当前 Bilibili 公共视频页被 HTTP 412 阻止，未取得当前登录浏览器的实际请求。因此不能声称已证明 `-403` 的唯一服务端根因，也不能声称修改后已实机完成分享。

## 写入和恢复约束

保留同账号、同北京时间自然日最多一次 POST。先查任务，先持久化尝试记录，再写入；更新参数不清除旧版当天记录。超时、HTTP 错误和 -403 均不重复写入；仅 `share === true` 确认任务完成。请求 code 0 后最多三次状态读取，等待 0、1.2、2.5 秒。

旧记录按 day 兼容。无效记录在本地修复并保守占用当天名额，次日恢复正常，避免无限期阻塞；记录无法保存则不写入。没有发起真实分享 POST。下一次正常 Daily 执行才进行真实验证，观察服务端响应码与最终 share 状态。
