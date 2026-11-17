import { actionLabel, reasonLabel } from './stock-forecast.mjs';

const title = (zh, cn, en) => zh ? cn : en;
/** Export exactly the scenario currently displayed, without another fetch or recalculation. */
export function forecastExportSheets(report, scope = 'all', zh = true) {
  if (!['own', 'jv', 'all'].includes(scope)) throw new Error('Invalid forecast export scope');
  const groups = scope === 'all' ? ['own', 'jv'] : [scope], sheets = [];
  const metrics = [['cnDelayed', '国内生产车辆延期', 'China-stage vehicles delayed'], ['cnCompletionDelayed', '其中AU完工后移', 'With AU completion postponed'], ['canceled', '取消建议（不含库存池）', 'Cancellations (pool excluded)'], ['lockedCanceled', '其中锁定线取消', 'Locked cancellations'], ['rollingCanceled', '其中滚动线取消', 'Rolling cancellations'], ['poolNotBuilt', '库存池暂不生产', 'Pool not built'], ...(scope === 'jv' ? [] : [['reallocated', 'Reallocation', 'Reallocation']]), ['pending', '待分流/核对', 'Receiving demand / dates unresolved']];
  sheets.push({ name: title(zh, '汇总', 'Summary'), headers: ['Dealer', ...metrics.map(m => title(zh, m[1], m[2]))], rows: groups.flatMap(g => report[g].dealers.map(d => [d.name, ...metrics.map(([k]) => d.stats[k])])) });
  const headers = zh ? ['处理类别', 'Chassis', 'Model', '范围', 'Model year', '阶段', '原Dealer', '接收Dealer', '原AU完工', '建议AU完工', 'AU后移天数', '原到店', '建议到店', '到店变化天数', '建议发车', '同时延期', '同时转配', '推荐车型', '原因'] : ['Action', 'Chassis', 'Model', 'Range', 'Model year', 'Stage', 'Original dealer', 'Receiving dealer', 'Original AU finish', 'Proposed AU finish', 'AU delay days', 'Original arrival', 'Proposed arrival', 'Arrival change days', 'Proposed departure', 'Also delayed', 'Also reallocated', 'Recommended model', 'Reason'];
  const date = d => d ? new Date(d + 'T00:00:00Z') : null, yes = b => title(zh, b ? '是' : '否', b ? 'Yes' : 'No');
  const mapped = list => [...list].sort((a, b) => a.originalDealer.localeCompare(b.originalDealer) || a.chassis.localeCompare(b.chassis)).map(a => [actionLabel(a.action, zh), a.chassis, a.model, a.range, a.modelYear, a.phase, a.originalDealer, a.proposedDealer, date(a.originalAu), date(a.plannedAu), a.delayDays, date(a.originalArrival), date(a.plannedArrival), a.arrivalDelayDays, date(a.depart), yes(a.delayed), yes(a.reallocated), a.policy === 'check' ? title(zh, '待核对', 'Review') : yes(a.policy === 'display'), reasonLabel(a.reason, zh)]);
  for (const group of groups) {
    const prefix = group === 'own' ? title(zh, '直营', 'Own') : 'JV', actions = report[group].actions;
    const sections = [
      [title(zh, '取消', 'Cancel'), actions.filter(a => a.action === 'cancel')],
      [title(zh, '延期', 'Delay'), actions.filter(a => a.delayed)],
      [title(zh, '库存池不生产', 'Pool not built'), actions.filter(a => a.action === 'pool')],
      ...(group === 'own' ? [['Reallocation', actions.filter(a => a.reallocated)]] : []),
      [title(zh, '待分流核对', 'Review'), actions.filter(a => ['pending', 'blocked'].includes(a.action))],
    ];
    for (const [name, list] of sections) sheets.push({ name: `${prefix}-${name}`, headers, rows: mapped(list), dateColumns: [9, 10, 12, 13, 15] });
    sheets.push({ name: `${prefix}-${title(zh, '月度预测', 'Monthly')}`, headers: zh ? ['Dealer', '月份', '原预计到货', '调整后到货', '调出', '原月末库存', '调整后月末库存', '库存上限', '预测销量', '可供交付', '未满足销量'] : ['Dealer', 'Month', 'Original arrivals', 'Adjusted arrivals', 'Transfers out', 'Original closing stock', 'Adjusted closing stock', 'Stock ceiling', 'Expected sales', 'Available handovers', 'Unmet sales'],
      rows: report[group].dealers.flatMap(d => d.monthly.map(m => [d.name, m.month, m.baselineIn, m.stockIn, m.transferOut, m.baselineEndStock, m.endStock, d.cap, m.plannedSales, m.stockOut, m.unmet])) });
  }
  return sheets;
}

export async function buildForecastWorkbook(report, scope = 'all', zh = true) {
  const imported = await import('exceljs'), ExcelJS = imported.default || imported, wb = new ExcelJS.Workbook();
  for (const sheet of forecastExportSheets(report, scope, zh)) {
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow([title(zh, '库存调整预测', 'Stock adjustment forecast')]);
    ws.addRow([`${report.today} · Ideal × ${report.multiplier} · ${title(zh, '最多延期1个自然月；仅Towable Stock；未执行订单变更。', 'Delay ≤ one calendar month; Towable stock only; no order changes executed.')}`]);
    ws.addRow([title(zh, '库存池不计到货和取消。转配并延期会在两张明细表出现，按车架号核对。', 'Pool excluded from arrivals and cancellations. Reallocated-and-delayed vehicles appear in both lists; reconcile by chassis.')]);
    ws.addRow([]); ws.addRow(sheet.headers); sheet.rows.forEach(row => ws.addRow(row));
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3352' } }; ws.getRow(5).height = 30;
    ws.getRow(5).alignment = { wrapText: true, vertical: 'middle' };
    ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, sheet.rows.length + 5), column: sheet.headers.length } };
    ws.views = [{ state: 'frozen', ySplit: 5 }];
    ws.columns.forEach((c, i) => { c.width = i === sheet.headers.length - 1 && sheet.headers.length === 19 ? 75 : i === 2 ? 25 : 20; });
    for (const c of sheet.dateColumns || []) ws.getColumn(c).numFmt = 'dd/mm/yyyy';
    ws.eachRow(r => r.eachCell(c => { c.font = { name: 'Arial', size: 10, ...(c.font || {}) }; }));
  }
  return wb;
}
