# Regent RV Orderdesk（Render 版）

`sites/orderdesk` 的可部署版本：业务逻辑完全不变，换了运行平台和存储方式。

| | 原版本（ChatGPT Sites） | 本版本（Render） |
|---|---|---|
| 运行 | Cloudflare Workers + vinext | Node 22（Hono）+ Vite 打包的 React 页面 |
| 登录 | ChatGPT 账号 | 默认不需要登录（打开网址即可用）；设 `REQUIRE_PASSWORD=1` + `APP_PASSWORD` 可恢复团队密码，会话 30 天 |
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
   - `APP_PASSWORD`：团队登录密码（只有设了 `REQUIRE_PASSWORD=1` 才生效；默认不需要登录）
   - `SESSION_SECRET`、`PLANNING_AGENT_TOKEN` 会自动生成
4. 部署完成后打开 `https://<服务名>.onrender.com`，直接看到排程页就说明部署成功（默认不需要登录）。

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

### 产线列：Request Delivery Date

产线每个分组在 Model year 后面单独一列 Request Delivery Date，取 Portal schedule（即上传的排产表）里的值：日期、文字（如 Urgent）和空白都照排产表显示，空白 = 没有要求日期。不在排产表里的 SRM / SRV 用 Orderdesk 订单的日期（ASAP 显示为空）。可排序，CSV 导出也带这一列。

### 滚动排产线

先在「库存调整预测 · 直营 / JV / Independent」点击 **保存库存调整计划**，再点击 **确认调整计划作为排产前提**。确认全部取消、延期和Reallocation动作，复合动作按车架号只计一次总数；**库存订单池暂不生产不纳入确认范围，池内订单仍可被自动排产选中**。保存与确认是两个明确步骤；只保存而未确认时，自动排产按钮不可用，服务端也拒绝生成。

确认快照持久保存原计划版本、确认人、确认时间、各类动作数量和用于库存重放的完整报告（移除库存池不生产行）。按数量自动排产读取该快照，结果及PDF记录确认版本和调整明细。再次保存生成新版本，或者订单/库存/产能/日期/设置变化后，旧确认失效，须重新保存并确认。确认不会直接执行SAP/CRM取消、延期或转配，仍以这些已确认调整落实为计算前提。

在滚动线输入本期**总数量**（Customer + Stock），设置**每周客户比例**（0–100%，默认35%），点击「按数量自动排产」。未锁定、未进入实际产线的已签字Towable客户单与Stock先留在库存订单池，未生成前不占滚动产能。生成后只将本期选中车辆放入滚动线，未选中的继续留池。

本次数量是硬目标：只有真实订单数量恰好等于输入数量才会保存，不保存83/180之类的部分方案，也不以待建订单、重复车架号或SRV/SRM凑数。每周按目标比例及累计整车取整穿插客户。客户仍按签字图接收日期排序，条件为CN＋海运＋AU周期、需求交付日期 ≤ AU下线日期；库存池原Forecast是可重排的历史计划日期，不再当作生产锁。无需求日期/ASAP/Urgent为尽早，无法解析的交付备注待核对。

在已有AU产能及已保存库存预测范围内搜索后续周。未决在途/在产/锁定车辆按原到货日期计入库存预留，没有日期时从今天保守计入，不再因一家店有待核到货就禁止整家店补货。先补直营、JV、Independent的Ideal缺口；达到Ideal后，剩余Stock按最低预计库存峰值/Ideal逐台均衡分配，再比较平均交付覆盖和车型缺口。原Ideal倍数上限和单车型缓冲改为参考成本，不截断本次数量；推荐车型优先，必要时用非推荐车型并在报告披露。暂停接收、缺少有效Ideal/运输时间、未签字、实际生产/到店、重复和取消等资格限制继续有效。

尚未锁定的直营库存池Stock可在直营店之间做计划接收Dealer调整，原Dealer保留在排产明细中；不会修改CRM/SAP订单。JV和Independent已有订单仍保留原Dealer。真实订单或有效产能确实不足时整次生成报错并保留上次方案，要求补齐数据，不把部分结果保存成完成。

