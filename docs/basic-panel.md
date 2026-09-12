# 贝蒂的基础面板：技术说明

本文记录 `Betty-Basic-Panel` 的稳定行为与安全边界。版本号与安装入口以 [`Modules/Betty-Basic-Panel.sgmodule`](../Modules/Betty-Basic-Panel.sgmodule) 为准。

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

当前数据源：

| 来源 | 用途 | 行为 |
| --- | --- | --- |
| Cloudflare `speed.cloudflare.com/meta` | 新鲜出口 IP、国家、ASN | 每次重新观察；失败时使用独立 fallback |
| IPWho | 同一出口 IP 的国家、ASN、机构交叉查询 | 结果缓存 1 小时；出口变化立即失效 |
| ipapi.is | 归属补充；有实际风险字段时才使用 | 兼容匿名基础响应，不把缺失字段猜成 `false` |
| ProxyCheck v3 | 网络类型、VPN / proxy / Tor、原始 Risk / Confidence | 保留原始语义，不反转成“纯净度” |

Geo / ASN 只合并**同一出口 IP**的有效结果。一致时显示共识，冲突时显示分歧；平票不强行选赢家。机构名称差异单独提示。

信誉信号不计算“综合纯净度”，也不对不同供应商的风险值平均、加权或反转。VPN、住宅分配、机房、滥用记录和 ProxyCheck Risk 是不同概念；缺失数据不等于否定结果。

429 / 403 会独立退避，优先遵守 `Retry-After`；单个来源失败不会让整个面板失败。

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

无缓存自动刷新通常包括：

- 出口与交叉查询：4
- 延迟：2
- 流媒体：6
- AI：6

即约 **18 个外部请求**；归属缓存命中时通常约 15 个。TikTok / Prime 的方法复核按需各增加 1 个，而不是每次固定 HEAD + GET。

Netflix / YouTube 的同站跳转、出口 fallback、订阅流量 fallback 等特殊路径可能增加少量请求。

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
5. 单个信誉源失败时其余本地与网络信息仍能正常展示。
6. TikTok / Prime 需要 GET 复核时，面板显示真实 GET 状态，而不是根据国家猜测。
7. 断网或测速失败时，最近成功测速值保留但明确标注时间 / 历史状态。

## 依据

- [Surge Script API](https://manual.nssurge.com/scripting/api.html)
- [Surge Panel](https://manual.nssurge.com/tools/panel.html)
- [Surge HTTP API](https://manual.nssurge.com/tools/http-api.html)
- [Cloudflare speedtest](https://github.com/cloudflare/speedtest)

实现始终以当前脚本和模块文件为最终事实来源；本文只记录稳定契约，不保存一次性端点探测结果或临时调试日志。
