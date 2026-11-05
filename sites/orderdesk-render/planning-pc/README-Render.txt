Planning 电脑每日自动读取 CRM 报告（Render 版网站）

作用：每天悉尼时间 00:20，读取经典版 Outlook 中 planning@regentrv.com.au › CRM Report 文件夹里
近 30 分钟收到的 "Sales Order Report (Customer)" 邮件附件，上传到网站并自动更新订单。只读邮件，不发、不删、不改已读。

一、电脑条件
 1. Windows，时区：(UTC+10:00) Canberra, Melbourne, Sydney。
 2. 经典版 Outlook（不是新版 Outlook），已登录并能看到 Planning 邮箱的 CRM Report 文件夹。
 3. 安装 Node.js 22 LTS 或更新版本（https://nodejs.org）。
 4. 每天 00:20 电脑必须开机、联网，用同一个 Windows 用户保持登录（可以锁屏，不能注销）。
    电源选项里允许"唤醒定时器"，或者干脆设置为不睡眠。

二、Render 网站设置（Render › 服务 › Environment）
 - MAIL_SYNC_MODE = planning-pc
 - PLANNING_AGENT_TOKEN：已自动生成，点眼睛图标复制（下面第 4 步要用）
 - PLANNING_AGENT_ENABLED 先保持 false

三、在 Planning 电脑上（Windows PowerShell，不要用管理员身份）
 1. 把 planning-pc 文件夹复制到 C:\Users\<当前用户>\Documents\OrderDeskPlanningAgent
 2. cd "$env:USERPROFILE\Documents\OrderDeskPlanningAgent"
 3. Get-ChildItem | Unblock-File          # 解除"从网上下载"标记
    如果提示禁止运行脚本：Set-ExecutionPolicy -Scope Process Bypass   （只对当前窗口有效；公司策略不允许就找 IT）
 4. .\Configure-Agent.ps1 -SiteUrl "https://你的网站.onrender.com" -NodePath (Get-Command node).Source
    提示输入令牌时，粘贴 PLANNING_AGENT_TOKEN（不显示是正常的）。令牌用这台电脑当前 Windows 用户加密保存。
 5. .\Run-Agent.ps1 -VerifyOnly
    然后打开 last-run.json：没有 "error" 就是成功（白天一般 matchedMessages 为 0，正常）。
    如果报 Planning mailbox is missing or ambiguous：Outlook 里有多个邮箱，需要配置 StoreId，联系安装人员。
 6. 回到 Render 把 PLANNING_AGENT_ENABLED 改成 true（保存后服务会自动重启）。
 7. .\Install-Task.ps1     → 创建任务计划 "OrderDesk Planning CRM Reader"，每天 00:20 运行一次。

四、第二天早上检查
 - 网站右上角显示"Planning 电脑同步正常"，数据连接页有最近成功时间；导入记录里有当天的报告。
 - 或看电脑上的 last-run.json。

暂停：任务计划程序里禁用 "OrderDesk Planning CRM Reader"，或把 PLANNING_AGENT_ENABLED 改回 false。
没收到报告/失败时不会用旧邮件补；网站会提示未按时同步，可以手动在网站"导入报告"补上。
