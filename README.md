# Beatrice Surge Modules

贝蒂的 Surge 模块仓库。

## 使用与版权

本仓库保持公开，方便直接安装、更新和分享官方链接。

允许个人、非商业地直接安装和使用本仓库模块，也允许仅供自己使用的本地修改。可以自由分享本仓库地址或本仓库官方 `raw.githubusercontent.com` 安装地址。

未经 BeatriceArchive 事先书面许可，不得将本仓库代码或模块复制到其他仓库、网站、频道或软件包后重新发布；不得改名、换皮、删署名后作为自己的项目发布；不得公开分发修改版或其他衍生版本；不得冒充原创、隐瞒来源或用于商业销售与付费分发。

GitHub 平台本身允许的查看与 Fork 权利仍以 GitHub 条款为准，但 Fork 不代表获得改名发布、删除署名或独立再分发的额外许可。

完整条款见仓库根目录 `LICENSE`。该自定义许可仅适用于 BeatriceArchive 对其享有或控制版权的部分；第三方材料仍按各自原始许可证与版权声明执行。

## Modules

### Beatrice-Surge-System.sgmodule

贝蒂的 Surge 托管设置。

用于覆盖 Surge 基础网络设置，包括 VIF 接管、IPv6、UDP、局域网访问与其他系统网络行为。

### Betty-Basic-Panel.sgmodule

贝蒂的基础面板。

用于汇总本地网络、出口 IP、DNS、延迟、下载速度估算、流媒体、AI 可达性、当前配置剩余流量与 IP 风险信息。下载测速仅由用户点击触发，自动刷新不测速；单次测试最多请求约 70.5 MiB（含探测），蜂窝网络同样消耗流量。结果按成功接收字节与实际耗时计算，不加经验倍率；快速测试仅为估算，可达性也不代表完整解锁。

安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Basic-Panel.sgmodule

### Betty-Bilibili-Daily.sgmodule

贝蒂的哔哩哔哩每日签到。

每天 08:00 自动完成哔哩哔哩每日等级经验任务，也可在 Surge 中刷新“贝蒂的哔哩哔哩每日签到”Panel 立即手动执行。自动与手动入口共用同一套任务逻辑和带 TTL 的本地运行锁：脚本会先读取当日状态，只补做未完成项目；投币按当日已获得的投币经验与当前整数余额计算，硬币不足时有多少投多少，每次仅投 1 枚且不会自动点赞。

大会员账号会额外领取每日“专属等级加速包”对应的 +10 主站账号等级经验。脚本会先确保当日观看任务已经完成，再调用 `/x/vip/experience/add` 领取；成功返回后会再次读取 `/nav` 的 `level_info.current_exp` 验证经验变化。若接口返回 `69198`，视为当天已经领取。非大会员安全跳过。该 +10 EXP 与普通登录、观看、分享、投币组成的 65 EXP 每日任务分开显示，因此大会员当日理论最高可获得 75 点等级经验。

分享必须由 `/x/member/web/exp/reward` 返回 `share: true` 才显示完成；HTTP 200 不代表任务完成，`code=0` 也仅代表接口接受。Daily 1.10.0 使用固定的 PC-client 表单：`aid + csrf + source=pc_client_normal + eab_x=2 + ramval=0 + ga=1`，配合主站 Origin、对应视频 Referer 和完整已验证 Cookie。此组合依据当前 BLTH 的任务实现选择；参数作用与证据限度见[专项说明](docs/bilibili-session-share.md)，不宣称能绕过 Bilibili 风控。

正式 Daily 在写入前读取任务状态，每个账号每个北京时间自然日最多一次 `/x/web-interface/share/add` POST；先持久化尝试记录，避免超时、重复手动执行或脚本重启造成重复写入。之后最多三次确认读取（等待 0、1.2、2.5 秒）；未确认就明确显示“分享未确认”和任务部分完成。升级保留旧版当天尝试记录；损坏记录修复后保守暂停当天写入，次日恢复，不会永久阻塞。再次执行只读取状态，不重复写入；状态不可读时不发起分享。认证失效仍停止后续写操作。

该机制保证状态报告和写入上限，不保证 Bilibili 一定给分享任务记账。需要当天立即验收新版请求时，可选择安装下方的独立“分享单次测试”模块，明确手动授权一次额外分享；正常 Daily 和 cron 不会调用它。脚本不轮换请求参数、UA 或设备指纹，不连续分享多个视频。

投币按“最多 5 枚、扣除今日已投、再受当前余额限制”的规则计算目标。脚本以 `/x/web-interface/coin/today/exp` 为主状态源，并以 `/x/member/web/exp/reward` 的 `coins` 经验值作为备用；每次写入前核对当前视频已投数量，原创最多 2 枚、转载最多 1 枚，每次只写 1 枚。投币表单使用 Web 端成熟实现常见的 `cross_domain=true`、`eab_x=2`、`ramval=3`、`source=web_normal`、`ga=1`，同时固定 `select_like=0`，不会自动点赞。`34004` 等可恢复错误会有限换视频重试；`403` 会立即停止本轮后续投币写入，避免继续顶风控。

任务完成通知会逐项显示登录、观看、大会员经验、分享、投币、账号等级经验、普通每日任务经验与硬币余额。账号等级经验直接读取 Bilibili `/nav` 的前后值；普通每日任务经验单独按 65 EXP 展示，大会员额外 +10 不混入该 65 EXP 统计。投币通知还会显示本轮新增枚数、写入次数及停止错误码，方便定位连续投币失败原因。

