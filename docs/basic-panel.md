# 贝蒂的基础面板：技术说明

本文记录 `Betty-Basic-Panel` **1.5.2** 的稳定行为与安全边界。版本号与安装入口以 [`Modules/Betty-Basic-Panel.sgmodule`](../Modules/Betty-Basic-Panel.sgmodule) 为准。

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

## 下载估算：顺序放大 + 最多双请求确认

测速只在 `$trigger === "button"` 时执行。自动刷新、脚本编辑器、快捷指令与 HTTP API 入口只读取最近缓存。

### 1.5.2 的选择依据

1.5.1 的 1500ms pilot 在 nominal stop 后将 worker 标为 inactive：完整响应即使在全局期限内返回也被丢弃；success / attempted 又把尚未完成的请求放进分母。远端回归测试已重现“所有响应成功，但最终样本不足”。探测响应本身也没有作为独立有效测量保留。真实 iPhone 尚无逐请求时序，因此不能声称已确认设备每次失败都由同一回调时序导致，也没有证据归因于 Net.Coffee 或节点带宽。

修改前核验了当前 [Surge Script API](https://manual.nssurge.com/scripting/api.html)、[运行时说明](https://manual.nssurge.com/scripting/overview.html) 和 [Cloudflare 官方实现](https://github.com/cloudflare/speedtest/tree/323da2ea5697ab4953f2c90c931125ac35d019d8)：

- Surge `binary-mode=true` 回调返回 Uint8Array；timeout 单位是秒；iOS HTTP 请求与响应正文各有 32 MB 上限；每次脚本最多 20 个并发 HTTP 请求、64 个 pending timers。20 是并发限制，不是总请求数。
- JSC 不保证有 clearTimeout；默认 auto 引擎可使用 WebView，不能未经证据认定设备正在使用 JSC。原生 HTTP API 没有文档化的取消句柄，也不保证回调的精确调度时刻。generic 的 timeout 是脚本总时限，当前模块仍为 90 秒。
- Cloudflare 顺序执行各档：100,000 bytes × 1（初始 bypass）/ × 9、1,000,000 × 8、10,000,000 × 6、25,000,000 × 4、100,000,000 × 3、250,000,000 × 2。代码在一档最短请求时长超过 finish 阈值 1000ms 后停止放大；计算带宽时过滤短于 10ms 的 measurement，取 p90，并非全档简单平均。README 的个别停止条件措辞不如当前源码明确，此处以 defaultConfig / BandwidthEngine 为准。
- 官方浏览器实现使用 PerformanceResourceTiming、transferSize、服务端计时修正；Surge 无等价能力，因此不移植 RTT 扣除、字节倍率或浏览器计时。官方对 429 有 Retry-After 重试，其他错误会停止测量；Panel 的短预算无需照搬重试等待。

独立社区参考（核验日期 2026-09-29；阅读源码不等于我们验证过其 iPhone 表现）：

| 实现 | 下载档位 / 并发 | 超时、计时和失败处理 | 可借鉴 / 不采用 |
| --- | --- | --- | --- |
| [Linsars/Surge：节点带宽测试.js](https://github.com/Linsars/Surge/blob/main/节点带宽测试.js) | 100 / 500 KiB / 1 MiB；Promise.all 三并发 | 每请求 12 秒；请求字节 / Date.now 耗时，再算术平均；失败作 0；未校验 HTTP 或实际正文长度；省略 policy | Surge Panel 定位；当前实现实际是并行而非顺序。无 warmup / ramp，后面还有上传；不复制其字节假设或平均方式 |
| [tutuh/script：Surge/Panel/JS/Network-Speed.js](https://github.com/tutuh/script/blob/main/Surge/Panel/JS/Network-Speed.js) | 默认 1 MiB，上限 3 MiB；单请求 | 延迟请求 5 秒、下载 10 秒，无统一总 watchdog；请求字节 / 实际耗时；失败降级；省略 policy | 简单 Surge Panel 路径；不同主机的先行 ping 不能视为下载连接预热；无 ramp / 多次统计、binary 或正文完整性校验 |
| [MaYIHEI/paperclip：loon/ipquality-web-test/ipquality-speed.js](https://github.com/MaYIHEI/paperclip/blob/main/loon/ipquality-web-test/ipquality-speed.js) | 256 KiB → 1 MiB；顺序，前档短于 900ms 且预算允许才放大 | Loon 每下载约 4500ms，流程预算 14 秒；3 次零字节延迟取中位数；实际长度 / 耗时，允许约 10% 短正文；后档失败保留前档 | 借鉴顺序放大与保留完整结果；这是 Loon，不直接搬用毫秒 timeout、node 路由或 clearTimeout，也不接受短正文 |
| [XIU2/CloudflareSpeedTest：task/download.go](https://github.com/XIU2/CloudflareSpeedTest/blob/master/task/download.go) | Go 流式读；默认每地址 10 秒 | 从响应头后计时，逐块读实际字节，用 EWMA；可用部分流数据 | 只作非 Surge 对照；Surge 整体正文回调没有相同分块 / 首字节计时能力，不复制其流式统计与系数 |

方案比较：

| 方案 | 主要收益 | 本任务结论 |
| --- | --- | --- |
| 旧四 worker + pilot / tier / refinement | 可持续占用链路 | 固定窗口、在途请求和比例门槛相互耦合，已有 false failure；移除 |
| 纯顺序 ramp | 完整回调易管理、低并发 | 作为主体；高速高 RTT 时单请求容易低估 |
| 固定小档多次平均 | 请求小、实现短 | 100 KiB–1 MiB 对高速高 RTT 主要测到往返时间，不能直接采用 |
| 顺序 ramp + 一组最多双请求 | 主体简单，末尾可摊薄 RTT | 采用；没有持续 worker / 补发循环，已发出请求只受全局期限约束 |

1 / 2 / 4 并发的取舍：在相同 32 MiB 总量、相同 RTT 的理想共享链路模型中，2 × 16 MiB 与 4 × 8 MiB 的完成时间相同；四并发增加回调和连接压力，没有证明额外收益。纯顺序仍适合慢速档，短档到达上限时才使用两请求。此比较是模型推理，不是 Surge 引擎并发实测。

### 采样与预算

- 保留 15 秒本地重复点击保护；测速全流程仍为 8 秒 watchdog。普通网络 / 订阅检测先完成，整次 Panel 刷新可能更长。
- 32 KiB 预热不计入速度。随后顺序尝试 512 KiB、2 MiB、8 MiB、16 MiB；单响应始终小于官方 iOS 上限。
- 某档时长达到 max(1000ms, 3 × 预热耗时) 即停止放大；预热耗时只用于选档和预估是否来得及，绝不从速率分母扣除。
- 2xx、没有传输错误、binary byteLength 精确等于请求量才是完整响应。一个至少 512 KiB、至少 100ms 的完整样本就立即保留为“快速采样”，不会等第二个请求才承认已有数据。
- 长档若时间允许，顺序重复一次，用两次实际字节之和 / 实际耗时之和计算；不平均不同档位的瞬时速度。短档若仍有预算，只发一组两个相同大小请求，用两者完整字节 / 从启动到最后回调的真实墙钟时间计算。
- 没有 1.5 秒 pilot、速度分档、成功比例门槛、持续补发 worker 或中途关闭的采样窗口。调度结束与排空不同：已发出的请求可以一直完成到全局期限；计入晚到字节时，也必须计入真实完成时间。
- 可选放大 / 确认失败或缺失回调时，保留已合格结果。全局期限关闭后不再改写结果、缓存或发请求；原生在途请求可能稍后回调，8 秒是脚本结果期限，不宣称存在原生取消能力。
- 原生每请求 timeout 最多 4 秒并受剩余时间约束；最多 2 并发、16 个请求、64 MiB 请求正文总预算（含预热、失败与在途请求）。普通成功路径最多 7 个下载请求、约 58.532 MiB；多数慢速线路消耗更少。只使用一个总 watchdog，避免每块计时器堆积。
- 初始 512 KiB 遇到 body limit / 2xx 正文不匹配，或预热成功后的 timeout / transport，可尝试 60 / 48 / 32 KiB 三个同源小块。首次成功后顺序累计，至少 3 个完整响应、128 KiB 和 100ms，最多 10 个成功小样本；若较小档完整但不足 100ms，放大遇到 body limit / 正文不匹配，也复用这个已成功档位累计，不重新探测。整个降级路径最多 14 个请求，标“小响应降级”。不靠短正文、字符串长度或 Content-Length 补字节。
- 明确 HTTP 拒绝、重定向、429、5xx 立即停止对应后续尝试，不缩块重试，不等待重试。已有合格大样本时直接保留，不再进入小块降级。

这是短时下载估算，不是 benchmark。低速档以较长完整请求减少 RTT 占比；高速档以双请求摊薄固定开销。RTT 很高、Surge 缓冲或 callback 桥接慢时仍可能低估，也可能仅保留快速采样；不人为修正到“线路标称值”。小响应降级尤易低估高速线路。500 Mbps 刻度满格，超过刻度仍显示真实数值。

失败安全分类继续保留 timeout、HTTP status、body mismatch、body limit、insufficient samples、deadline、cooldown、transport 和 storage；UI 中 timeout / deadline 简写“超时”，不显示或记录 raw error。

测速值的展示严格区分：
- 本次成功：数值、MB/s 与速度条；必要时注明快速采样 / 小响应降级。
- 本次失败：先显示“测速失败 · 原因”，旧值只在“上次”中作历史参考，注明同出口、旧出口或出口未确认；不显示速度条，不改写旧缓存。
- 自动刷新：同观测出口显示“测速缓存 · 数值 · 时间”；不匹配或无法确认出口时显示“测速暂无当前出口结果”，不主显示旧值或速度条。
- 15 秒冷却：不发起下载，也不把旧值显示为本次成功。

缓存绑定的是 Net.Coffee 观测出口；Surge 可能将测速域名单独分流，因此“同出口”只是该观测值相同，并不证明测速请求与其他检测共享路径。跨日期缓存附日期，避免旧值看起来像今天的结果。

## 紧凑布局示例

以下为示例数据，✓ 仅表示对应公开入口可达；常见正常路径为 22 行，有订阅数据 / 本次测速时为 23–24 行（系统实际换行取决于字体和屏幕宽度）。

```text
🌐 6-1904
IPv4 本地 · NAT 推断 · IPv6 本地
DNS 自定义/本地 · 24ms

🚪 台湾 · 160.30.*.* · AS9923
Simple Information · New Taipei City

⚡ DIRECT 249ms · 当前 358ms
测速失败 · 超时 · 上次 11.2 Mbps（15:16 · 旧出口）

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
| 1.5.2 无缓存默认 | 2（trace + lookup） | 16 |
| 1.5.2 同出口缓存命中 | 1（trace） | 15 |
| `RISK=0` 无缓存 | 2（trace + Geo） | 16 |
| 主查询失败且需要 Geo 补充 | 最多 3 | 最多 17 |
| 出口发现失败 | 1；或退避期内 0 | 15；或 14 |

1.5.2 未增加自动刷新请求，仍是通常 16 / 缓存 15 次。手动测速由原先最多 256 请求 / 128 MiB，降为 16 请求 / 64 MiB；普通成功路径最多 7 请求，小响应降级最多 14 请求，没有新增测速服务。

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

1. 台湾出口点击刷新测速。
2. 香港出口点击刷新测速。
3. 美国出口点击刷新测速。
4. 自动刷新确认没有下载请求。
5. 检查数字、失败 / 历史语义及风险行折行。

自动化覆盖 10 / 50 / 100 / 300 / 500 Mbps 与 50 / 150 / 300 / 500 / 900ms RTT 的 17 个指定组合，并模拟回调延后、漏回调、重复回调、HTTP / 正文错误、全局期限、缓存和并发 / 字节上限。它证明时序与数学约束，不等于 Surge iPhone 实际测速通过。Actions 的 Cloudflare 探测只验证 endpoint / HTTP / 二进制长度契约，不测量手机或节点带宽。

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
