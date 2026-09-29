# 贝蒂的基础面板：技术说明

本文记录 `Betty-Basic-Panel` **1.5.1** 的稳定行为与安全边界。版本号与安装入口以 [`Modules/Betty-Basic-Panel.sgmodule`](../Modules/Betty-Basic-Panel.sgmodule) 为准。

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

## 自适应下载估算

测速只在：

```text
$trigger === "button"
```

时执行。自动刷新、脚本编辑器、快捷指令与 HTTP API 入口都只读取最近缓存，不启动下载。

当前约束：

- 连续手动刷新有 15 秒本地保护。
- 测速流程保留 8 秒总 watchdog；普通网络 / 订阅检测在此之前执行，整次 Panel 刷新可能更长。
- 所有探测与在途请求合计最多请求 128 MiB 正文。
- 最多 4 个并行 worker、256 个请求。
- 单响应最多 8 MiB。512 KiB 探测遇到响应上限、2xx 长度不符（包括空 / 非二进制正文），或在热身成功后遇到超时 / 传输失败时，最多尝试 60 / 48 / 32 KiB 三个同源小块；成功后进入“小响应降级”。明确 HTTP 拒绝、重定向、429 或 5xx 不触发缩块重试，失败 worker 不循环重试。
- 结果使用有效窗口内实际完整收到的二进制字节 / 实际时间计算，不依赖字符串长度、`Content-Length` 或经验倍率。

这是短时**下载估算**，不是 Cloudflare 官方完整测速。结果会受时延、连接建立、Surge 缓冲、分流和样本量影响。刻度 500 Mbps 满格，超过 500 Mbps 时仍显示真实数字。

初测（pilot）与精测分开判断：至少 2 个完整样本、128 KiB、50% 成功比例和有效时间窗口才成立。pilot 最短 100ms，正常精测窗口最短 500ms。较短初测、精测失败或总期限到达时，已成立的结果标为“快速采样”；小响应路径保留“小响应降级”。不会仅因可选精测失败丢弃有效 pilot，也会保留已合格但尚有 worker 未回调的初测窗口。不会挑选最大的瞬时速率。精测开始前检查剩余时间，预留请求延迟，窗口自适应延长也不得占用这段预留；8 秒结束后不再调度新下载，原生在途请求可能稍后回调。

失败结果只携带安全分类：timeout、HTTP status、body mismatch、body limit、insufficient samples、deadline、cooldown、transport 或本地存储保护不可用，不显示或记录原始错误正文。超时与 deadline 在面板上均简写为“超时”。

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
住宅 ✓ · 机房 ✕ · VPN ✕ · 代理 ✕ · Tor ✕
```

具体数值、条形刻度和机构名称按可用字段生成；不显示“机构未知 · AS未知”等占位组合。Trust 方向与独立信号语义没有变化。“剩余 / 总量”明确标注，不误称为已用。

## 请求预算

| 自动刷新路径 | IP 情报请求 | 通常外部总数 |
| --- | ---: | ---: |
| 1.4.1 无缓存 | 4 | 18 |
| 1.5.1 无缓存默认 | 2（trace + lookup） | 16 |
| 1.5.1 同出口缓存命中 | 1（trace） | 15 |
| `RISK=0` 无缓存 | 2（trace + Geo） | 16 |
| 主查询失败且需要 Geo 补充 | 最多 3 | 最多 17 |
| 出口发现失败 | 1；或退避期内 0 | 15；或 14 |

1.5.1 未增加自动刷新请求：相对 1.5.0 仍是通常 16 / 缓存 15 次。手动测速仍受 256 请求 / 128 MiB 上限约束；optional refinement 提前结束或失败时可能减少请求，没有新增测速服务。

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

真实设备回归时优先检查：

1. 自动刷新不会触发下载估算。
2. 手动点击 Panel 刷新才产生新测速值和时间。
3. 切换出口后，Geo / ASN / 风险缓存不会沿用旧 IP。
4. 网站“可达”不会被描述成账号或版权区“已解锁”。
5. Net.Coffee 不可用、返回不匹配 IP 或限流时，其余本地与网络信息仍能正常展示。
6. TikTok / Prime 成功时简洁显示 ✓，异常时保留真实 GET 状态；AI 500 计为异常。
7. 香港 / 台湾 / 美国等高延迟路径连续按钮测速；有效初测应在精测失败时显示“快速采样”。
8. 断网或测速失败时旧值仅作历史参考，无速度条；切换出口后自动刷新不会将历史值当成当前测速。
9. 台湾显示文字且没有国旗缺失字形；检查小屏幕实际折行。

自动化用确定性 mock 覆盖 200 / 300 / 500 / 900ms RTT、200 / 800 Mbps 链路、初测保留、回调缺失 / 重复 / 异常、HTTP / 正文错误、缓存展示和请求上限。它们不等于 Surge iPhone 真机测速通过。

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
