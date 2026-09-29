# 贝蒂的基础面板：技术说明

本文记录 `Betty-Basic-Panel` **1.5.3** 的稳定行为与安全边界。版本号与安装入口以 [`Modules/Betty-Basic-Panel.sgmodule`](../Modules/Betty-Basic-Panel.sgmodule) 为准。

## 设计目标

基础面板保持**单一 Panel**，用于快速观察当前 Surge 网络环境，而不是充当完整测速器、解锁检测器或 IP 风险评分平台。

默认参数：

```text
YS=1&RISK=1
```

可选参数：

- `POLICY`：联网检测使用的策略；留空时按 Surge 当前规则出站。
- `YS=0`：关闭出口 IP 打码。
- `RISK=0`：关闭 HTTPS IP 信誉查询。
- `SUB_URL`：仅在本地无法取得订阅流量信息时，允许回查用户显式提供的原始 HTTPS 订阅地址。

只有 DIRECT 延迟明确走直连。出口观测、测速、流媒体与 AI 检测可能因为 Surge 分流而经过不同策略，因此面板中的“观测出口”不代表所有网站共享同一出口。

## 网络身份与信誉

唯一第三方 IP 情报服务为 **ip.net.coffee**。使用网站前端实际依赖的公开接口，不宣称它们是供应商承诺长期兼容的官方 API；不解析网页 HTML，不需要 Key、Cookie 或登录。

| GET endpoint | 用途 | 字段 / 行为 |
| --- | --- | --- |
| `/cdn-cgi/trace` | 当前请求出口 | 同站纯文本中的唯一 `ip=` 行；每次重新观察，支持 IPv4 / IPv6 |
| `/api/ip/lookup/{ip}` | 归属、ASN、类型和信誉 | JSON：`ip`、`countryCode`、`country/region/city`、`asn`、`asOrganization/isp/company_name`、`company_type`、`trust_score`、布尔信号 |
| `/api/geoip/{ip}` | `RISK=0` 或主查询失败 / 无归属时的同站 Geo 查询 | JSON：`country_code`、`country/region/city/isp`；当前不返回 ASN，也不回显 IP |

当前出口来自同站 trace，而不是本地 `$network` 地址。显式查询只发送已校验的公网地址。主查询必须回显同一 IP；等价 IPv6 写法先规范化。Geo 结果绑定到请求路径中的 IP；若未来响应增加 IP 字段，也必须一致。Geo 不回显 IP 的能力边界无法通过客户端校验消除。

`RISK=0` 不访问主查询 / 风险接口，不使用风险缓存；Geo 未提供的 ASN 保持未知。默认主查询本身已包含 Geo，因此不重复调用 Geo。所有旧 IP 情报供应商均已退出，Cloudflare 仅保留延迟和手动下载估算用途。

Trust 直接展示 `trust_score` 的 0–100 原值，越高越可信；不反转、不平均，也不生成“纯净度”。住宅、机房、VPN、代理、Tor 独立保留是 / 否 / 未知；`company_type` 是分配类型，不能推导住宅或风险高低。面板只显示一次 Net.Coffee 来源，不把网站内部聚合字段包装成独立供应商共识；✓ / ✕ / ? 分别表示是 / 否 / 未知。

成功结果使用 v2 缓存，最多 1 小时，不在读取时延长 TTL；过期、未来时间、字段损坏或出口变化时重新查询。每次先观察出口，失败时不展示旧出口或旧信誉。存储异常不阻止刷新，原始响应中的无关字段不保存。

403 / 429 按 endpoint 退避：支持 `Retry-After` 秒数或 HTTP 日期，限制为 1 分钟至 7 天；缺失或无效时保守暂停 24 小时。退避跨出口保留，不循环重试，不跟随重定向。未取得公开额度 / SLA 承诺，也未通过主动制造限流探测阈值。每个请求原生超时 5 秒、回调 watchdog 7 秒；trace 超过 4096 字符或 JSON 超过 65536 字符拒绝解析（这是解析上限，网络缓冲仍受 Surge 原生响应限制）。

