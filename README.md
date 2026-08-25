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

每天 08:00 自动完成哔哩哔哩每日等级经验任务：登录、观看、分享，以及最多投 5 枚硬币。脚本会先读取当日状态，只补做未完成项目；投币按当日已获得的投币经验与当前整数余额计算，硬币不足时有多少投多少。

日常模块本身没有 Cookie 监听或 MITM，不会常驻抓取 Cookie。首次使用、Cookie 失效或需要手动更新时，安装 `Betty-Bilibili-Cookie.sgmodule`，然后在 Surge 中手动运行 `Betty-Bilibili-Cookie` Generic Script，轻触通知打开 Bilibili 官方登录确认页面并完成确认；Cookie 验证通过后会自动保存到 Surge 本地。

Cookie 工具不使用 MITM、CA 或 HTTPS 解密，不需要修改托管配置，也不需要创建本地配置副本。Generic Script 不会自动运行，只有用户手动执行时才会请求 Bilibili 官方登录接口；模块可以长期保留。账号 Cookie 仅保存于 Surge 本地持久化存储，不写入仓库，也不会发送给第三方服务。

签到模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule

Cookie 获取模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule

后续每新增一个模块，都在此 README.md 中继续追加模块名称和用途说明。
