# 贝蒂的基础面板：技术说明

本文记录 `Betty-Basic-Panel` **1.5.0** 的稳定行为与安全边界。版本号与安装入口以 [`Modules/Betty-Basic-Panel.sgmodule`](../Modules/Betty-Basic-Panel.sgmodule) 为准。

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

`RISK=0` 不访问主查询 / 风险接口，不读取风险缓存；Geo 未提供的 ASN 保持未知。默认主查询本身已包含 Geo，因此不重复调用 Geo。所有旧 IP 情报供应商均已退出，Cloudflare 仅保留延迟和手动下载估算用途。

Trust 直接展示 `trust_score` 的 0–100 原值，越高越可信；不反转、不平均，也不生成“纯净度”。住宅、机房、VPN、代理、Tor 独立保留是 / 否 / 未知；`company_type` 是分配类型，不能推导住宅或风险高低。面板明确显示单源，不把网站内部聚合字段包装成独立供应商共识。

成功结果使用 v2 缓存，最多 1 小时，不在读取时延长 TTL；过期、未来时间、字段损坏或出口变化时重新查询。每次先观察出口，失败时不展示旧出口或旧信誉。存储异常不阻止刷新，原始响应中的无关字段不保存。

403 / 429 按 endpoint 退避：支持 `Retry-After` 秒数或 HTTP 日期，限制为 1 分钟至 7 天；缺失或无效时保守暂停 24 小时。退避跨出口保留，不循环重试，不跟随重定向。未取得公开额度 / SLA 承诺，也未通过主动制造限流探测阈值。每个请求原生超时 5 秒、回调 watchdog 7 秒；trace 超过 4096 字符或 JSON 超过 65536 字符拒绝解析（这是解析上限，网络缓冲仍受 Surge 原生响应限制）。

Net.Coffee 全站不可用时只显示“IP 情报暂不可用”，本地网络、DNS、延迟、服务入口、订阅和测速缓存继续工作。主查询失败时最多补一次同站 Geo，没有其他供应商 fallback。

公网地址校验依据 IANA 特殊用途注册表，排除私网、CGNAT、回环、链路本地、文档、benchmarking、多播、保留地址及 IPv4-mapped IPv6；IPv4 前导零歧义也被拒绝。IPv6 保留普通 global-unicast 和已明确分配的协议例外，排除 `2001:db8::/32`、`3fff::/20`、benchmarking 及 ORCHID / DET 标识符。校验是用途过滤，不是路由可达性证明。

## 本地网络状态

- IPv4 / IPv6 的“本地有”来自 Surge `$network`。
- 面板不声称能从公开 API 反推出模块覆盖后的完整 VIF 状态；无法确定时显示 `VIF 未知`。
- 只有实际观察到 IPv6 出口时才说明 IPv6 出口可达；IPv4 成功不能证明 IPv6 不可用。
- DNS 名称只识别系统实际提供的服务器地址；延迟是本地 DNS 测试 API 的整次调用耗时。
- NAT / CGNAT 只基于本地地址范围推断，不宣称执行 STUN 或完整 NAT 类型测试。

## 流媒体与 AI 状态语义

面板判断的是**公开入口的网络可达性**，不是账号、订阅、版权区或完整功能解锁。

- Netflix：样片入口用于观察区域页面；失败时可使用备用页面区分“主入口受限”和完全不可达。
- YouTube：只有实际看到 Premium 报价结构才显示对应提示；普通页面可达不等于 Premium 可购买。
- Disney+、Spotify、TikTok、Prime 与六项 AI 默认使用 HEAD 检查入口 / WAF。
- 2xx / 3xx 表示入口可达；401 / 403 / 429 / 451 表示受限；超时表示不可达；其他响应保持未知。
- TikTok / Prime 只在特定 HEAD 结果需要复核时执行一次 GET；明确的权限/限流响应不会靠重复请求“撞结果”。
- GET 不发送 Cookie / Authorization，不查询登录或播放私有接口，也不跟随地区跳转。

国家 / 地区信息不参与“可达 / 受限 / 未知”的硬判定，避免根据出口地理位置猜网站状态。

## 自适应下载估算

测速只在：

```text
$trigger === "button"
```

时执行。自动刷新、脚本编辑器、快捷指令与 HTTP API 入口都只读取最近缓存，不启动下载。

当前约束：

- 连续手动刷新有 15 秒本地保护。
- 全流程目标上限 8 秒。
- 所有探测与在途请求合计最多请求 128 MiB 正文。
- 最多 4 个并行 worker、256 个请求。
- 单响应最多 8 MiB；若 Surge 环境响应能力较小，会进入小响应降级。
- 结果使用有效窗口内实际完整收到的二进制字节 / 实际时间计算，不依赖字符串长度、`Content-Length` 或经验倍率。

这是短时**下载估算**，不是 Cloudflare 官方完整测速。结果会受时延、连接建立、Surge 缓冲、分流和样本量影响。刻度 500 Mbps 满格，超过 500 Mbps 时仍显示真实数字。

测速失败会保留上次成功值和时间；当前出口与历史出口不一致时明确标记为历史结果。

## 请求预算

| 自动刷新路径 | IP 情报请求 | 通常外部总数 |
| --- | ---: | ---: |
| 1.4.1 无缓存 | 4 | 18 |
| 1.5.0 无缓存默认 | 2（trace + lookup） | 16 |
| 1.5.0 同出口缓存命中 | 1（trace） | 15 |
| `RISK=0` 无缓存 | 2（trace + Geo） | 16 |
| 主查询失败且需要 Geo 补充 | 最多 3 | 最多 17 |
| 出口发现失败 | 1；或退避期内 0 | 15；或 14 |

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
6. TikTok / Prime 需要 GET 复核时，面板显示真实 GET 状态，而不是根据国家猜测。
7. 断网或测速失败时，最近成功测速值保留但明确标注时间 / 历史状态。

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
