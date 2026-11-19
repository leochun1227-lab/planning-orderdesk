import PDFDocument from 'pdfkit';
import { scheduleHeaders, scheduleCells } from '../lib/stock-schedule-view.mjs';
import { buildSimulationReport } from '../lib/stock-simulation-report.mjs';

const W = 1190.55, MIN_H = 841.89, M = 34, CW = W - 2 * M;
const C = { ink: '#18364b', blue: '#1966b3', gray: '#8796aa', muted: '#5d7187', pale: '#eef4fa', grid: '#dce5ef', green: '#24866c', red: '#b95e4c' };
const clean = value => String(value ?? '-').replace(/[\u2010-\u2015\u2212]/g, '-');
const num = value => value == null || !Number.isFinite(value) ? 'N/A' : String(Math.round(value * 100) / 100);
const whole = value => value == null || !Number.isFinite(value) ? '-' : String(Math.round(value));
const sparse = value => value === 0 ? '' : value;
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : '-';
const month = value => { const [y, m] = value.split('-'); return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y.slice(2)}`; };
const group = value => ({ own: 'Self-owned', jv: 'JV', independent: 'Independent' })[value] || value;

/** One overview page and exactly one self-contained, readable page per dealer.
 * Dense dealer pages grow vertically instead of dropping rows or shrinking the type. */
export async function buildSimulationPdf(report, { generatedAt = new Date().toISOString() } = {}) {
  const model = buildSimulationReport(report);
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, bufferPages: true, compress: true,
    info: { Title: 'Vehicle allocations and adjustments', Author: 'Regent RV Planning', Subject: `Dealer inventory simulation ${report.today}` } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => { doc.on('data', part => chunks.push(part)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  // Font measurement needs a page context. This becomes the overview, not an extra page.
  doc.addPage({ size: [W, MIN_H], margin: 0 });
  const font = (bold = false, size = 9.5) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  const measure = (value, width, bold = false, size = 9.5) => { font(bold, size); return doc.heightOfString(clean(value), { width, lineGap: 0, characterSpacing: 0, wordSpacing: 0 }); };
  function write(value, x, y, width, { bold = false, size = 9.5, color = C.ink, height, align = 'left' } = {}) {
    font(bold, size).fillColor(color).text(clean(value), x, y, { width, ...(height ? { height } : {}), align, lineGap: 0, characterSpacing: 0, wordSpacing: 0 });
  }
  function paragraph(value, color = C.muted) {
    const height = measure(value, CW, false, 9.5) + 14;
    return { height, draw: y => write(value, M, y + 3, CW, { size: 9.5, color }) };
  }
  function table(title, headers, rows, weights, size = 9.2, redRows = []) {
    const proportions = weights || headers.map(() => 1), sum = proportions.reduce((n, v) => n + v, 0), widths = proportions.map(v => CW * v / sum);
    const values = (rows.length ? rows : [headers.map((_, i) => i ? '-' : 'None')]).map(row => row.map(v => v == null ? '-' : clean(v)));
    const rowHeight = (row, bold) => Math.max(bold ? 30 : 21, ...row.map((v, i) => measure(v, widths[i] - 12, bold, size) + 12));
    const headerH = rowHeight(headers, true), heights = values.map(row => rowHeight(row, false));
    const height = 29 + headerH + heights.reduce((n, h) => n + h, 0) + 15;
    return { height, draw: start => {
      write(title, M, start + 4, CW, { bold: true, size: 12 });
      let y = start + 29;
      function row(cells, h, bold, index = 0) {
        doc.rect(M, y, CW, h).fill(bold ? C.ink : redRows[index] ? '#fff0f0' : index % 2 ? '#f1f5f9' : '#ffffff');
        let x = M;
        cells.forEach((cell, i) => { write(cell, x + 6, y + 6, widths[i] - 12, { bold, size, color: bold ? '#ffffff' : redRows[index] ? '#b42318' : C.ink, height: h - 10 }); x += widths[i]; });
        doc.moveTo(M, y + h).lineTo(W - M, y + h).lineWidth(.4).strokeColor(C.grid).stroke();
        y += h;
      }
      row(headers, headerH, true); values.forEach((cells, i) => row(cells, heights[i], false, i));
    } };
  }
  function chart(d) {
    return { height: 234, draw: top => {
      write('Dealer monthly inventory and model coverage', M, top + 4, CW, { bold: true, size: 13 });
      const legend = [['Stock arrivals', '#a7cdf4'], ['Closing Stock before', C.gray], ['Closing Stock after', C.blue], ['Ideal', C.green], ['Stock ceiling', C.red]];
      legend.forEach(([label, color], i) => { const x = M + i * 207; doc.rect(x, top + 30, 15, 3).fill(color); write(label, x + 22, top + 26, 180, { size: 9, color: C.muted }); });
      const left = M + 43, right = W - M - 15, plotTop = top + 55, plotH = 146, step = (right - left) / Math.max(1, d.monthly.length);
      const high = Math.max(1, d.target || 0, d.cap || 0, ...d.monthly.flatMap(m => [m.stockIn || 0, m.endStock || 0, m.baselineEndStock || 0]));
      const maximum = Math.ceil(high / 5) * 5, x = i => left + (i + .5) * step, y = v => plotTop + plotH * (1 - (v || 0) / maximum);
      for (const f of [0, .25, .5, .75, 1]) { doc.moveTo(left, y(maximum * f)).lineTo(right, y(maximum * f)).lineWidth(.4).strokeColor(C.grid).stroke(); write(num(maximum * f), M, y(maximum * f) - 4, 35, { size: 8.5, color: C.muted, align: 'right' }); }
      for (const [value, color] of [[d.target, C.green], [d.cap, C.red]]) if (value != null) doc.save().dash(5, { space: 4 }).moveTo(left, y(value)).lineTo(right, y(value)).lineWidth(1).strokeColor(color).stroke().restore();
      d.monthly.forEach((m, i) => { const h = plotH * (m.stockIn || 0) / maximum; if (h) doc.rect(x(i) - step * .17, y(m.stockIn), step * .34, h).fill('#a7cdf4'); if (m.stockIn) write(num(m.stockIn), x(i) - 22, y(m.stockIn) - 12, 44, { size: 8.5, color: C.blue, align: 'center' }); write(month(m.month), x(i) - 34, plotTop + plotH + 9, 68, { size: 9, color: C.muted, align: 'center' }); });
      for (const [field, color] of [['baselineEndStock', C.gray], ['endStock', C.blue]]) {
        let connected = false;
        d.monthly.forEach((m, i) => { if (m[field] == null) { if (connected) doc.lineWidth(1.8).strokeColor(color).stroke(); connected = false; return; } if (!connected) doc.moveTo(x(i), y(m[field])); else doc.lineTo(x(i), y(m[field])); connected = true; });
        if (connected) doc.lineWidth(1.8).strokeColor(color).stroke();
        d.monthly.forEach((m, i) => { if (m[field] != null) doc.circle(x(i), y(m[field]), 2.4).fill(color); });
      }
    } };
  }
  function page(blocks, title, index, first = false) {
    const height = Math.max(MIN_H, M * 2 + 24 + blocks.reduce((n, b) => n + b.height, 0));
    if (first) { doc.page.height = height; doc.page.dictionary.data.MediaBox = [0, 0, W, height]; if (height !== MIN_H) doc.translate(0, MIN_H - height); }
    else doc.addPage({ size: [W, height], margin: 0 });
    let y = M;
    for (const block of blocks) { block.draw(y); y += block.height; }
    doc.moveTo(M, height - 38).lineTo(W - M, height - 38).lineWidth(.5).strokeColor(C.grid).stroke();
    write(`Regent RV | ${title} | Simulation ${report.today}`, M, height - 27, CW - 130, { size: 8, color: C.muted });
    write(`${index + 1} / ${model.dealers.length + 1}`, W - M - 110, height - 27, 110, { size: 8, color: C.muted, align: 'right' });
  }
  const assumptionRows = model.dealers.map(d => {
    const s = model.assumptions.dealers.find(s => s.slug === d.slug);
    return [d.name, whole(s.currentStock), num(s.weeklyStock), whole(s.ideal), whole(s.cap), d.latestMY2026Arrival ? date(d.latestMY2026Arrival) : '-', d.srh2026Count || '', d.summary.cancellations || '', d.summary.reallocationIn || '', d.summary.reallocationOut || ''];
  });
  const cover = [
    { height: 52, draw: y => { write('DEALER STOCK PLAN', M, y, CW, { bold: true, size: 24 }); write(`REGENT RV  |  ${report.today}`, M, y + 32, CW, { size: 10, color: C.muted }); } },
    { height: 55, draw: y => { doc.roundedRect(M, y, CW, 43, 4).fill(C.pale); write(`Cancellation ${model.totals.cancellations}     Reallocation ${model.totals.reallocations}     SRH MY2026 ${model.srh2026Count}`, M + 14, y + 14, CW - 28, { bold: true, size: 14 }); } },
    paragraph(`Last locked AU finish: ${date(model.finalPlan.boundary)}. Next Stock plans use the remaining AU production places. SRH MY2026 stays with its original dealer and is shown in red.`),
    ...(report.auProduction ? [table('AU production', ['Month', 'Towable production', 'Stock plan'], report.auProduction.months.map(m => [m.month, m.towable, (report.finalSchedule?.monthly || []).find(x => x.month === m.month)?.quantity || '']), [1, 1, 1])] : []),
    table('Dealer summary', ['Dealer', 'Stock', 'Weekly sales', 'Ideal', 'Limit', 'Last MY2026 arrival', 'SRH MY2026', 'Cancel', 'IN', 'OUT'], assumptionRows, [2.5, .8, 1, .8, .8, 1.6, 1.1, .8, .7, .7]),
  ];
  page(cover, 'Dealer summary', 0, true);
  for (let i = 0; i < model.dealers.length; i++) {
    const d = model.dealers[i], blocks = [
      { height: 48, draw: y => { write(d.name, M, y, CW, { bold: true, size: 23 }); write(`Ideal ${whole(d.target)}  |  Limit ${whole(d.cap)}  |  Stock ${whole(d.yard.stock)}  |  In transit ${whole(d.transit.stock)}  |  SRH MY2026 ${d.srh2026Count}`, M, y + 31, CW, { size: 10, color: C.muted }); } },
      chart(d),
      table('Monthly stock - locked adjustments', ['Stock', ...d.monthly.map(m => month(m.month))], [
        ['Arrivals', ...d.monthly.map(m => whole(m.stockIn))], ['Sold', ...d.monthly.map(m => whole(m.stockOut))], ['Before', ...d.monthly.map(m => whole(m.baselineEndStock))], ['After', ...d.monthly.map(m => whole(m.endStock))], ['% of Ideal', ...d.monthly.map(m => m.idealMultiple == null ? '-' : `${Math.round(m.idealMultiple * 100)}%`)],
      ], [2, ...d.monthly.map(() => 1)]),
    ];
    const matrixHeaders = ['Model', 'In stock', ...d.distributionMonths.map(month), ...(d.showLater ? ['Later'] : []), 'Total', 'Missing'];
    const matrixRows = d.distribution.map(r => [r.label, sparse(r.yard), ...d.distributionMonths.map(m => sparse(r.arrivals[m])), ...(d.showLater ? [sparse(r.later)] : []), sparse(r.total), sparse(r.missing)]);
    blocks.push(table('MY2027 models and arrival months - locked plan', matrixHeaders, matrixRows, [2.8, ...matrixHeaders.slice(1).map(() => 1)], report.months > 8 ? 8.5 : 9.2));
    blocks.push(paragraph(`MY2027 model coverage ${d.coverage.covered} / ${d.coverage.target}. SRC / SRP show exact models; other models show their range.`));
    blocks.push(table('Stock plan and Reallocation', scheduleHeaders.filter((_, i) => i !== 6), d.planRows.map(a => { const cells = scheduleCells(a); cells[0] = date(a.auFinish); return cells.filter((_, i) => i !== 6); }), [1.1, 1.2, 1.6, .65, 1.6, 1, .9, 1.6, 1.6], 9.2, d.planRows.map(a => a.srh2026)));
    if (d.cancellations.length) blocks.push(table('Cancellation', ['Chassis', 'Model', 'MY'], d.cancellations.map(a => [a.chassis, a.model, a.modelYear]), [1.2, 2, 1]));
    blocks.push(paragraph(`Cancellation ${d.summary.cancellations}  |  Reallocation IN ${d.summary.reallocationIn} / OUT ${d.summary.reallocationOut}  |  SRH MY2026 ${d.srh2026Count}`));
    page(blocks, d.name, i + 1);
  }
  doc.end(); return complete;
}
