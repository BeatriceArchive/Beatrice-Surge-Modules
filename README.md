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

每天 08:00 自动完成哔哩哔哩每日等级经验任务，也可在 Surge 中刷新“贝蒂的哔哩哔哩每日签到”Panel 立即手动执行。自动与手动入口共用同一套任务逻辑和带 TTL 的本地运行锁：脚本会先读取当日状态，只补做未完成项目；投币按当日已获得的投币经验与当前整数余额计算，硬币不足时有多少投多少，每次只投 1 枚且不会附带点赞。

Daily 只接受当前 Cookie 工具明确验证过的新会话。首次使用、Cookie 失效或需要更新时，刷新“贝蒂的哔哩哔哩 Cookie 获取”Panel：刷新会先清空旧 Cookie、旧验证标记和旧 Panel 状态，再向 Bilibili 官方 Web 二维码接口申请一张全新的登录二维码。二维码内容直接使用官方接口返回的 `data.url`，仅在本机编码为图片，不上传到第三方二维码服务；扫码确认成功后读取官方登录响应 Cookie、访问一次 Bilibili 主站补全会话，并通过 `/x/web-interface/nav` 验证账号后才保存到 Surge 本地。

Cookie 获取不使用 MITM、CA 或 HTTPS 解密，也不会通过打开 Bilibili App、网络变化或 Profile 更新自动触发。Panel 的自动刷新只读取 Surge 本地状态，不访问 Bilibili；Daily 除每天 08:00 的 cron 外，只会在用户手动刷新 Daily Panel 时额外执行。账号 Cookie 仅保存于 Surge 本地持久化存储，不写入仓库，也不会发送给第三方服务。

Surge 当前官方 Panel 语法没有跨模块全局排序字段，因此 Bilibili 面板与基础面板的显示顺序主要由用户本地模块顺序决定。

签到模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Daily.sgmodule

Cookie 获取模块安装地址：

https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/Modules/Betty-Bilibili-Cookie.sgmodule

后续每新增一个模块，都在此 README.md 中继续追加模块名称和用途说明。
