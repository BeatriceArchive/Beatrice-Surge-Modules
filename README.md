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

每天 08:00 自动完成哔哩哔哩每日等级经验任务，也可在 Surge 中刷新“贝蒂的哔哩哔哩每日签到”Panel 立即手动执行。自动与手动入口共用同一套任务逻辑和带 TTL 的本地运行锁：脚本会先读取当日状态，只补做未完成项目；投币按当日已获得的投币经验与当前整数余额计算，硬币不足时有多少投多少。

日常模块本身没有 Cookie 监听或 MITM，不会常驻抓取 Cookie。首次使用、Cookie 失效或需要手动更新时，安装 `Betty-Bilibili-Cookie.sgmodule`，在 Surge 中找到“贝蒂的哔哩哔哩 Cookie 获取”Panel，手动点击刷新运行；随后轻触通知打开 Bilibili 官方登录确认页面并完成登录，收到“✅ Cookie 已保存”后 Daily 即可使用。Cookie 不会自动获取。

两个 Panel 均没有自动刷新配置。Cookie Generic Script 只有在用户手动点击 Cookie Panel 时才会请求 Bilibili 官方登录接口；Daily 除每天 08:00 的原定 cron 外，也只会在用户手动刷新 Daily Panel 时额外执行。Cookie 工具不使用 MITM、CA 或 HTTPS 解密，不需要修改托管配置，也不需要创建本地配置副本。账号 Cookie 仅保存于 Surge 本地持久化存储，不写入仓库，也不会发送给第三方服务。

Surge 当前官方 Panel 语法没有跨模块全局排序字段，因此 Bilibili 面板与基础面板的显示顺序主要由用户本地模块顺序决定。

签到模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule

Cookie 获取模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule

后续每新增一个模块，都在此 README.md 中继续追加模块名称和用途说明。
