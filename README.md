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

用于汇总本地网络、出口 IP、DNS、延迟、测速、流媒体、AI 可达性、当前配置剩余流量与 IP 风险信息。

安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Basic-Panel.sgmodule

### Betty-Bilibili-Daily.sgmodule

贝蒂的哔哩哔哩每日签到。

每天 08:00 自动完成哔哩哔哩每日等级经验任务，也可在 Surge 中刷新“贝蒂的哔哩哔哩每日签到”Panel 立即手动执行。自动与手动入口共用同一套任务逻辑和带 TTL 的本地运行锁：脚本会先读取当日状态，只补做未完成项目；投币按当日已获得的投币经验与当前整数余额计算，硬币不足时有多少投多少，每次仅投 1 枚且不会自动点赞。

大会员账号会额外领取每日“专属等级加速包”对应的 +10 主站账号等级经验。脚本会先确保当日观看任务已经完成，再调用 `/x/vip/experience/add` 领取；成功返回后会再次读取 `/nav` 的 `level_info.current_exp` 验证经验变化。若接口返回 `69198`，视为当天已经领取。非大会员安全跳过。该 +10 EXP 与普通登录、观看、分享、投币组成的 65 EXP 每日任务分开显示，因此大会员当日理论最高可获得 75 点等级经验。

分享保留为 best-effort：只进行一次受控写入尝试。分享失败只在 Panel 与通知中单独标记，不再阻断大会员经验、投币或“核心任务完成”的判定；Cookie/CSRF 失效或账号封停等全局认证问题仍会停止后续写操作。

投币按“最多 5 枚、扣除今日已投、再受当前余额限制”的规则计算目标。脚本以 `/x/web-interface/coin/today/exp` 为主状态源，并以 `/x/member/web/exp/reward` 的 `coins` 经验值作为备用；每次写入前核对当前视频已投数量，原创最多 2 枚、转载最多 1 枚，每次只写 1 枚。投币表单使用 Web 端成熟实现常见的 `cross_domain=true`、`eab_x=2`、`ramval=3`、`source=web_normal`、`ga=1`，同时固定 `select_like=0`，不会自动点赞。`34004` 等可恢复错误会有限换视频重试；`403` 会立即停止本轮后续投币写入，避免继续顶风控。

任务完成通知会逐项显示登录、观看、大会员经验、分享、投币、账号等级经验、普通每日任务经验与硬币余额。账号等级经验直接读取 Bilibili `/nav` 的前后值；普通每日任务经验单独按 65 EXP 展示，大会员额外 +10 不混入该 65 EXP 统计。投币通知还会显示本轮新增枚数、写入次数及停止错误码，方便定位连续投币失败原因。

Cookie 获取与 Daily 任务不强制指定 DIRECT，而是按 Surge 当前规则、策略组与代理配置正常出站，避免模块擅自绕过用户现有网络设计。Cookie 工具只接受官方二维码登录响应与 Bilibili 主站补全得到的设备会话；不使用 SPI 人工补 `buvid3`。扫码后如果仍无法得到 `buvid3`，Cookie 获取会直接失败并保持本地无可用 Cookie。

日常模块本身没有 Cookie 监听或 MITM，不会常驻抓取 Cookie。首次使用、Cookie 失效或版本升级要求重新建立会话时，安装 `Betty-Bilibili-Cookie.sgmodule`，在 Surge 中找到“贝蒂的哔哩哔哩 Cookie 获取”Panel，手动点击刷新；刷新会先清空旧 Cookie，再生成新的 Bilibili 官方二维码。长按通知查看二维码并截图，在 Bilibili App 的“扫一扫”中从相册识别并确认登录。

如果已经生成二维码但忘记截图，只要当前二维码仍在有效期内，再次点击 Cookie Panel 刷新即可重新显示同一张二维码，不会创建第二个登录事务。为支持这一容错，二维码内容仅在 Surge 本地临时保存，并在成功、失败或超时后清除；不会写入仓库、日志或发送给第三方服务。收到“✅ Cookie 已验证并保存”后 Daily 即可使用。

两个 Panel 的自动刷新仅读取 Surge 本地状态，不会自动创建登录事务或执行 Daily 写任务。Cookie 工具不使用 MITM、CA 或 HTTPS 解密，不需要修改托管 Profile，也不需要创建本地配置副本。账号 Cookie 仅保存于 Surge 本地持久化存储，不写入仓库，也不会发送给第三方服务。

Surge 当前官方 Panel 语法没有跨模块全局排序字段，因此 Bilibili 面板与基础面板的显示顺序主要由用户本地模块顺序决定。

签到模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule

Cookie 获取模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule

后续每新增一个模块，都在此 README.md 中继续追加模块名称和用途说明。
