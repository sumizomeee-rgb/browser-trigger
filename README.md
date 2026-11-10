# 页面触发器 · Browser Trigger

独立的 Chrome Manifest V3 扩展，提供定时刷新与缺失页面保活。不读取 Cookie、页面正文或登录凭据，不依赖后台服务器。

## 页面保活

新增条目时将动作选为「保活 · 缺失时打开」，可以选择已打开页签，也可以输入网址。保活保存的是网址，不绑定会在重启后变化的页签 ID。保存后启用定时：浏览器启动时立即检查，此后按条目间隔检查；已有匹配页签就保留，没有就补开。多个匹配页签不会重复打开或自动关闭。加载中的匹配页签也算存在。

保活只负责页面存在，不替代定时刷新或验证登录。需要刷新触发凭据同步时，为同一网址保留独立刷新条目。例如保活每 1 分钟检查，刷新每 15 分钟执行。普通刷新条目的缺失等待、多匹配暂停和指定页签绑定规则保持原样。

## Windows 浏览器维护

扩展不能在 Chrome 完全退出后自行重启浏览器。`scripts/install-maintenance.ps1` 为已加载本扩展的 Chrome 用户配置登记 Windows 计划任务，默认从下次当地时间 04:30 开始，每 48 小时重启一次：

```powershell
pwsh -NoProfile -File scripts/install-maintenance.ps1 -EveryHours 48 -At '04:30'
```

可用 `-ChromePath`、`-ProfileDirectory`、`-TaskName` 指定浏览器、用户配置与任务名。安装器从 Chrome 配置发现本项目对应的扩展 ID；运行配置保存在忽略的 `.local/maintenance.json`。必须先登记并启用保活条目。

维护任务在已登录用户会话中运行，检测到本机 Playwright MCP 浏览器助手时退出并由 Windows 延后 15 分钟重试，最多三次。只处理当前用户的标准 Chrome 主进程，不处理自定义 `--user-data-dir` 测试实例。先正常关闭，30 秒未退出才结束已核实的进程树；确认旧主进程退出后再启动原用户配置。Cookie 和登录文件不删除，旧页面不批量恢复。启动入口 `wake.html` 请求扩展补齐启用的保活页面，成功后关闭自己的入口页；失败时保留入口页显示原因。

只读检查运行条件：

```powershell
pwsh -NoProfile -File scripts/restart-chrome.ps1 -Check
```

手动执行一次维护可去掉 `-Check`。维护会关闭浏览器现有页面，适合专用部署机；日常交互电脑应自行选择运行时段。更改周期后重新运行安装器；卸载维护任务使用 `Unregister-ScheduledTask -TaskName BrowserTriggerChromeMaintenance`，不会卸载扩展。

## 安装

1. 下载或克隆本仓库到任意本地目录。
2. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的仓库根目录。
4. 从工具栏扩展菜单打开“页面触发器”，或在扩展详情中打开“扩展程序选项”。

无需构建、安装依赖或启动本地服务。首次加载列表为空，不附带网站规则。清单声明最低 Chrome 120；不同版本的兼容性仍需实际验证。

## 使用

- 点击“新增条目”，填写名称、刷新动作和独立的分钟间隔，范围为 1 分钟至 7 天。
- 目标可下拉选择一个已打开页签，也可输入网站或完整页面地址。未写协议时默认使用 `https://`；根地址匹配同源网站，包含路径或查询参数时精确匹配页面，忽略 `#` 片段。协议、端口、路径和查询参数都会影响匹配。
- **新增和编辑后均保持暂停**。可先“执行一次”，确认后再开启该条目的定时开关；立即执行不会启用定时。
- 指定页签只刷新该页，同址的其他页签不会一起刷新。目标关闭后暂停；浏览器重启、扩展重新加载或更新后，须编辑并重新选择目标。
- 地址规则找不到目标时等待，不自动开页；匹配多个时暂停，请编辑并切换至“选择已打开页签”指定一个。
- 暂停会移除定时安排；删除会移除条目及定时安排。列表显示上次结果和时间，加载中的页面会跳过，避免叠加刷新。

“强制刷新”使用 `tabs.reload(tabId, {bypassCache:true})` 绕过浏览器本地缓存，不承诺绕过网站自身的离线策略。刷新请求返回不代表页面加载完成、登录有效或凭据健康。刷新前请保存页面中的输入。

## 权限与数据

仅申请 `tabs`、`alarms`、`storage`：用于列出页签标题与 URL、分钟定时、保存规则和结果。不申请网站主机、Cookie、脚本注入、网络拦截、调试器或原生消息权限。没有内容脚本、远程依赖、统计上报或云端同步。无痕窗口和非 HTTP/HTTPS 页签不支持。

配置及上次结果保存在扩展的 `chrome.storage.local`，具体 `tabId` 只保存在 `chrome.storage.session`。重启后须重新确认具体页签，避免误用旧数字 ID。个人规则和页面数据不会写入源码目录。

## 定时行为

使用 `chrome.alarms`，不需要设置页常开，也不通过 `setInterval` 维持 service worker。worker 恢复时核查闹钟，缺失时重建；迟到投递只处理一次，结束后从当前时间排下一次，不追赶遗漏次数。系统休眠或浏览器调度可能延后执行，不保证准点。

相同条目的并发请求会拒绝，旧启用批次的闹钟和重复投递会忽略，中断请求不自动重发。关闭浏览器后不会继续工作；网站地址规则按已保存的启停状态恢复，具体页签规则须重新确认。

## 开发与测试

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 可直接加载的 MV3 清单 |
| `background.mjs` | Chrome 事件入口 |
| `engine.mjs` / `core.mjs` | 调度、存储、匹配与配置校验 |
| `options.html` / `options.css` / `options.mjs` | 条目列表和编辑界面 |
| `tests/engine.test.mjs` | 内存 Chrome API 适配器的单元/模拟测试 |
| `PLAN.md` | 第一版范围与验收边界 |

测试使用 Node.js 24，无第三方依赖。在仓库目录运行：

```sh
node --test tests/engine.test.mjs
```

25 项单元/模拟测试覆盖刷新原行为与保活的启动补开、存在不重复、加载中不重复、停用跳过、关闭后补开、打开失败后恢复及启动入口并发等待。真实 Chrome 部署还需验证扩展重载、重启后恢复与凭据消费者落盘。这些结果不代表实际系统休眠、多日耐久或所有 Chrome 版本均已验收。

修改扩展代码后，在 `chrome://extensions` 点击本扩展的“重新加载”，再刷新设置页。具体页签重新绑定属于预期行为。

## 官方接口参考

- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
