# Beatrice Surge Modules

贝蒂的 Surge 模块仓库。

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

Daily 还会在账号为大会员时尝试领取“大会员每日经验 +10”。该 +10 属于大会员额外经验，与账号每日等级经验 65 点分开显示；已领取时会识别并跳过，若接口提示前置观看任务未完成，则只额外执行一次有限观看后重试一次。

投币按“最多 5 枚、扣除今日已投、再受当前余额限制”的规则计算目标。脚本会在每次写入前重新核对当日投币经验，最多进行 10 次有限候选尝试；遇到投币间隔太短等可恢复状态会等待后换候选继续，避免之前连续快速写入导致只成功 1 枚。每次仍只投 1 枚，`select_like=0`，不会自动点赞。

分享继续使用当前成熟项目仍采用的 Web 分享接口和参数，并在分享前保证目标视频已打开、加入随机执行间隔。由于上游成熟项目也存在“App 手动分享正常、Web 接口返回 -403”的公开风控问题，脚本遇到单次分享 -403 后不会重复轰接口，而是明确记录分享未完成并继续执行投币和大会员经验等独立任务。

Cookie 获取与 Daily 任务不强制指定 DIRECT，而是按 Surge 当前规则、策略组与代理配置正常出站，避免模块擅自绕过用户现有网络设计。Cookie 工具只接受官方二维码登录响应与 Bilibili 主站补全得到的设备会话；不再使用 SPI 人工补 buvid3。扫码后如果仍无法得到 buvid3，Cookie 获取会直接失败并保持本地无可用 Cookie。

Daily 对认证失效、CSRF 失效或账号封停仍会立即停止后续写操作；单独的观看、分享或投币 403 只视为该项被拒绝，不会让已经安全可执行的其他任务被无条件跳过。

日常模块本身没有 Cookie 监听或 MITM，不会常驻抓取 Cookie。首次使用、Cookie 失效或版本升级要求重新建立会话时，安装 `Betty-Bilibili-Cookie.sgmodule`，在 Surge 中找到“贝蒂的哔哩哔哩 Cookie 获取”Panel，手动点击刷新；刷新会先清空旧 Cookie，再生成新的 Bilibili 官方二维码。长按通知查看二维码并截图，在 Bilibili App 的“扫一扫”中从相册识别并确认登录。

如果已经生成二维码但忘记截图，只要当前二维码仍在有效期内，再次点击 Cookie Panel 刷新即可重新显示同一张二维码，不会创建第二个登录事务。为支持这一容错，二维码内容仅在 Surge 本地临时保存，最长约 165 秒，并在成功、失败或超时后清除；不会写入仓库、日志或发送给第三方服务。收到“✅ Cookie 已验证并保存”后 Daily 即可使用。

两个 Panel 的自动刷新仅读取 Surge 本地状态，不会自动创建登录事务或执行 Daily 写任务。Cookie 工具不使用 MITM、CA 或 HTTPS 解密，不需要修改托管 Profile，也不需要创建本地配置副本。账号 Cookie 仅保存于 Surge 本地持久化存储，不写入仓库，也不会发送给第三方服务。

Surge 当前官方 Panel 语法没有跨模块全局排序字段，因此 Bilibili 面板与基础面板的显示顺序主要由用户本地模块顺序决定。

签到模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule

Cookie 获取模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule

后续每新增一个模块，都在此 README.md 中继续追加模块名称和用途说明。
