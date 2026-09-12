# Beatrice Surge Modules

[![Validate Surge Modules](https://github.com/BeatriceArchive/Beatrice-Surge-Modules/actions/workflows/validate.yml/badge.svg)](https://github.com/BeatriceArchive/Beatrice-Surge-Modules/actions/workflows/validate.yml)

贝蒂的 Surge iOS 模块仓库。这里保存可直接安装的模块、对应脚本与行为测试；不保存真实代理节点、订阅地址或账号凭据。

> 维护原则：稳定优先、最小权限、真实设备证据优先。模块已经进入维护型阶段，新增复杂度必须带来明确实际收益。

## 模块一览

| 模块 | 当前用途 | 版本 / 状态 |
| --- | --- | --- |
| `Beatrice-Surge-System.sgmodule` | Surge 网络基线覆盖 | 稳定 |
| `Betty-Basic-Panel.sgmodule` | 单一网络信息 Panel | 1.4.1 |
| `Betty-Bilibili-Daily.sgmodule` | Bilibili 每日等级经验任务 | 1.10.0 |
| `Betty-Bilibili-Cookie.sgmodule` | Bilibili 官方二维码登录 / 本地会话建立 | 1.5.0 |

### 安装地址

- [贝蒂的 Surge 托管设置](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Beatrice-Surge-System.sgmodule)
- [贝蒂的基础面板](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Basic-Panel.sgmodule)
- [贝蒂的哔哩哔哩每日签到](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule)
- [贝蒂的哔哩哔哩 Cookie 获取](https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule)

## 贝蒂的 Surge 托管设置

`Beatrice-Surge-System.sgmodule` 只覆盖 `[General]`，用于固定当前设备的网络行为：

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

它不添加 MITM、Rewrite、Script、Panel 或策略组。

## 贝蒂的基础面板

`Betty-Basic-Panel.sgmodule` 保持**单一 Panel**，默认：

```text
YS=1&RISK=1
```

核心能力：

- 本地 IPv4 / IPv6、DNS、NAT / CGNAT 状态
- 当前观测出口、国家 / ASN / 机构交叉验证
- ProxyCheck / ipapi.is 的原始信誉信号，不计算“综合纯净度”
- DIRECT 与当前规则 / 可选策略的延迟
- Netflix、YouTube、Disney+、Spotify、TikTok、Prime 入口可达性
- ChatGPT、Claude、Gemini、DeepSeek、Grok、Perplexity 可达性
- 当前 Profile 流量信息
- 仅手动点击刷新时执行的自适应下载估算

重要边界：

- “网站可达”不等于账号、付费、版权区或完整功能解锁。
- 出口、测速、各网站检测可能被 Surge 分流，不保证使用同一出口。
- 自动刷新不测速；只有 Panel 按钮刷新才下载。
- 不发送 Cookie / Authorization / 节点配置给第三方信息源。
- 不使用 MITM、Rewrite 或远程脚本加载。

完整数据源、请求预算、测速边界与真机验收说明见：

- [`docs/basic-panel.md`](docs/basic-panel.md)

## Bilibili Daily

`Betty-Bilibili-Daily.sgmodule` 每天 **08:00** 自动运行，也可以通过 Surge Panel 手动执行。

当前稳定行为：

- 自动与手动入口共用同一任务逻辑和 TTL 运行锁。
- 读取当天任务状态，只补做尚未完成的项目。
- 观看、分享、投币分别核对官方状态，不把 HTTP 200 直接当成任务完成。
- 分享同账号、同北京时间自然日最多一次写入；只有官方每日状态确认后才显示完成。
- 投币根据今日已获得经验、当前整数余额和视频已投数量逐枚补足，最多 5 枚，不自动点赞。
- 大会员在观看任务完成后额外尝试领取每日 +10 主站账号等级经验。
- 认证失效或明确风控错误时停止后续写操作，避免重复顶服务端。

Daily 不监听 Cookie，也不需要 MITM。

## Bilibili Cookie

`Betty-Bilibili-Cookie.sgmodule` 是独立的**手动登录工具**。

点击 Panel 刷新后：

1. 创建或继续 Bilibili 官方 Web 二维码登录事务。
2. 用户在 Bilibili App 中扫码确认。
3. 模块完成受控主站 Cookie 补全。
4. 校验 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3` 与 `/nav` 登录 UID。
5. 全部成功后才一次性替换旧会话。

新登录失败不会删除原有已验证会话。二维码仍有效时再次刷新会重新显示同一张二维码，而不是创建第二个事务。

Cookie 只保存在 Surge 本地持久化存储；不写入仓库、不发送给第三方服务。QR、主站补全和验证都按 Surge 当前规则出站，不强制 DIRECT，也不使用 MITM、CA 或 HTTPS 解密。

Bilibili 会话恢复、分享 `-403` 调查、PC-client 请求依据与真实设备验收记录保留在：

- [`docs/bilibili-session-share.md`](docs/bilibili-session-share.md)

该专项文档是**证据记录**，不是要求每次维护都重跑的操作手册。

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
