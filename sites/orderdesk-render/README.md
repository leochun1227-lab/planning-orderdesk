# Regent RV Orderdesk（Render 版）

`sites/orderdesk` 的可部署版本：业务逻辑完全不变，换了运行平台和存储方式。

| | 原版本（ChatGPT Sites） | 本版本（Render） |
|---|---|---|
| 运行 | Cloudflare Workers + vinext | Node 22（Hono）+ Vite 打包的 React 页面 |
| 登录 | ChatGPT 账号 | 团队密码（`APP_PASSWORD`），会话 30 天 |
| 数据库 | `neworderschedule` 一个节点存整块 AES 加密 blob | `planningorderdesk` 按订单 / 日志 / 导入记录分节点存 |
| 每次保存 | 重新加密写回**全部**订单和日志 | 一次原子多路径 PATCH，**只写变化的节点** |
| 每次打开 | 下载 + 解密 + 解压全部数据 | 服务端内存缓存 + ETag（数据没变返回 304）+ gzip |
| 多人同时用 | 手动刷新 | 每 30 秒 / 切回窗口时检测新版本并自动刷新 |
| 防覆盖 | Firebase ETag | `revision` 版本号，同样报"数据已被更新，请刷新后重试" |

**没有改动的部分**（逐字复制）：`lib/order-engine.mjs`、`production-rules.mjs`、`planning-agent.mjs`、`mail-sync.mjs`、`outlook-report.mjs`、`crm-workbook.mjs`、`orderlist-export.mjs`、`planning-pc/` 全部文件。原有 52 个业务测试全部通过（`npm test`）。

## Firebase 数据结构

```
orderdesk/v2/
  revision            每次保存 +1
  savedAt
  orders/<chassis>    每台车一个节点，控制台可直接查看
  events/<id>         变更日志
  imports/<id>        导入记录
  meta                报告日期、同步状态
  blobs/<name>        refs / productionSources / orderlistExport / baselineOrders（gzip+base64）
```

Firebase 不保存 `null` 和空数组，所以这类值会被写成 `"%%null"`、`"%%[]"` 这样的占位字符串，读回时自动还原，保证数据和原版完全一致。

## 部署到 Render

1. **Firebase 服务账号**：Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥，下载 JSON 文件。
2. **锁定数据库规则**：Realtime Database → 规则，粘贴 `database.rules.json`（全部拒绝）后发布。服务端用服务账号访问，不受规则限制；外部无法读写。
   > 目前这个库是公开读写的，任何人都能删数据，请尽快锁定。
3. Render → **New → Blueprint**，选这个仓库，**Blueprint Path 填 `orderdesk-render/render.yaml`**（仓库根目录的 render.yaml 是另一个版本）。按提示填写：
   - `FIREBASE_SERVICE_ACCOUNT`：粘贴整个 JSON
   - `APP_PASSWORD`：团队登录密码
   - `SESSION_SECRET`、`PLANNING_AGENT_TOKEN` 会自动生成
4. 部署完成后打开 `https://<服务名>.onrender.com`，看到登录页就说明部署成功。

建议使用 **Starter** 套餐。免费实例空闲 15 分钟后会休眠，而 00:20 的电脑上传要求请求在扫描开始后 12 分钟内到达，冷启动有可能失败。

## 首次装入数据（新库是空的）

本地准备 `.env`（参考 `.env.example`，填写 `FIREBASE_SERVICE_ACCOUNT`），然后选择下面一种方式：

```bash
# A. 从旧网站迁移（推荐，保留全部历史）：需要旧部署的 ORDERDESK_KEY
ORDERDESK_KEY=<64位十六进制> node --env-file=.env scripts/migrate-legacy.mjs

# B. 从 Excel 基线重新初始化（与原 initialize.mjs 逻辑相同）
python scripts/prepare-baseline.py          # 生成 baseline.json（脚本里的路径需按需修改）
REPORT_DATE=2026-10-28 node --env-file=.env scripts/initialize-baseline.mjs baseline.json report.json
```

迁移脚本会解密旧数据、写入新库，再读回逐字节比对一致才算完成。目标库已有数据时会拒绝执行，除非加 `--force`。

备份 / 还原：