「**下载排产报告 PDF**」下载这次保存的计算快照（英文、A4横向）：目标与已排数量、Customer / Dealer Stock、每周比例、直营/JV/Independent及各店的预计Stock、Stock/Ideal、Stock/近三个完整月平均Stock交付（覆盖月数）、待新建Stock落实后的覆盖、Model与Model range数量、每店库存峰值倍数及完整订单/计划转配明细。各组使用同一库存日期，组倍数按库存及分母分别加总后相除，零/缺失分母为N/A；待核到货预留数量、非推荐车型和计划转配数量明确披露。报告以已保存取消、延期和调拨意见落实为前提。来源或意见变化后需重新生成；旧PDF为保存时快照，不自动变成新计算结果。

自动安排只改变Orderdesk排产意见，不写入CRM取消、生产或运输系统。未选中的已签字Customer在后续排产，未选Stock留库存池。补单尚未建单/签字，不计实际订单或已占产能；超库存的候选不设生产日期。已保存安排和来源指纹关联，资料、意见或产能变化会暂缓并要求重新生成。支持撤回，保留最近5次方案；排产计算在独立工作线程执行，健康检查及页面读取可继续响应。

Customer在符合生产周期的候选中优先安排Urgent，再按Request Delivery Date、原排产顺序选择；要求日期变更后需重新生成。

未启用按数量排产时，所有经销商已签字、客户名非空且不以Stock结尾的Towable Customer按排产表顺序入线。Stock须先保存库存调整意见，再从符合条件的补货建议中勾选并确认；保持Stock类型，标记意见版本和预计完工/到店日期，可撤回。SRV/SRM不进入新滚动安排，Traralgon不接收Stock。未签字订单在处理中，客户名为空的处理记录不显示，也不计入列表数量或CSV。原已锁定和实际生产/运输阶段保留。

### 库存调整预测 · 所有 Dealer 库存平衡模拟器

顶部AU月度制造量默认取现有计划，可修改虚拟AU总量；先保留SRM/SRV、当月已过产能、物理阶段及锁定客户车的名额，再按工作日重排现有锁定Stock名额。月度总量低于固定承诺会报错。未用名额保留给滚动排产，不自动扩大Stock总量。锁定线和已签字库存订单池可交换车辆/日期；相同库存目标下优先使用接收Dealer自己的订单，缺少合适本店订单时再Reallocation。被替换的锁定车回到订单池，保留订单和Dealer，不计Cancellation。已指定保留的Stock具有禁止自动取消保护，不再从任何计算/页面中排除。

MY2026/MY2027 Reallocation分别统计IN/OUT，每店标出调整后的MY2026最晚Stock到店日期及日期待核对数量。顶部按每店显示MY2027 SRC/SRP在自然年2027各月的到店柱图（12个月独立于8/14个月库存图），并单列2027年外和日期待核对数量。Excel/PDF包含AU月产量、排产名额变化和年款分组明细；排产交换与商业取消分别列出。保存、确认及产线应用会保留已审核的订单池/锁定线去向和精确AU日期，撤回应用恢复原来源。

「Vehicle allocations and adjustments」和顶部均可下载按Dealer分页的英文PDF。第一页列出当前全部虚拟参数（运输列统一为Transport days）及总Cancellation/Reallocation；后面每家Dealer独立一页，先显示库存连续折线/到店柱图和月度库存表，再显示调整后的MY2027型号覆盖及到店月份矩阵，最后列完整取消、Reallocation调入/调出、其他虚拟日期变动及待核对明细。SRC/SRP按完整型号列明，其他按前三字母汇总。型号矩阵区分已知MY2027店内库存、图表月份到货、范围外到货及待核对供应，不把总供应误作扣减销量后的分型号月底库存。MY2026、未排产库存池和取消车不进入MY2027供应分布。全局Reallocation按车架号只算一次，分别在来源/接收Dealer页展示；长页自动向下加长，不缩小字号或遗漏车辆。