Net.Coffee 全站不可用时只显示“IP 情报暂不可用”，本地网络、DNS、延迟、服务入口、订阅和测速缓存继续工作。主查询失败时最多补一次同站 Geo，没有其他供应商 fallback。

公网地址校验依据 IANA 特殊用途注册表，排除私网、CGNAT、回环、链路本地、文档、benchmarking、多播、保留地址及 IPv4-mapped IPv6；IPv4 前导零歧义也被拒绝。IPv6 保留普通 global-unicast 和已明确分配的协议例外，排除 `2001:db8::/32`、`3fff::/20`、benchmarking 及 ORCHID / DET 标识符。校验是用途过滤，不是路由可达性证明。

## 本地网络状态

- IPv4 / IPv6 的“本地”来自 Surge `$network`，与 NAT 推断合并显示。
- 面板不声称能从公开 API 反推出模块覆盖后的完整 VIF 状态，也不重复展示“VIF 未知 / IPv6 出口未测”。
- 只有实际观察到 IPv6 出口时才说明 IPv6 出口可达；IPv4 成功不能证明 IPv6 不可用。
- DNS 名称只识别系统实际提供的服务器地址；延迟是本地 DNS 测试 API 的整次调用耗时。
- NAT / CGNAT 只基于本地地址范围推断，不宣称执行 STUN 或完整 NAT 类型测试。

## 流媒体与 AI 状态语义

面板判断的是**公开入口的网络可达性**，不是账号、订阅、版权区或完整功能解锁。

- Netflix：样片入口用于观察区域页面；失败时可使用备用页面区分“主入口受限”和完全不可达。
- YouTube：只有实际看到 Premium 报价结构才显示对应提示；普通页面可达不等于 Premium 可购买。
- Disney+、Spotify、TikTok、Prime 与六项 AI 默认使用 HEAD 检查入口 / WAF。
- 2xx / 3xx 表示入口可达（✓）；401 / 403 / 429 / 451 表示受限；5xx 表示异常；超时表示不可达；其他响应保持未知。汇总只显示非零异常分类。
- TikTok / Prime 只在特定 HEAD 结果需要复核时执行一次 GET；明确的权限/限流响应不会靠重复请求“撞结果”。
- GET 不发送 Cookie / Authorization，不查询登录或播放私有接口，也不跟随地区跳转。成功时不额外显示 GET 200 / 302，失败时保留 GET 状态码或简短原因。

国家 / 地区信息不参与“可达 / 受限 / 未知”的硬判定，避免根据出口地理位置猜网站状态。出口与 Netflix 区域统一使用文本，不生成国旗 Emoji，避免部分 iPhone 的缺失字形。

## 下载估算：probe + 固定三路批次

测速只在 `$trigger === "button"` 时执行。自动刷新、脚本编辑器、快捷指令与 HTTP API 入口只读取最近缓存。

测量目标是**当前 Surge 路径短时间可利用的近似应用层总下载吞吐**（short multi-stream throughput estimate），不是 ISP benchmark、Ookla 替代或线路物理极限。`POLICY` 留空跟随当前规则，指定时每个测速请求均使用该策略。

### 1.5.3 的选择依据

1.5.2 修复了旧 worker 窗口丢弃完整回调的问题，但达到时长目标后可能只做单请求确认；“快速采样”常来自单个完整响应，不能代表节点总吞吐。iPhone 三个出口约 19–23 Mbps 的结果是真实单流数据；TCP / TLS / 代理启动、单流限制或连接复用的具体影响尚无逐请求真机证据，不能直接归因于 Cloudflare 限速，也不能据用户 300 Mbps 宽带反推结果。

