# Beatrice Surge Modules

[![Validate Surge Modules](https://github.com/BeatriceArchive/Beatrice-Surge-Modules/actions/workflows/validate.yml/badge.svg)](https://github.com/BeatriceArchive/Beatrice-Surge-Modules/actions/workflows/validate.yml)

贝蒂的 Surge iOS 模块仓库。这里保存可直接安装的模块、对应脚本与行为测试；不保存真实代理节点、订阅地址或账号凭据。

> 维护原则：稳定优先、最小权限、真实设备证据优先。模块已经进入维护型阶段，新增复杂度必须带来明确实际收益。

## 模块一览

| 模块 | 当前用途 | 版本 / 状态 |
| --- | --- | --- |
| `Beatrice-Surge-System.sgmodule` | Surge 网络基线覆盖 | 稳定 |
| `Beatrice-ENET-Patch.sgmodule` | ENET DNS 接管 / Bilibili DIRECT / 媒体 TCP 兼容 | 配合 System |
| `Betty-Basic-Panel.sgmodule` | 单一网络信息 Panel | 1.5.3 |
| `Betty-Bilibili-Daily.sgmodule` | Bilibili 每日等级经验任务 | 1.10.0 |
| `Betty-Bilibili-Cookie.sgmodule` | Bilibili 官方二维码登录 / 本地会话建立 | 1.5.0 |

### 安装地址

- [贝蒂的 Surge 托管设置](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Beatrice-Surge-System.sgmodule)
- [Beatrice ENET Patch](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Beatrice-ENET-Patch.sgmodule)
- [贝蒂的基础面板](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Basic-Panel.sgmodule)
- [贝蒂的哔哩哔哩每日签到](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule)
- [贝蒂的哔哩哔哩 Cookie 获取](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule)

## 模块说明

### Beatrice-Surge-System.sgmodule

**贝蒂的 Surge 托管设置**

只覆盖 `[General]`，用于固定当前设备的网络行为：

- `use-local-host-item-for-proxy = false`
- `compatibility-mode = 3`
- IPv6 / IPv6 VIF 关闭
- `wifi-assist = false`
- `all-hybrid = false`
- `udp-priority = true`
- 不支持 UDP 的策略直接 `reject`
- Wi-Fi / 热点代理共享关闭
- `include-all-networks = true`
- Local / APNs / Cellular Services 不额外接管
- `exclude-simple-hostnames = true`
- `proxy-restricted-to-lan = true`
- `icmp-forwarding = false`
- `loglevel = notify`

它不添加 MITM、Rewrite、Script、Panel 或策略组，也不覆盖托管配置的 DNS / DoH、`skip-proxy` 或 `tun-excluded-routes`。

严格源公网 IP 白名单环境下，关闭全局 Wi-Fi Assist / Hybrid 可减少主动蜂窝分流，IPv6 基线减少地址族漂移，但不能固定公网源 IP：物理网络切换、节点显式 IPv6 地址、节点 `hybrid=on` 或 SSID 级蜂窝回退仍需按托管配置与实机行为确认。System 不修改机场节点、策略组或规则。

### Beatrice-ENET-Patch.sgmodule

**Beatrice ENET Patch**

在 ENET 原生托管配置上同时启用 **System + ENET Patch**，继续使用机场原订阅。System 保持不变，负责 VIF、IPv6、UDP 回退、ICMP 与代理共享；Patch 只添加 `hijack-dns`、媒体 `always-raw-tcp-hosts` 和 Bilibili DIRECT 规则。两个模块没有重叠 General 键，System 不含 Rule，二者先后顺序不影响结果。若另外启用会覆盖这些键或拦截 Bilibili 的模块，仍需检查 Surge 的“生效顺序”。

- `hijack-dns = *:53` 接管进入 VIF 的硬编码 UDP DNS 查询，恢复 Fake IP 与域名分流；保留 ENET 的 DNS 上游、局域网及系统服务排除。它不解密应用自带 DoH/DoT，也不承诺拦截 TCP DNS。
- ENET 当前 `doh-server` 是有效的旧别名，对应现代 `encrypted-dns-server`。普通实际解析继续走腾讯 DoH、默认 DIRECT；传统 DNS 仍用于 DoH 主机名引导与连通性检测，不能宣称“零明文 DNS”。代理域名通常交给远端解析，但 ENET 中需要解析的 IP/GEOIP 规则仍可能先触发本地 DoH。
- 在 **Rule-Based** 模式下，主站、API、图片、视频、mcdn、UPOS、相关支付及国际版域名前置 DIRECT；共享 Akamai 只列精确 Bilibili 主机，不直连整个共享 CDN。`extended-matching` 仅补充可见的 SNI/HTTP Host，不能识别所有无域名的 IP/P2P 流量。
- raw TCP 仅追加 `*.bilivideo.com:443`、`*.mcdn.bilivideo.cn:443` 与三个精确 Akamai UPOS 主机，跳过协议嗅探，不改 TLS/HTTP2 协商、不阻断 DIRECT QUIC。DNS 已保留域名的媒体连接不依赖 SNI；无域名连接若无法嗅探，不能保证匹配。
- 不添加 STUN REJECT、全局 QUIC 封锁、MITM、Rewrite、Script、Panel、Proxy 或 Proxy Group。保留 captive portal 与网络切换的原有兼容路径；校园网、酒店认证及局域网私有域名仍需真机验证，遇到认证问题先关闭 Surge 完成认证。
- **Not implemented: Module limitation** — 不改机场节点/策略组、不改 Snell 服务端、不强制 DoH 走未知代理组；不使用未经官方确认的空值关闭 controller，也不把 `proxy-restricted-to-lan` 当作 controller 的保护开关。ENET 的 controller 原值保留；Mac-only listener 与陈旧引擎参数不在此 iOS 补丁中处理。

核验日期：2026-10-05。依据：[官方 Module](https://manual.nssurge.com/profile/module.html)、[General](https://manual.nssurge.com/profile/general.html)、[DNS](https://manual.nssurge.com/dns/advanced.html)、[Encrypted DNS](https://manual.nssurge.com/dns/encrypted-dns.html)、[Domain Rules](https://manual.nssurge.com/rules/domain.html) 与 [HTTP Processing](https://manual.nssurge.com/http/overview.html)。交叉参考 [SukkaW/Surge](https://github.com/SukkaW/Surge)、[blackmatrix7](https://github.com/blackmatrix7/ios_rule_script)、[Rabbit-Spec](https://github.com/Rabbit-Spec/Surge)、[dler-io/Rules](https://github.com/dler-io/Rules) 和 [Hackl0us](https://github.com/Hackl0us/SS-Rule-Snippet) 的当时最新 HEAD；旧配置仅用于结构/域名比较，不继承旧默认值。DivineEngine 原地址不可用，以 dler-io 的现有规则交叉参考。

已核对模块静态语法、两个加载顺序的合并逻辑、域名命中范围与秘密检查。Bilibili 公共播放接口仍返回 `bilivideo.com` 和精确 Akamai UPOS；`io.hdslb.com` 在双源 DNS 查询中均为 NXDOMAIN，未照搬。未纳入缺少当前业务证据的 `bilicomics`、泛 CDN 根域及动态 P2P IP。未执行 iPhone/Surge 泄漏或播放测试；raw TCP 是否改善卡顿须真机 A/B。

远程模块持续跟随上方稳定 `main` Raw 地址更新；机场托管配置更新与模块更新独立。禁用 Patch 即撤回其额外 DNS/规则/TCP 设置，禁用 System 可撤回通用基线。

### Betty-Basic-Panel.sgmodule

**贝蒂的基础面板**

保持**单一 Panel**，默认：

```text
YS=1&RISK=1
```

核心能力：

- 本地 IPv4 / IPv6、DNS、NAT / CGNAT 状态
- Net.Coffee 单源观测出口、国家 / 地区 / 城市、ASN / ISP / 机构
- Net.Coffee 原始 Trust 与独立类型 / 信誉信号，不计算“综合纯净度”
- DIRECT 与当前规则 / 可选策略的延迟
- Netflix、YouTube、Disney+、Spotify、TikTok、Prime 入口可达性
- ChatGPT、Claude、Gemini、DeepSeek、Grok、Perplexity 可达性
- 当前 Profile 流量信息
- 仅手动点击刷新时执行三路固定批次的下载吞吐估算，8 秒 / 64 MiB 上限；多流结果显示速度条，单流回退明确标注“单流估算”
- 紧凑布局、文字地区、异常状态码；历史测速只作参考，不显示为本次结果

重要边界：

- “网站可达”不等于账号、付费、版权区或完整功能解锁。
- 出口、测速、各网站检测可能被 Surge 分流，不保证使用同一出口。
- 自动刷新不测速；只有 Panel 按钮刷新才下载。
- 不发送 Cookie / Authorization / 节点配置给第三方信息源。
- 不使用 MITM、Rewrite 或远程脚本加载。

完整数据源、请求预算、测速边界与真机验收说明见 [`docs/basic-panel.md`](docs/basic-panel.md)。

### Betty-Bilibili-Daily.sgmodule

**贝蒂的哔哩哔哩每日签到**

每天 **08:00** 自动运行，也可以通过 Surge Panel 手动执行。

当前稳定行为：

- 自动与手动入口共用同一任务逻辑和 TTL 运行锁。
- 读取当天任务状态，只补做尚未完成的项目。
- 观看、分享、投币分别核对官方状态，不把 HTTP 200 直接当成任务完成。
- 分享同账号、同北京时间自然日最多一次写入；只有官方每日状态确认后才显示完成。
- 投币根据今日已获得经验、当前整数余额和视频已投数量逐枚补足，最多 5 枚，不自动点赞。
- 大会员在观看任务完成后额外尝试领取每日 +10 主站账号等级经验。
- 认证失效或明确风控错误时停止后续写操作，避免重复顶服务端。

Daily 不监听 Cookie，也不需要 MITM。

### Betty-Bilibili-Cookie.sgmodule

**贝蒂的哔哩哔哩 Cookie 获取**

这是独立的**手动登录工具**。点击 Panel 刷新后：

1. 创建或继续 Bilibili 官方 Web 二维码登录事务。
2. 用户在 Bilibili App 中扫码确认。
3. 模块完成受控主站 Cookie 补全。
4. 校验 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3` 与 `/nav` 登录 UID。
5. 全部成功后才一次性替换旧会话。

新登录失败不会删除原有已验证会话。二维码仍有效时再次刷新会重新显示同一张二维码，而不是创建第二个事务。

Cookie 只保存在 Surge 本地持久化存储；不写入仓库、不发送给第三方服务。QR、主站补全和验证都按 Surge 当前规则出站，不强制 DIRECT，也不使用 MITM、CA 或 HTTPS 解密。

Bilibili 会话恢复、分享 `-403` 调查、PC-client 请求依据与真实设备验收记录保留在 [`docs/bilibili-session-share.md`](docs/bilibili-session-share.md)。该专项文档是**证据记录**，不是要求每次维护都重跑的操作手册。

## Panel 行为

- “贝蒂的基础面板”自动刷新只更新信息，不启动下载测速。
- Bilibili Daily Panel 的刷新会立即执行 Daily 任务。
- Bilibili Cookie Panel 的自动更新只读取本地状态；手动刷新才创建 / 继续二维码登录事务。
- Surge 当前 Panel 语法没有跨模块全局排序字段，因此显示顺序主要取决于用户本地模块顺序。

## 安全与隐私

仓库与模块遵循以下边界：

- 不在仓库保存 Cookie、Authorization、代理节点、订阅 Token 或私人 Profile。
- Bilibili 会话只保存在 Surge 本地。
- 基础面板只向信息服务发送完成对应查询所需的出口 IP / 请求，不上传配置正文。
- 不通过 MITM / CA / HTTPS 解密获取 Bilibili Cookie。
- 不为了“提高成功率”循环轮换 UA、设备指纹或大量请求参数。
- 真实设备行为与服务端风控发生冲突时，以保守停止写操作为默认。

## 与其他 Beatrice 仓库的关系

- [Beatrice-Surge-Config](https://github.com/BeatriceArchive/Beatrice-Surge-Config) 负责完整 Surge Profile 的网络基线、策略组与规则。
- 本仓库负责可独立安装的 Surge 模块与脚本。
- 私人 `Beatrice-Sub` 工作台可生成订阅输出，但本仓库不依赖它才能安装或运行模块。

`Beatrice-Surge-System.sgmodule` 与 Config 的重叠 General 项由生态验证检查，避免两个仓库悄悄形成冲突值。

## 验证

本仓库的本地验证：

```bash
node scripts/validate-modules.mjs
node --test tests/*.test.mjs
```

行为测试运行在隔离的 mock Surge 环境：

- 不使用真实 Bilibili Cookie。
- 不触发真实 Bilibili 写入。
- 对关键状态机、请求上下文、失败边界与跨模块契约做确定性验证。

GitHub Actions 还会核对与 `Beatrice-Surge-Config` 的共享 General 契约。

## 仓库结构

```text
Modules/    可直接安装的 .sgmodule
Scripts/    Surge JavaScript 运行脚本
docs/       稳定技术说明与专项证据
scripts/    静态 validator
tests/      mock Surge 行为测试
```

## 使用与版权

本仓库保持公开，方便直接安装、更新和分享官方链接。

允许个人、非商业地直接安装和使用本仓库模块，也允许仅供自己使用的本地修改。可以自由分享本仓库地址或官方 `raw.githubusercontent.com` 安装地址。

未经 BeatriceArchive 事先书面许可，不得将本仓库代码或模块复制到其他仓库、网站、频道或软件包后重新发布；不得改名、换皮、删署名后作为自己的项目发布；不得公开分发修改版或其他衍生版本；不得冒充原创或用于商业销售与付费分发。

完整条款见 [`LICENSE`](LICENSE)。第三方材料仍按各自原始许可证与版权声明执行。