PDF下载使用当前已计算参数，无需先保存；服务端重新核对来源和完整参数的preview token，参数或来源变化时返回409要求重算，不改订单或保存计划。

`/#stock-forecast` 顶部列出所有直营、JV及Independent Dealer，包括缺Ideal或运输数据的门店。可修改虚拟当前Stock、每周Stock交付、Ideal、绝对库存上限、AU下线至到店的总天数、接收状态及适用MY2027型号。默认沿用现有库存/Ideal及出车+运输天数；每周交付按近三个完整月Stock交付总数÷期间天数×7换算。缺少参数显示待补；Traralgon默认沿用暂停状态，可在模拟器里补齐天数并开启接收。

AU下线日期默认现有值；可整体前移/后移，或逐车设置虚拟日期。锁定线/库存池单车日期作为最早可排日期，最终日期按月度产能决定；物理阶段维持虚拟日期优先。修改后自动重新计算到店月份和分配；8/14个月只影响展示范围。调整前和调整后使用相同虚拟参数，比较原Dealer分配与自动平衡后的差异。虚拟库存增加部分不虚构型号/年款；减少虚拟库存时优先保留已知MY2027型号各一台，再保留其他车辆。未标年款的库存不用于确认MY2027覆盖。

先预留店内Stock、固定在途及已排滚动到货，再按虚拟AU下线日期逐辆分配澳洲生产、海运、国内生产和排产锁定线Stock。可在所有组的Dealer之间Reallocation。上限允许的接收店先补尚未覆盖的MY2027适用型号（已有库存、固定在途、已分配供应累计计算，不按月重置），再优先给到店月份预计月底Stock/Ideal最低的店；同等情况下参考交付缺口、展车型号缺口和累计分配比例。每店适用型号默认常态Towable推荐清单，可独立修改。

只有未受禁止取消保护的排产锁定线不推荐车型及MY2027删除车型（SRT18、SRP18F 2 Bunks）可Cancellation。澳洲/海运/国内生产不得取消或自动延期；正常保留车型即使所有门店都无上限空间，也必须保留供应，标明上限冲突。虚拟日期变化只是假设，不记为 operational Delay。缺少到货日期或有效接收设置的供应明确待核对，已知原有到货仍保留。

各Dealer显示Ideal、上限、店内Stock、在途及下线+N天到店。到店数量为柱状图；调整前/后月底Stock为连续折线，Ideal和上限为独立参考线。月度表含到店、卖出、调整前/后库存、Ideal倍数和未满足交付；交付按每周量/7逐日消耗并以实际可用Stock为上限。保留近三个完整月、本月和月均实际Stock交付，另列型号覆盖及逐车到店来源。

下载Excel使用当前成功模拟快照，包含所有Dealer参数、月度库存、逐车分配、MY2027覆盖、实际交付和虚拟下线日期。保存绑定完整参数及来源指纹，防止用旧结果保存新参数或覆盖他人方案；保存后可在产线勾选应用排产交换/Cancellation/Reallocation，实际库存及交付量不会被虚拟值覆盖。默认参数跟随来源刷新，已修改的虚拟值保留。原有意见历史、版本校验及按数量滚动排产入口继续保留。

```bash
npm install
FIREBASE_DATABASE_URL=memory:// LOCAL_DB_FILE=.local-db.json FIREBASE_ROOT=demo node scripts/seed-demo.mjs --force
FIREBASE_DATABASE_URL=memory:// LOCAL_DB_FILE=.local-db.json FIREBASE_ROOT=demo npm run dev:server   # :3000
npm run dev:client                                                                                  # :5173
npm test
```

默认不需要登录：任何人打开网址都以「Planning」身份使用（11-18 起）。要恢复密码，在 Render 环境变量里加 `REQUIRE_PASSWORD=1`，并保留 `APP_PASSWORD`（≥ 8 位）和 `SESSION_SECRET`（≥ 32 位）。Planning 电脑上传用的 `PLANNING_AGENT_TOKEN` 不受影响。