Cookie 获取与 Daily 任务不强制指定 DIRECT，而是按 Surge 当前规则、策略组与代理配置正常出站，避免模块擅自绕过用户现有网络设计。Cookie 工具只接受官方二维码登录响应与 Bilibili 主站补全得到的设备会话；不使用 SPI 人工补 `buvid3`。扫码后如果仍无法得到 `buvid3`，新登录失败，已有验证会话保持不变。

日常模块本身没有 Cookie 监听或 MITM，不会常驻抓取 Cookie。首次使用、Cookie 失效或版本升级要求重新建立会话时，安装 `Betty-Bilibili-Cookie.sgmodule`，在 Surge 中找到“贝蒂的哔哩哔哩 Cookie 获取”Panel，手动点击刷新；刷新会生成新的 Bilibili 官方二维码；原有已验证 Cookie 在新登录、设备会话补全、必需字段检查和 `/nav` UID 验证全部成功前保持不变。长按通知查看二维码并截图，在 Bilibili App 的“扫一扫”中从相册识别并确认登录。

如果已经生成二维码但忘记截图，只要当前二维码仍在有效期内，再次点击 Cookie Panel 刷新即可重新显示同一张二维码，不会创建第二个登录事务。为支持这一容错，二维码内容仅在 Surge 本地临时保存，并在成功、失败或超时后清除；不会写入仓库、日志或发送给第三方服务。收到“✅ Cookie 已验证并保存”后 Daily 即可使用。

两个 Panel 的自动刷新仅读取 Surge 本地状态，不会自动创建登录事务或执行 Daily 写任务。Cookie 工具不使用 MITM、CA 或 HTTPS 解密，不需要修改托管 Profile，也不需要创建本地配置副本。主站补全支持最多三次受控跳转，仅允许 `https://www.bilibili.com`、`https://m.bilibili.com` 与 `https://bilibili.com`（默认端口）；逐跳合并官方响应中的 Cookie。QR 和 `/nav` 接口不跟随重定向，最终非 2xx 响应不能视为成功。完整验证后，Cookie 与验证信息通过单次本地写入提交为同一会话；Daily 优先读取该会话，兼容已有旧键，并为缓存中的旧 Daily 保留兼容镜像。新登录失败不清除原会话。只有显式通过快捷指令传入 `reset` 参数才会销毁会话，普通 Panel 刷新不会重置。账号 Cookie 仅保存于 Surge 本地持久化存储，不写入仓库，也不会发送给第三方服务。

Surge 当前官方 Panel 语法没有跨模块全局排序字段，因此 Bilibili 面板与基础面板的显示顺序主要由用户本地模块顺序决定。

签到模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule

Cookie 获取模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule

### Betty-Bilibili-Share-Test.sgmodule（临时手动验收）

安装地址：[Betty-Bilibili-Share-Test.sgmodule](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Share-Test.sgmodule)。

1. 在 Surge 的“模块”中通过 URL 安装上方模块；已有 Cookie 无需重新获取。
2. 打开策略选择页，找到 **“贝蒂的 B 站分享单次测试”**，点击该面板右侧的刷新按钮一次。
3. 等待面板与通知显示 `REQUEST CODE`、`REQUEST MESSAGE`、`HTTP STATUS`、`OFFICIAL SHARE STATE`、`RESULT`。只看此测试结果，无需运行整个 Daily。
4. 完成实机验收后，可删除这个临时模块；正式 Daily 继续使用相同请求形态。

只有此专用面板的手动按钮生效：没有 cron 或自动刷新配置，代码也拒绝自动刷新、普通 Daily 面板、编辑器、HTTP API 和快捷指令入口。独立脚本不加载 Daily 旧缓存，不执行观看、投币或 VIP；与 Daily 共用运行锁，避免并发。验证会话及 UID、读取官方任务状态、选择一个有效视频后，使用同一套 PC-client 表单发出最多一次分享 POST。

测试使用独立的 `betty.bilibili.daily.share_test.<uid>.<北京时间日期>` 记录，**不删除或改写正式 `share_attempt`**。每账号每天最多额外一次；先保存保护再发送，超时、-403、脚本中断或结果保存失败都不会重新开放名额。再次点击只读取状态并展示原响应。损坏测试记录保守阻止当日写入，次日新日期键可正常使用。自动刷新只显示本地缓存，不发网络请求。

| 请求与官方状态 | 结果 |
| --- | --- |
| `code=0`，`share=true` | `CONFIRMED`：官方每日任务已完成 |
| `code=0`，`share=false` | `REQUEST ACCEPTED BUT NOT CREDITED` + `NOT CONFIRMED`：接口接受，任务未记账 |
| `code=-403`，`share=false` | `REQUEST REJECTED BY BILIBILI` + `NOT CONFIRMED`：服务端拒绝，停止写入 |
| 请求或确认网络失败 | 保留已用名额，状态为 false 或 UNKNOWN，不能宣称完成 |

只有官方 `share=true` 才确认任务；这不证明某一次 POST 单独造成了完成。若仍返回 -403，不在同一次验收中换参数重试；该结果会加强账号、设备/会话或风控上下文限制的判断，但仍不能确定具体服务端判定条件。

## 验证

```sh
node scripts/validate-modules.mjs
node --test tests/*.test.mjs
```

行为测试在隔离的 mock Surge 环境运行，不使用真实 Cookie，不触发真实 Bilibili 写入。

本次手机回归与分享请求依据见 [Bilibili 会话与分享说明](docs/bilibili-session-share.md)。分享 `-403` 表示操作被服务端拒绝，不能仅凭 `/nav` 可登录推断分享会获准，也不应因此自动清空 Cookie。
