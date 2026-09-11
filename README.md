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

Basic Panel 1.4.0 保持单一面板。默认 `YS=1&RISK=1`；省略参数也默认打码并开启信誉查询。`POLICY` 可选，留空跟随 Surge 当前规则；只有 DIRECT 延迟明确走直连。出口、测速及各站点可能分流，面板的“观测出口”不代表所有网站共用此出口。

安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Basic-Panel.sgmodule

**网络身份与信誉**

| 来源 | 默认用途 | 缓存 / 降级 |
| --- | --- | --- |
| Cloudflare `speed.cloudflare.com/meta` | 每次重新观察出口 IP、国家和 ASN | 不使用旧出口兜底；失败时依次用 IPWho、IPify 重新发现 |
| [IPWho](https://ipwhois.io/documentation) | 对已观察的同一 IP 查询国家、ASN、机构 | 查询结果缓存 1 小时；不同出口立即失效 |
| [ipapi.is](https://ipapi.is/developers.html) | `RISK=1` 时补充归属；仅使用实际返回的风险标记 | 缓存 1 小时；兼容匿名基础响应和完整响应 |
| [ProxyCheck v3](https://proxycheck.io/api/) | `RISK=1` 时查询网络类型、VPN / proxy / Tor、原始 Risk 和 Confidence | 缓存 1 小时；不添加绕过其 CDN 缓存的随机参数；`tag=0` |

Geo / ASN 只合并同一 IP 的有效结果，显示一致数量或分歧；平票不强行选赢家。机构名称差异单独提示。匿名 ipapi.is 若只给国家全名，只有能与另一源的国家全名 / 代码明确对应时才归一；不能归一的数据不被猜成某个国家。在线归属都缺失时可以使用 Surge 自带库，但明确标记未交叉验证。

信誉不计算“综合纯净度”，也不对各家风险分数做平均或反转。`PC Risk` 和检测置信度都是 ProxyCheck 原始字段；VPN、住宅分配、机房、滥用记录是不同含义，不等同于账号有问题。只比较两源都明确提供的同名布尔信号；缺失不是 `false`。显示“可比信号一致”“信号存在分歧”或“未交叉确认”，这些均不代表准确率。

截至 2026-09-11，[ipapi.is 的匿名额度说明](https://ipapi.is/free-tier.html)明确匿名接口只给基础归属，风险字段需 Key；因此默认可能只得到一份有效风险报告，面板会如实提示，不能声称 2/2 共识。当前 IPWho 免费额度为每调用 IP 每日 1,000 次，ProxyCheck / ipapi.is 无 Key 默认各 100 次；本地缓存降低重复消耗。429 / 403 独立退避，优先遵守 `Retry-After`，否则暂停该源 24 小时，不因切换被查询 IP 绕过限流；单源失败不会使整个面板失败。

[ip.skk.moe](https://ip.skk.moe/)只作为多源网络信息的设计参考：未确认作者提供公开、稳定、获准脚本调用的 API，所以不直接调用、抓取 HTML 或探查其内部接口。IPQS、Spur、IPinfo Privacy、AbuseIPDB 的增强能力需要凭据；本模块不增加明文 Key 参数，也不为这些能力引入 SDK 或额外账号要求。

**状态含义**

- IPv4 / IPv6 的“本地有”来自 `$network`。公开 API 无法可靠核对模块覆盖后的有效 VIF 设置，因此标记 `VIF 未知`。实际观测到 IPv6 出口才显示该出口可达；IPv4 出口不能证明 IPv6 不可用，显示“IPv6 出口未测”。
- DNS 名称只识别系统提供的确切服务器地址；“测试”是本地 DNS 测试 API 的整次调用耗时，不根据返回值大小猜单位。NAT / CGNAT 只从本地地址推断，不声称做过 STUN 或完整 NAT 类型检测。
- Netflix“样片可达”只证明区域样片页面可访问；样片失败而备用页面可访问时显示“样片受限”，不承诺登录后的播放解锁。YouTube 只有看到实际 Premium 报价结构才显示“Premium 报价可见”，否则为可达或 Premium 受限。页面缺少错误信息不会自动等于 Premium 可用。
- Disney+、Spotify、TikTok、Prime 和六项 AI 使用小成本 HEAD 请求检查网站 / WAF。2xx / 3xx 为“可达”，401 / 403 / 429 / 451 为“受限”，网络超时为“不可达”，其他响应为“未知”；全部不代表账号、地区付费能力或模型功能完整可用。单个站点 403 不改变整体网络颜色。

**自适应下载估算**

只有点击“贝蒂的基础面板”的刷新按钮（`$trigger=button`）才下载。自动刷新、脚本编辑器、快捷指令和 HTTP API 入口都不测速。连续点击有 15 秒本地保护。

先预热并检查响应体能力，以最多 16 MiB 的短采样判断链路；低于 150 Mbps 可结束，150～300 Mbps 使用中档采样，高于 300 Mbps 扩大采样。中档测量中发现超过 300 Mbps 时可延长窗口。正式中 / 高档目标窗口分别为 3 / 4 秒；**整个流程最多等待 8 秒，所有探测和在途请求合计最多请求 128 MiB 下载正文、最多 4 个并行 worker、256 个请求，单响应最多 8 MiB**。普通慢速链路通常只消耗数 MiB。若 Surge 有较小响应限制，保留 60 / 48 / 32 KiB 降级并标注“小响应降级”。

结果只用有效窗口内完整接收的二进制字节除以实际窗口时间；不使用字符串长度、Content-Length 或经验倍率。阶段切换先等待上一阶段的在途请求结束，避免 worker 叠加；全局截止后不再启动请求。Surge 没有单请求取消接口，已发出的响应可能继续到自身 timeout，因此流量上限包含全部已发请求，且不把 8 秒称为底层连接被强制关闭的时间。128 MiB 不含 TLS / HTTP 开销，蜂窝网络同样计费。

这是短时“下载估算”，不是 Cloudflare 官方完整测速；受时延、连接建立、Surge 缓冲、路由和样本量影响。刻度线性，500 Mbps 满格，超过 500 的实测数字照常显示。失败保留上次成功值与日期时间，当前出口不匹配时明确标记历史结果。

**请求预算与隐私**

通常无缓存自动刷新发起 **18 个外部请求**：出口及交叉查询 4、延迟 2、流媒体 6、AI 6；归属缓存命中时约 **15 个**。另有 2 次本地 HTTP API 调用。Netflix / YouTube 的同站重定向、Netflix 备用样片和出口 fallback 可能增加请求；当前 Profile 流量本地无法读取时，原始托管地址 HEAD → GET 最多再加 2 次，可选 `SUB_URL` 再加 2 次。站点 HEAD 不跟随重定向，也不为了 403 反复尝试。第三方接口各自超时，外部并发低于 Surge 的 20 请求限制。`update-interval=1800` 表示打开策略页时按到期间隔更新，不保证后台每半小时执行。

所有请求关闭自动 Cookie；不发送 Cookie、Authorization、节点配置或 Profile 到信息服务。Geo / 信誉只查询出口 IP 和必要参数。完整 IP 仅保存在 Surge 本地当前出口缓存中，默认不显示。读取当前配置明确使用 `/v1/profiles/current?sensitive=0`；继续依次尝试本地流量文字、subscription-userinfo、原始 HTTPS 托管地址 HEAD / GET、可选 SUB_URL。不跟随订阅重定向，不记录或持久化订阅 URL、Token、配置文本、原始响应和错误正文。

能力依据：[Surge Script API](https://manual.nssurge.com/scripting/api.html)、[Panel](https://manual.nssurge.com/tools/panel.html)、[HTTP API](https://manual.nssurge.com/tools/http-api.html)、[Cloudflare 测速引擎](https://github.com/cloudflare/speedtest)。保持直接使用公开下载端点，不加载测速 SDK、遥测代码或远程脚本。

**iPhone 验收**

1. 更新此模块和远程脚本，在 Surge 的策略页找到唯一的“贝蒂的基础面板”。自动更新应只显示旧测速时间或“未测试”，不启动下载。
2. 点击该面板的刷新按钮，检查下载估算、500 Mbps 刻度与新时间；快速连续点击应触发冷却。
3. 切换出口不同的节点后重新打开策略页，待自动刷新或手动刷新；检查出口打码、国家 / ASN / 信誉变化，不能沿用旧 IP 的共识。手动刷新同时会测速，注意流量。
4. 检查本地 IPv6、VIF 未知和出口 IPv6 状态没有混淆。网站“可达”不等于解锁，AI 的 403 显示受限。
5. 检查信誉单源、同名信号一致或分歧提示，以及当前 Profile 剩余流量。模拟断网后面板仍应显示可用本地信息；测速失败保留原成功时间。

### Betty-Bilibili-Daily.sgmodule

贝蒂的哔哩哔哩每日签到。

每天 08:00 自动完成哔哩哔哩每日等级经验任务，也可在 Surge 中刷新“贝蒂的哔哩哔哩每日签到”Panel 立即手动执行。自动与手动入口共用同一套任务逻辑和带 TTL 的本地运行锁：脚本会先读取当日状态，只补做未完成项目；投币按当日已获得的投币经验与当前整数余额计算，硬币不足时有多少投多少，每次仅投 1 枚且不会自动点赞。

大会员账号会额外领取每日“专属等级加速包”对应的 +10 主站账号等级经验。脚本会先确保当日观看任务已经完成，再调用 `/x/vip/experience/add` 领取；成功返回后会再次读取 `/nav` 的 `level_info.current_exp` 验证经验变化。若接口返回 `69198`，视为当天已经领取。非大会员安全跳过。该 +10 EXP 与普通登录、观看、分享、投币组成的 65 EXP 每日任务分开显示，因此大会员当日理论最高可获得 75 点等级经验。

分享必须由 `/x/member/web/exp/reward` 返回 `share: true` 才显示完成；HTTP 200 不代表任务完成，`code=0` 也仅代表接口接受。Daily 1.10.0 使用固定的 PC-client 表单：`aid + csrf + source=pc_client_normal + eab_x=2 + ramval=0 + ga=1`，配合主站 Origin、对应视频 Referer 和完整已验证 Cookie。此组合依据当前 BLTH 的任务实现选择；参数作用与证据限度见[专项说明](docs/bilibili-session-share.md)，不宣称能绕过 Bilibili 风控。

正式 Daily 在写入前读取任务状态，每个账号每个北京时间自然日最多一次 `/x/web-interface/share/add` POST；先持久化尝试记录，避免超时、重复手动执行或脚本重启造成重复写入。之后最多三次确认读取（等待 0、1.2、2.5 秒）；未确认就明确显示“分享未确认”和任务部分完成。升级保留旧版当天尝试记录；损坏记录修复后保守暂停当天写入，次日恢复，不会永久阻塞。再次执行只读取状态，不重复写入；状态不可读时不发起分享。认证失效仍停止后续写操作。

2026-09-11 用户已在 iPhone + Surge 实机确认该 PC-client 请求返回 `code=0`、HTTP 200，官方每日状态 `share=true`，结果 `CONFIRMED`。Daily 1.10.0 保留这套已验证请求及正式每日写入保护；不会轮换请求参数、UA 或设备指纹，也不连续分享多个视频。此验收确认当前账号与设备的任务完成，不代表所有账号始终通过服务端风控。

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

## 验证

```sh
node scripts/validate-modules.mjs
node --test tests/*.test.mjs
```

行为测试在隔离的 mock Surge 环境运行，不使用真实 Cookie，不触发真实 Bilibili 写入。

本次手机回归与分享请求依据见 [Bilibili 会话与分享说明](docs/bilibili-session-share.md)。分享 `-403` 表示操作被服务端拒绝，不能仅凭 `/nav` 可登录推断分享会获准，也不应因此自动清空 Cookie。
