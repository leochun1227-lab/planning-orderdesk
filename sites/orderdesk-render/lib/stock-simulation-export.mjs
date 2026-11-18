const groups = ['own', 'jv', 'independent'];
const text = (zh, cn, en) => zh ? cn : en;
/** Uses the displayed snapshot, with its assumptions and all cross-group reallocations. */
export function simulationExportSheets(report, zh = true) {
  const dealers = groups.flatMap(group => report[group].dealers.map(d => ({ ...d, group }))), actions = groups.flatMap(g => report[g].actions);
  const sources = new Map(report.defaults.map(d => [d.slug, d]));
  return [
    { name: text(zh, '模拟参数', 'Assumptions'), headers: ['Dealer', 'Group', text(zh, '现有Stock', 'Source Stock'), text(zh, '虚拟Stock', 'Virtual Stock'), text(zh, '默认每周交付', 'Default weekly handovers'), text(zh, '虚拟每周交付', 'Virtual weekly handovers'), 'Ideal', text(zh, '上限', 'Ceiling'), 'Transport days', text(zh, '接收新分配', 'Receive allocations'), text(zh, '适用MY2027型号', 'Applicable MY2027 models'), text(zh, '整体下线偏移天数', 'Overall finish shift days')],
      rows: dealers.map(d => { const s = report.assumptions.dealers.find(s => s.slug === d.slug); return [d.name, d.group, sources.get(d.slug)?.currentStock, s.currentStock, sources.get(d.slug)?.weeklyStock, s.weeklyStock, s.ideal, s.cap, s.leadDays, s.receiving ? 'Yes' : 'No', s.models.join(', '), report.assumptions.shiftDays]; }) },
    { name: text(zh, '月度库存', 'Monthly inventory'), headers: ['Dealer', 'Group', text(zh, '月份', 'Month'), text(zh, '到店Stock', 'Stock arrivals'), text(zh, '卖出Stock', 'Stock sold'), text(zh, '调整前月底Stock', 'Closing Stock before'), text(zh, '调整后月底Stock', 'Closing Stock after'), 'Ideal', text(zh, '上限', 'Ceiling'), 'Stock / Ideal', text(zh, '预期交付', 'Expected handovers'), text(zh, '未满足交付', 'Unmet handovers')],
      rows: dealers.flatMap(d => d.monthly.map(m => [d.name, d.group, m.month, m.stockIn, m.stockOut, m.baselineEndStock, m.endStock, d.target, d.cap, m.idealMultiple, m.plannedSales, m.unmet])) },
    { name: text(zh, '逐车分配', 'Vehicle allocations'), headers: ['Chassis', 'Model', 'MY', text(zh, '阶段', 'Stage'), text(zh, '处理', 'Action'), text(zh, '原Dealer', 'Original dealer'), text(zh, '接收Dealer', 'Receiving dealer'), text(zh, '原AU下线', 'Source AU finish'), text(zh, '虚拟AU下线', 'Virtual AU finish'), text(zh, '原到店', 'Source arrival'), text(zh, '模拟到店', 'Simulated arrival'), text(zh, '依据', 'Reason'), text(zh, '超上限冲突', 'Ceiling conflict'), text(zh, '新增型号覆盖', 'Adds model coverage')],
      rows: actions.map(a => [a.chassis, a.model, a.modelYear, a.group, a.action, a.originalDealer, a.proposedDealer, a.originalAu, a.simulatedAu, a.originalArrival, a.plannedArrival, a.reason, a.limitConflict ? 'Yes' : 'No', a.coverageAdded ? 'Yes' : 'No']) },
    { name: text(zh, 'MY2027覆盖', 'MY2027 coverage'), headers: ['Dealer', 'Group', text(zh, '目标型号数', 'Target model count'), text(zh, '已覆盖型号数', 'Covered model count'), text(zh, '已覆盖型号', 'Covered models'), text(zh, '缺少型号', 'Missing models'), text(zh, '型号年款待核对库存', 'Unclassified virtual yard Stock')],
      rows: dealers.map(d => [d.name, d.group, d.coverage.target, d.coverage.covered, d.coverage.models.join(', '), d.coverage.missing.join(', '), d.unknownYardModels]) },
    { name: text(zh, '实际交付核对', 'Actual handovers'), headers: ['Dealer', text(zh, '月份', 'Month'), text(zh, '实际Stock交付', 'Actual Stock handovers'), text(zh, '近三月月均', 'Three-month monthly average'), text(zh, '虚拟每周交付', 'Virtual weekly handovers')],
      rows: dealers.flatMap(d => [...d.handover.months.map(m => [d.name, m.month, m.stock, d.handover.avgStock, d.weeklyStock]), [d.name, `${report.today.slice(0, 7)} MTD`, d.handover.thisMonth.stock, d.handover.avgStock, d.weeklyStock]]) },
    { name: text(zh, '虚拟下线日期', 'Virtual AU dates'), headers: ['Chassis', 'Model', 'MY', 'Dealer', text(zh, '阶段', 'Stage'), text(zh, '原AU下线', 'Source AU finish'), text(zh, '虚拟AU下线', 'Virtual AU finish')], rows: report.finishRows.map(r => [r.chassis, r.model, r.modelYear, r.dealer, r.group, r.originalAu, r.simulatedAu]) },
  ];
}
export async function buildSimulationWorkbook(report, zh = true) {
  const imported = await import('exceljs'), ExcelJS = imported.default || imported, wb = new ExcelJS.Workbook();
  for (const sheet of simulationExportSheets(report, zh)) {
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow([text(zh, 'Dealer 库存平衡模拟器', 'Dealer inventory balancing simulator')]);
    ws.addRow([`${report.today} · ${text(zh, '同一虚拟假设比较调整前后；MY2027型号覆盖累计一次。', 'Before/after use the same assumptions; MY2027 model coverage is cumulative.')}`]);
    ws.addRow([text(zh, '仅锁定线不推荐/删除车型可取消；其他正常车型保留。', 'Only locked not-on-yard / deleted models may be cancelled; retained models are preserved.')]);
    ws.addRow([]); ws.addRow(sheet.headers); sheet.rows.forEach(row => ws.addRow(row));
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(5).height = 34;
    ws.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3352' } }; ws.getRow(5).alignment = { wrapText: true, vertical: 'middle' };
    ws.columns.forEach(c => { c.width = 23; }); ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];
    ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: sheet.rows.length + 5, column: sheet.headers.length } };
    ws.eachRow(r => r.eachCell(c => { c.font = { name: 'Arial', size: 11, ...(c.font || {}) }; }));
  }
  return wb;
}