本轮快速复核了此前已读的 [Surge Script API](https://manual.nssurge.com/scripting/api.html)、[运行时说明](https://manual.nssurge.com/scripting/overview.html) 和 [Cloudflare 官方实现](https://github.com/cloudflare/speedtest/tree/323da2ea5697ab4953f2c90c931125ac35d019d8)：

- Surge `binary-mode=true` 回调返回 Uint8Array；timeout 单位是秒；iOS HTTP 请求与响应正文各有 32 MB 上限；每次脚本最多 20 个并发 HTTP 请求、64 个 pending timers。20 是并发限制，不是总请求数。
- JSC 不保证有 clearTimeout；默认 auto 引擎可使用 WebView，不能未经证据认定设备正在使用 JSC。原生 HTTP API 没有文档化的取消句柄，也不保证回调的精确调度时刻。generic 的 timeout 是脚本总时限，当前模块仍为 90 秒。
- Cloudflare 顺序执行各档：100,000 bytes × 1（初始 bypass）/ × 9、1,000,000 × 8、10,000,000 × 6、25,000,000 × 4、100,000,000 × 3、250,000,000 × 2。代码在一档最短请求时长超过 finish 阈值 1000ms 后停止放大；计算带宽时过滤短于 10ms 的 measurement，取 p90，并非全档简单平均。README 的个别停止条件措辞不如当前源码明确，此处以 defaultConfig / BandwidthEngine 为准。
- 官方浏览器实现使用 PerformanceResourceTiming、transferSize、服务端计时修正；Surge 无等价能力，因此不移植 RTT 扣除、字节倍率或浏览器计时。官方对 429 有 Retry-After 重试，其他错误会停止测量；Panel 的短预算无需照搬重试等待。

独立社区参考（核验日期 2026-09-29；阅读源码不等于我们验证过其 iPhone 表现）：

| 实现 | 下载档位 / 并发 | 超时、计时和失败处理 | 可借鉴 / 不采用 |
| --- | --- | --- | --- |
| [Linsars/Surge：节点带宽测试.js](https://github.com/Linsars/Surge/blob/main/节点带宽测试.js) | 100 / 500 KiB / 1 MiB；Promise.all 三并发 | 每请求 12 秒；请求字节 / Date.now 耗时，再算术平均；失败作 0；未校验 HTTP 或实际正文长度；省略 policy | Surge Panel 定位；当前实现实际是并行而非顺序。无 warmup / ramp，后面还有上传；不复制其字节假设或平均方式 |
| [tutuh/script：Surge/Panel/JS/Network-Speed.js](https://github.com/tutuh/script/blob/master/Surge/Panel/JS/Network-Speed.js) | 默认 1 MiB，上限 3 MiB；单请求 | 延迟请求 5 秒、下载 10 秒，无统一总 watchdog；请求字节 / 实际耗时；失败降级；省略 policy | 简单 Surge Panel 路径；不同主机的先行 ping 不能视为下载连接预热；无 ramp / 多次统计、binary 或正文完整性校验 |
| [MaYIHEI/paperclip：loon/ipquality-web-test/ipquality-speed.js](https://github.com/MaYIHEI/paperclip/blob/main/loon/ipquality-web-test/ipquality-speed.js) | 256 KiB → 1 MiB；顺序，前档短于 900ms 且预算允许才放大 | Loon 每下载约 4500ms，流程预算 14 秒；3 次零字节延迟取中位数；实际长度 / 耗时，允许约 10% 短正文；后档失败保留前档 | 借鉴顺序放大与保留完整结果；这是 Loon，不直接搬用毫秒 timeout、node 路由或 clearTimeout，也不接受短正文 |
| [XIU2/CloudflareSpeedTest：task/download.go](https://github.com/XIU2/CloudflareSpeedTest/blob/master/task/download.go) | Go 流式读；默认每地址 10 秒 | 从响应头后计时，逐块读实际字节，用 EWMA；可用部分流数据 | 只作非 Surge 对照；Surge 整体正文回调没有相同分块 / 首字节计时能力，不复制其流式统计与系数 |

Cloudflare 的放大档位、多次观测和时长门槛提醒我们：不能把一次极短小请求当最终带宽。Panel 采用更小的有限批次，保留完整正文 / 实际墙钟计时，不复制浏览器 p90 与计时修正。Linsars 的三并发说明社区确有固定并发实现，但其单请求速率平均不等于聚合吞吐；Loon 参考明确定位单连接估算，启发本轮区分回退模式。

| 方案 | 判断 |
| --- | --- |
| 1.5.2 顺序 ramp + 可选确认 | 回调稳定，但最终仍可能只有单流速率；保留完整结果保护，替换最终测量 |
| 两路固定批次 | 开销较小；遇到每流瓶颈时利用能力有限 |
| 三路固定批次 | 采用；比两路多一个并行请求，可覆盖更多每流受限场景，回调和流量仍有明确上限 |
| 四路固定批次 | 没有新增真机证据证明值得增加并发；4 × 16 MiB 已耗尽总预算，尚未计入预热与探测 |
| 持续补发 worker pool | 不采用；不重新引入调度窗口、补请求与在途比例门槛 |

在共享 300 Mbps、每请求最多 100 Mbps、RTT 100ms、每流 8 MiB 的理想模型中，2 / 3 / 4 路分别约 174 / 261 / 270 Mbps；这是选择三路的资源取舍示例，不是设备校准。Surge 文档没有承诺独立 TCP 连接或提供连接池控制；三路 HTTP 请求可能复用连接或共享代理瓶颈。不会强制关闭连接、增加随机主机或修正数值。

### 采样与预算

- 保留 15 秒重复点击保护；测速全流程 8 秒 watchdog。普通网络 / 订阅检测先完成，整次 Panel 刷新可能更长。
- 32 KiB 预热不计入最终速度。512 KiB probe 用于选档；短于 800ms 且预算允许时最多再探测一次 2 MiB，并为 final batch 留出时间。至少 512 KiB、100ms 的完整单请求立即保留为“单流估算”。
- final block 从 512 KiB / 1 / 2 / 4 / 8 / 16 MiB 选择；同一批三路大小相同，一次发出，不补新请求。probe 耗时用于预估，使批次目标约 1500ms、通常预计不超过 2500ms。两档耗时差 / 预热只用于选未来请求大小，不从测速分母扣除。
- 多流结果至少两个完整响应且达到三路中的 2/3，批次实际耗时至少 700ms。只有 1/3 时不能称多流。2/3 在 UI 明示比例，失败或未完成响应不贡献字节；未完成不计作失败。
- 公式为 `sum(完整成功 bytes) × 8 / (最后一个接受的成功回调时间 − batch 启动时间) / 1000` Mbps（毫秒计时）。不平均各流速度、不加理论倍数、不扣 RTT / TLS；晚成功会同步更新字节和真实结束时间，即使数值变小也接受。失败回调之后的等待不冒充成功传输时间。
- 三路全部成功但不足 700ms 时，预算允许才再发**一组**更大固定批次；最多两组，不无限 ramp。已有合格多流结果不会被单流覆盖；可选放大失败保留已有有效结果。
- 达到总期限即关闭结果和请求入口，保留已合格的单流或 2/3 多流结果；之后的回调不改写结果或缓存。原生在途请求可能稍后回调，8 秒是脚本结果期限，不宣称原生取消能力。
- 原生每请求 timeout 最多 4 秒并受剩余时间约束；最多 3 个并行测速请求、16 个总请求、64 MiB 申请下载的响应正文总量，包含预热、失败和在途请求，不含协议开销。普通成功路径最多 9 请求、约 62.532 MiB；正常最大批次 3 × 16 MiB。每响应低于官方 iOS 32 MB 上限，但多响应内存与真实回调行为仍需 iPhone 验收。只使用一个总 watchdog。
- 保留同源小响应降级：初始 body limit / 2xx 正文不匹配，或预热成功后的 timeout / transport，可以尝试 60 / 48 / 32 KiB；完整但过短的 probe 遇到更大正文失败，也可顺序复用已成功大小。批次只有全部明确为正文上限 / 不匹配、且没有合格结果时才走该路径。至少 3 个完整响应、128 KiB、100ms，最多 10 个成功小样本，仍受上述总预算约束；标“小响应降级”。
- HTTP 拒绝、重定向、429、5xx 不触发缩块重试或等待重试；已发出的固定批次会正常排空。两路完整成功仍可形成部分多流结果；只有正文、字符串或 Content-Length 而无完整 binary byteLength 时绝不补字节。

低速使用较小批次，减少流量；中高速放大 block，减少 setup 相对占比。高 RTT、Surge 缓冲 / 回调桥接、连接复用、Cloudflare 路径仍可能低估；三路也未必饱和所有节点。允许出现真实低值，不能根据宽带标称值校准。500 Mbps 仅为显示刻度，超过刻度仍显示实测值。小响应降级尤易低估高速线路。

失败分类保持 timeout、HTTP status、body mismatch、body limit、insufficient samples、deadline、cooldown、transport 和 storage；UI 将 timeout / deadline 简写“超时”，不输出 raw error。

### 模式与缓存

- **多流采样**：本次合格聚合结果显示“测速”、MB/s 与 500 Mbps 刻度条；部分成功附 `2/3`。
- **单流估算**：final 无法合格完成但有完整单请求，只显示单流数值，无主吞吐条。
- **小响应降级**：显示“单流”与降级标记，无主吞吐条。
- **本次失败**：原因优先，旧值仅为“上次”历史参考，注明同出口 / 旧出口 / 出口未确认及采样模式；不画速度条、不覆盖旧值。
- **自动刷新**：同观测出口仅显示“测速缓存”、数值、时间与模式；其他出口不主显示旧数值，也不下载。
- **15 秒冷却**：不下载、不冒充本次成功。

测速缓存结构版本为 2，保留模式、有效耗时及多流完成数；旧版无该证据的记录保留值与时间，但只称“历史采样”，不会升级成多流缓存。失败不刷新历史时间。缓存绑定 Net.Coffee 观测出口；测速域名可能单独分流，因此“同出口”不是所有请求同路径的证明。跨日期缓存附日期。

## 紧凑布局示例

以下为示例数据，✓ 仅表示对应公开入口可达；常见正常路径为 22 行，有订阅数据 / 本次测速时为 23–24 行（系统实际换行取决于字体和屏幕宽度）。

```text
🌐 6-1904
IPv4 本地 · NAT 推断 · IPv6 本地
DNS 自定义/本地 · 24ms

🚪 台湾 · 160.30.*.* · AS9923
Simple Information · New Taipei City

⚡ DIRECT 249ms · 当前 358ms
测速失败 · 超时 · 上次 11.2 Mbps（15:16 · 旧出口 · 历史采样）

🎬 流媒体 6/6
Netflix 样片台湾 · YouTube ✓ · Disney+ ✓
Spotify ✓ · TikTok ✓ · Prime ✓

✨ AI 4/6 · 受限 1 · 异常 1
GPT ✓ · Claude ✓ · Gemini ✓
DeepSeek 403 · Grok 500 · Perplexity ✓

📦 剩余 298.57 / 300 GB · 99.5%
已用 1.43 GB · 到期 12/29

🛡 Trust 96/100 · 商业 · Net.Coffee
住宅✓ · 机房✕ · VPN✕ · 代理✕ · Tor✕
```

具体数值、条形刻度和机构名称按可用字段生成；不显示“机构未知 · AS未知”等占位组合。Trust 方向与独立信号语义没有变化。“剩余 / 总量”明确标注，不误称为已用。

## 请求预算

| 自动刷新路径 | IP 情报请求 | 通常外部总数 |
| --- | ---: | ---: |
| 1.4.1 无缓存 | 4 | 18 |
| 1.5.3 无缓存默认 | 2（trace + lookup） | 16 |
| 1.5.3 同出口缓存命中 | 1（trace） | 15 |
| `RISK=0` 无缓存 | 2（trace + Geo） | 16 |
| 主查询失败且需要 Geo 补充 | 最多 3 | 最多 17 |
| 出口发现失败 | 1；或退避期内 0 | 15；或 14 |

1.5.3 未增加自动刷新请求，仍是通常 16 / 缓存 15 次。手动测速保持 16 请求 / 64 MiB 硬上限；普通成功路径上限由 7 请求变为 9 请求，用于固定多流测量，没有新增服务。并发测速由最多 2 路变为 3 路。

固定其他请求为延迟 2、流媒体 6、AI 6。表中不含动态订阅流量回查、Netflix / YouTube 同站跳转或备用页面、TikTok / Prime 的方法复核；这些路径按需增加请求，不能把通常总数当绝对全场景上限。TikTok / Prime 各最多增加一次 GET。

单次刷新通常最多 16 个并行外部请求（包括可能的订阅回查），低于 Surge 的 20 请求限制；多个同时运行的脚本仍共享系统资源。测速始终等普通检测完成后才启动，且仅由按钮触发。

## 隐私与安全边界

脚本不使用 MITM、Rewrite、远程代码执行或第三方统计 SDK。

所有 `$httpClient` 请求关闭自动 Cookie；不会把 Cookie、Authorization、节点配置或 Profile 正文发送给信息服务。

当前 Profile 通过：

```text
/v1/profiles/current?sensitive=0
```

读取脱敏文本。流量信息按以下顺序尝试：本地 Profile 文本 → `subscription-userinfo` → 原始 HTTPS 托管地址 HEAD / GET → 可选 `SUB_URL`。

订阅 URL、Token、Profile 文本、原始响应和错误正文不会持久化到面板日志。动态订阅地址只会请求它自己的原始主机，不转发给第三方服务。

## iPhone 验收重点

本次最小 smoke：

1. 台湾节点手动测速一次。
2. 香港节点一次。
3. 日本或美国节点一次。
4. 记录“多流采样 / 单流估算 / 小响应降级”模式。
5. 查看不同节点的吞吐差异及测速行显示，不以 300 Mbps 为必须达到的目标。
6. 自动刷新确认没有下载请求。

自动化覆盖 20 / 50 / 100 / 200 / 300 / 500 Mbps × 50 / 100 / 150 / 300 / 500ms 的 30 个组合，另保留 10 Mbps 低速和 900ms RTT 场景；模拟共享链路与每流瓶颈、三路真实并发、聚合公式、2/3 部分成功、晚到 / 漏 / 重复回调、HTTP / 正文错误、期限、缓存和资源预算。测试证明时序和数学约束，不能证明真实 iPhone 带宽或独立 TCP 连接。本轮没有把 Actions 带宽当手机速度，也没有临时测速 probe 留在仓库。

## 依据

- [Surge Script API](https://manual.nssurge.com/scripting/api.html)
- [Surge Panel](https://manual.nssurge.com/tools/panel.html)
- [Surge HTTP API](https://manual.nssurge.com/tools/http-api.html)
- [Cloudflare speedtest](https://github.com/cloudflare/speedtest)
- [Net.Coffee IP 页面](https://ip.net.coffee/ip/) 与其公开 [前端脚本](https://ip.net.coffee/ip/ip-page.js)：同站 trace 和 lookup 请求
- [Net.Coffee 首页前端](https://ip.net.coffee/home-page.js)：Geo 查询；[IP 页面增强脚本](https://ip.net.coffee/ip/ip-page-v2.js) 标注 Trust 0 高危 / 100 可信
- [IANA IPv4 特殊用途](https://www.iana.org/assignments/iana-ipv4-special-registry/) / [IPv6 特殊用途](https://www.iana.org/assignments/iana-ipv6-special-registry/)
- [RFC 7343](https://www.rfc-editor.org/rfc/rfc7343) / [RFC 9374](https://www.rfc-editor.org/rfc/rfc9374)：ORCHID / DET 标识符语义

实现始终以当前脚本和模块文件为最终事实来源；本文只记录稳定契约，不保存一次性端点探测结果或临时调试日志。
