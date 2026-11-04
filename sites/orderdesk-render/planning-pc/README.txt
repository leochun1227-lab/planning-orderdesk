Planning 电脑同步程序 — 待目标电脑安装验证

使用这台电脑的经典版 Outlook，读取 Planning / CRM Report 中指定发件人和标题的 Excel 报告，再上传网页。无需 Microsoft 应用注册、租户 ID 或 Microsoft 应用密钥。
当前交付是程序包；尚未在另一台 Planning 电脑安装，尚未发布网页接收接口或配置生产连接。

运行条件
- Windows 电脑保持开机、联网，使用有 Planning 邮箱访问权的同一个 Windows 用户保持登录。不要注销；重启后需要重新登录。
- 已安装、登录并配置经典版 Outlook，Planning 邮箱及 CRM Report 文件夹能读取。新版 Outlook 不适用。
- Node.js 22.13 或更新版本。使用 Windows PowerShell 5.1 执行下面的配置脚本。
- 企业脚本策略和 Outlook 自动化访问策略允许此程序；如遇安全提示，由实际用户或管理员处理，不修改策略绕过提示。

安装人员操作顺序
1. 将本目录放到该电脑当前用户专用的本地目录，例如 C:\Users\当前用户\Documents\OrderDeskPlanningAgent。不要放公共共享目录。
2. 网页端先备份并迁移已核对的订单数据，发布含 /api/planning-agent 的代码。当前 localhost 数据不会随代码发布自动迁移。
3. 服务器配置 MAIL_SYNC_MODE=planning-pc、PLANNING_AGENT_ENABLED=false，并设置随机至少 32 字符的 PLANNING_AGENT_TOKEN；保留原 ORDERDESK_KEY。这个令牌只允许提交 CRM 报告和同步状态，不是 Microsoft 密钥。
4. 私人 Sites 网站还需要平台提供的服务访问令牌。必须保持网站原访问范围，不通过改为公开来绕过登录。安装人员通过现有 Sites 服务接入方式取得并配置。
5. 在 Planning 电脑当前用户的 Windows PowerShell 中执行：
   .\Configure-Agent.ps1 -SiteUrl "https://实际网页地址" -NodePath "C:\实际路径\node.exe" -PrivateSites
   普通非 Sites 平台不需要 -PrivateSites。提示输入的令牌不会回显，并使用当前 Windows 用户的 DPAPI 加密保存。不要把令牌贴到聊天中。
6. 执行 .\Run-Agent.ps1 -VerifyOnly。必须从真实 Outlook 找到至少一份报告，并与网页现有日期、条数、去重结果核对。此步骤不改订单。
7. 验证通过后，服务器设置 PLANNING_AGENT_ENABLED=true，再执行 .\Install-Task.ps1。电脑时区必须是 Sydney（AUS Eastern Standard Time），任务每天 00:20 运行一次，自动跟随夏令时。无登录触发、无漏跑补抓、无周期重试；不保存 Windows 密码，不以 SYSTEM 账户运行。旧版任务若已安装，需要由安装人员修改为此设置，不能保留旧的 15 分钟触发器。
8. 查看第一次定时运行的 last-run.json，并在网页确认最近成功时间、导入记录和订单结果。任务名：OrderDesk Planning CRM Reader。

程序行为
- 只读取邮件及下载附件，不发邮件、不删邮件、不改已读状态，不关闭用户的 Outlook。
- 固定邮箱 planning@regentrv.com.au、文件夹 CRM Report、标题 Sales Order Report (Customer)、发件人 donotreply@my300375.mail.c4c.saphybriscloud.cn。
- 只接收本次检查开始前 30 分钟到检查开始时收到的邮件。00:20 的窗口是前一天 23:50 至当天 00:20。电脑端和网页端都检查接收时间。不会用旧邮件补足；没有新报告时记录“未收到”，不报同步成功。
- 按附件内部报告日期排序，先校验所有附件再依次导入；重复内容不重复更新。报告日期不能替代邮件接收时间来通过新鲜度检查。
- 沿用网页 Dealer 保留、Customer 归类、历史日期保护、Request date、完成和取消规则。
- 上传令牌只能访问该程序专用接口；数据库加密密钥留在网页服务器，不发给 Planning 电脑。
- 每次找到新鲜报告并完整处理后才上报成功；失败或没收到报告不伪报成功。每日 00:30 后仍没有当日成功记录时，网页提示未按时同步。
- 日志在 last-run.json。每次运行的临时附件只保存在本目录下 .runs 中，结束后清理本次目录。
- 一个报告作为一个原子提交；批次中途失败时之前已成功的报告保留，已过 30 分钟的邮件不会在之后自动补抓。

常见处理
- 找不到 Planning 或出现多个匹配：由安装人员确认 Outlook StoreId，再配置 StoreId。不能随意选择另一个邮箱。
- 公司策略禁止脚本、Outlook 提示授权或要求重新登录：由用户/管理员处理，然后重新试读；不要关闭安全保护。
- HTTP 401/403 或跳转：检查网页专用令牌及私人网站服务访问配置。
- HTTP 400/409：检查接收时间窗口、服务器启用开关、报表格式和并发更新；不会退回抓旧邮件。需要补录时在网页手动导入，保留相同去重规则。
- 暂停任务可在 Windows 任务计划程序禁用 OrderDesk Planning CRM Reader，也可将服务器 PLANNING_AGENT_ENABLED 设为 false。

交付验证范围
- 已验证服务器接收、鉴权、去重、日期保护、并发冲突和离线状态逻辑。
- PowerShell 已做语法检查；真实 Outlook COM 读取、目标电脑任务安装以及生产网站上传，需要在目标电脑和已发布网页完成验证。