```bash
node --env-file=.env scripts/export-state.mjs backup.json
node --env-file=.env scripts/import-state.mjs backup.json --force
```

## Planning 电脑 00:20 定时任务

网站接口 `/api/planning-agent` 与原版完全兼容，电脑端程序不用改。按 `planning-pc/README.txt` 的步骤操作，只有两处不同：

- `Configure-Agent.ps1 -SiteUrl "https://<服务名>.onrender.com" -NodePath "..."`，**不要**加 `-PrivateSites`（Render 不需要 Sites 访问令牌）。
- 提示输入的令牌是 Render 环境变量里的 `PLANNING_AGENT_TOKEN`。
- 先运行 `Run-Agent.ps1 -VerifyOnly`，验证通过后在 Render 上把 `PLANNING_AGENT_ENABLED` 改为 `true`，再运行 `Install-Task.ps1`。

如果改用 Microsoft Graph 云端读信（`MAIL_SYNC_MODE=graph`），服务器会每 `MAIL_SYNC_INTERVAL_MINUTES`（默认 15）分钟自动同步一次，取代原来的 Cloudflare Cron。

## 本地开发

### 滚动排产线

所有经销商已签字、客户名非空且不以Stock结尾的Towable Customer按排产表顺序优先入线。Stock须先保存库存调整意见，再从符合条件的补货建议中勾选并确认；保持Stock类型，标记意见版本和预计完工/到店日期，可撤回。SRV/SRM不进入新滚动安排，Traralgon不接收Stock。未签字订单在处理中，客户名为空的处理记录不显示，也不计入列表数量或CSV。原已锁定和实际生产/运输阶段保留。

### 库存调整预测

左侧「库存调整预测」（`/#stock-forecast`）可按1.3、1.5等库存倍数测算并保存意见。直营与JV分别显示延期、取消、库存池暂不生产数量及下载。8/14个月只改变图表范围。保存按页面所见版本核对来源指纹，并保留最近5次意见历史；订单、库存、产能或日期改变时旧建议及Stock入线暂缓，重新保存后校验。确认操作具备版本与持久化修订检查，防止重复或过期入线，不改CRM订单、实际取消、调拨和锁定计划。

补货仅选已签字的推荐Towable展车型号，同Dealer接收，JV不转配。按保存的取消/延期/转配意见重放库存，检查总量和同款缓冲，已有到货未解决时暂缓该店补货。保留全部客户及实际/锁定队列的产能，新Stock最早AU完工须满足Portal配置的国内＋海运＋澳洲周期（默认20＋50＋40天），建议国内上线在未来60天内。图表可切换取消延期后、加已确认补货、加全部推荐补货；Excel含同口径补货清单和月度比较。

可选AI核对只在服务端使用Render已有的`OPENAI_API`，可用`OPENAI_MODEL`指定模型（默认`gpt-4.1-mini`）。只发送候选匿名编号、车型、Dealer、日期和库存指标，不发送客户姓名或API密钥。AI解释和提示不会改变候选、硬规则或入线状态；超时保留规则结果。

只计Towable Stock，当前库存及近三个月销量均排除SRV/SRM、客户车和二手车。库存池未排入生产，不计到货或取消；国内已开工未落实接收窗口的车辆列待分流。锁定线/滚动线无1个自然月内接收空间才取消。Traralgon不收车，JV不转配，直营可给出跨店及现货调拨候选。候选按库存及车型缓冲依次匹配，不代表全局最优，也不重新预订工厂产能或执行运输。现货未来发车前需核实未售。

图表同时显示调整前及调整后库存、到货柱及柱上台数。已在途及下游车辆仍可能造成超限；库存不足时交付量以可用库存为上限，缺货量单列。下载使用当前已计算结果，改参数后需先重算。

```bash
npm install
FIREBASE_DATABASE_URL=memory:// LOCAL_DB_FILE=.local-db.json FIREBASE_ROOT=demo node scripts/seed-demo.mjs --force
FIREBASE_DATABASE_URL=memory:// LOCAL_DB_FILE=.local-db.json FIREBASE_ROOT=demo npm run dev:server   # :3000
npm run dev:client                                                                                  # :5173
npm test
```

不设 `APP_PASSWORD` 时不需要登录（仅限本地）。
