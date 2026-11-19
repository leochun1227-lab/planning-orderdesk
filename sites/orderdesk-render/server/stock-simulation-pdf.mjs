import PDFDocument from 'pdfkit';
import { buildSimulationReport, reportReason, reportStage } from '../lib/stock-simulation-report.mjs';

const W = 1190.55, MIN_H = 841.89, M = 34, CW = W - 2 * M;
const C = { ink: '#18364b', blue: '#1966b3', gray: '#8796aa', muted: '#5d7187', pale: '#eef4fa', grid: '#dce5ef', green: '#24866c', red: '#b95e4c' };
const clean = value => String(value ?? '-').replace(/[\u2010-\u2015\u2212]/g, '-');
const num = value => value == null || !Number.isFinite(value) ? 'N/A' : String(Math.round(value * 100) / 100);
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
  function table(title, headers, rows, weights, size = 9.2) {
    const proportions = weights || headers.map(() => 1), sum = proportions.reduce((n, v) => n + v, 0), widths = proportions.map(v => CW * v / sum);
    const values = (rows.length ? rows : [headers.map((_, i) => i ? '-' : 'None')]).map(row => row.map(v => v === '' || v == null ? '-' : clean(v)));
    const rowHeight = (row, bold) => Math.max(bold ? 30 : 21, ...row.map((v, i) => measure(v, widths[i] - 12, bold, size) + 12));
    const headerH = rowHeight(headers, true), heights = values.map(row => rowHeight(row, false));
    const height = 29 + headerH + heights.reduce((n, h) => n + h, 0) + 15;
    return { height, draw: start => {
      write(title, M, start + 4, CW, { bold: true, size: 12 });
      let y = start + 29;
      function row(cells, h, bold, index = 0) {
        doc.rect(M, y, CW, h).fill(bold ? C.ink : index % 2 ? '#f1f5f9' : '#ffffff');
        let x = M;
        cells.forEach((cell, i) => { write(cell, x + 6, y + 6, widths[i] - 12, { bold, size, color: bold ? '#ffffff' : C.ink, height: h - 10 }); x += widths[i]; });
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
  function srcSrpChart(d) {
    return { height: 192, draw: top => {
      const s = d.my2027SrcSrpArrivals, list = s.months, maximum = Math.max(1, ...list.flatMap(m => [m.src, m.srp]));
      write('MY2027 SRC / SRP Stock - 2027 arrival months', M, top + 3, CW, { bold: true, size: 13 });
      write(`SRC ${list.reduce((n, m) => n + m.src, 0)}   |   SRP ${list.reduce((n, m) => n + m.srp, 0)}   |   ${s.outsideYear} outside 2027   |   ${s.unresolved} unresolved`, M, top + 24, CW, { size: 9, color: C.muted });
      const left = M + 35, step = (CW - 45) / 12, bottom = top + 160, scale = 108 / maximum;
      for (const fraction of [0, .5, 1]) { const y = bottom - maximum * fraction * scale; doc.moveTo(left, y).lineTo(W - M, y).lineWidth(.4).strokeColor(C.grid).stroke(); write(num(maximum * fraction), M, y - 4, 28, { align: 'right', size: 8 }); }
      list.forEach((m, i) => { const x = left + i * step + step * .2; for (const [n, color, dx] of [[m.src, C.blue, 0], [m.srp, '#dd8b38', step * .24]]) { if (n) { doc.rect(x + dx, bottom - n * scale, step * .2, n * scale).fill(color); write(n, x + dx - 4, bottom - n * scale - 12, step * .2 + 8, { size: 8.5, align: 'center', color }); } } write(m.month.slice(5), left + i * step, bottom + 9, step, { size: 8.5, align: 'center' }); });
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
    const s = model.assumptions.dealers.find(s => s.slug === d.slug), original = report.defaults?.find(s => s.slug === d.slug);
    return [d.name, group(d.group), num(original?.currentStock ?? d.actualYardStock), num(s.currentStock), num(s.weeklyStock), num(s.ideal), num(s.cap), num(s.leadDays), s.receiving ? 'Yes' : 'No', s.models.length, d.summary.cancellations, d.summary.reallocationIn, d.summary.reallocationOut];
  });
  const cover = [
    { height: 52, draw: y => { write('VEHICLE ALLOCATIONS AND ADJUSTMENTS', M, y, CW, { bold: true, size: 24 }); write(`REGENT RV  |  ${report.today}  |  ${report.months}-month chart  |  Generated ${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' }).format(new Date(generatedAt))} Sydney`, M, y + 32, CW, { size: 10, color: C.muted }); } },
    { height: 55, draw: y => { doc.roundedRect(M, y, CW, 43, 4).fill(C.pale); write(`TOTAL CANCELLATIONS   ${model.totals.cancellations}       TOTAL REALLOCATIONS   ${model.totals.reallocations}       DEALERS   ${model.totals.dealers}`, M + 14, y + 14, CW - 28, { bold: true, size: 14 }); } },
    paragraph(`MY2026 Reallocations ${model.totals.reallocationsByMY['2026']} | MY2027 Reallocations ${model.totals.reallocationsByMY['2027']} | Other / unknown MY ${model.totals.reallocationsByMY.other}.`),
    paragraph(`Reallocations count unique chassis once across all dealers. Incoming and outgoing appearances describe the same transfer. Global virtual AU finish shift: ${report.assumptions.shiftDays} days. First locked Stock AU finish: ${date(report.startLocked)}.`),
    table('All dealers - editable assumptions', ['Dealer', 'Group', 'Source\nStock', 'Virtual\nStock', 'Weekly Stock\nhandovers', 'Ideal', 'Stock\nceiling', 'Transport\ndays', 'Receive', 'MY2027\nmodels', 'Cancel', 'Realloc.\nIN', 'Realloc.\nOUT'], assumptionRows, [2.3, 1.1, .8, .8, 1.1, .7, .8, .9, .7, .9, .7, .8, .8]),
    table('Stock by model year - reallocations and final MY2026 arrival', ['Dealer', 'Last MY2026 arrival', 'MY2026 unresolved', 'MY2026 IN', 'MY2026 OUT', 'MY2027 IN', 'MY2027 OUT'], model.dealers.map(d => [d.name, d.latestMY2026Arrival ? date(d.latestMY2026Arrival) : d.pendingMY2026Arrivals ? 'Review' : 'No inbound', d.pendingMY2026Arrivals, d.reallocationByMY['2026'].incoming, d.reallocationByMY['2026'].outgoing, d.reallocationByMY['2027'].incoming, d.reallocationByMY['2027'].outgoing]), [2.5, 1.6, 1.2, 1, 1, 1, 1]),
    paragraph('Transport days = total days from AU finish to the dealer, including dispatch and transit. Weekly Stock handovers are editable simulation assumptions. Each following page contains one dealer; long pages expand vertically so all vehicle details remain readable.'),
    paragraph('The report uses the current calculated simulation, including unsaved virtual assumptions. It does not execute commercial cancellations, stock movements or transport instructions. MY2027 coverage is cumulative, not a fresh one-per-model target each month.'),
  ];
  if (report.auProduction) cover.splice(4, 0,
    paragraph(`Stock slot exchange ${report.assumptions.exchangeSlots ? 'enabled' : 'disabled'}. ${report.totals.scheduledFromPool} orders admitted from pool; ${report.totals.returnedToPool} locked orders returned to pool without Cancellation; ${report.totals.rescheduled} schedule changes. Existing locked Stock places are repacked; later capacity remains for rolling production.`),
    table('AU monthly production - editable simulation assumptions', ['AU month', 'Source total', 'Simulated total', 'SRM', 'SRV', 'Towable', 'Fixed / elapsed', 'Stock scheduled', 'Remaining slots'], report.auProduction.months.map(m => [m.month, m.sourceTotal, m.total, m.srm, m.srv, m.towable, `${m.fixedTowable} / ${m.elapsedTowable}`, m.plannedStock, m.unfilled]), [1.2, 1, 1, .7, .7, 1, 1.4, 1.2, 1.2]));
  if (Object.entries(report.sources || {}).some(([, s]) => s.error && s.configured !== false)) cover.push(paragraph('Some sources could not refresh. The simulation uses the available source copies; review source dates before implementing changes.', C.red));
  page(cover, 'All dealer assumptions', 0, true);
  for (let i = 0; i < model.dealers.length; i++) {
    const d = model.dealers[i], blocks = [
      { height: 48, draw: y => { write(d.name, M, y, CW, { bold: true, size: 23 }); write(`${group(d.group)}  |  Ideal ${num(d.target)}  |  Ceiling ${num(d.cap)}  |  Yard Stock ${num(d.yard.stock)}  |  Transit ${num(d.transit.stock)}  |  Transport days ${num(d.lead)}  |  Weekly Stock handovers ${num(d.weeklyStock)}`, M, y + 31, CW, { size: 10, color: C.muted }); } },
      paragraph(`Cancellations ${d.summary.cancellations}   |   Reallocation IN ${d.summary.reallocationIn}   |   Reallocation OUT ${d.summary.reallocationOut}   |   MY2027 applicable models covered ${d.coverage.covered} / ${d.coverage.target}   |   Above ceiling ${d.overCapMonths} months   |   Unmet handovers ${d.shortageMonths} months`),
      paragraph(`Last MY2026 Stock arrival: ${d.latestMY2026Arrival ? date(d.latestMY2026Arrival) : d.pendingMY2026Arrivals ? 'Review required' : 'No inbound'}. ${d.pendingMY2026Arrivals} MY2026 arrivals unresolved. MY2026 Reallocation IN ${d.reallocationByMY['2026'].incoming} / OUT ${d.reallocationByMY['2026'].outgoing}; MY2027 IN ${d.reallocationByMY['2027'].incoming} / OUT ${d.reallocationByMY['2027'].outgoing}.`),
      srcSrpChart(d),
      chart(d),
      table('Monthly inventory after adjustments', ['Metric', ...d.monthly.map(m => month(m.month))], [
        ['Stock arrivals', ...d.monthly.map(m => num(m.stockIn))], ['Stock sold', ...d.monthly.map(m => num(m.stockOut))], ['Closing Stock before', ...d.monthly.map(m => num(m.baselineEndStock))], ['Closing Stock after', ...d.monthly.map(m => num(m.endStock))], ['Stock / Ideal', ...d.monthly.map(m => m.idealMultiple == null ? 'N/A' : `${num(m.idealMultiple)}x`)], ['Unmet handovers', ...d.monthly.map(m => num(m.unmet))],
      ], [2.4, ...d.monthly.map(() => 1)]),
      table('Actual Stock handovers - source data for checking the weekly assumption', ['Last completed months', ...d.handover.months.map(m => month(m.month)), 'Current month', 'Monthly average', 'Virtual weekly'], [['Stock handovers', ...d.handover.months.map(m => m.stock), d.handover.thisMonth.stock, num(d.handover.avgStock), num(d.weeklyStock)]], [2, ...d.handover.months.map(() => 1), 1, 1, 1]),
    ];
    if (d.settingsNeeded || d.undatedIncoming || d.stopReceiving) blocks.push(paragraph([d.settingsNeeded ? 'Missing Ideal, ceiling or transport days: new allocations are held.' : '', d.stopReceiving ? 'Receiving new allocations is paused; existing inbound remains visible.' : '', d.undatedIncoming ? `${d.undatedIncoming} inbound assignments need date / destination review.` : ''].filter(Boolean).join(' '), C.red));
    const matrixHeaders = ['Model / range', 'Target\nmodels', 'Covered\nmodels', 'MY2027\nyard', ...d.distributionMonths.map(month), ...(d.showLater ? ['Outside\nchart'] : []), ...(d.showReview ? ['Supply\nreview'] : []), 'Total\nunits', 'Missing\nmodels'];
    const matrixRows = d.distribution.map(r => [r.label, r.target, r.covered, r.yard, ...d.distributionMonths.map(m => r.arrivals[m]), ...(d.showLater ? [r.later] : []), ...(d.showReview ? [r.review] : []), r.total, r.missing]);
    matrixRows.push(['TOTAL', ...Array.from({ length: matrixHeaders.length - 1 }, (_, n) => matrixRows.reduce((sum, row) => sum + Number(row[n + 1] || 0), 0))]);
    blocks.push(table('MY2027 model coverage - adjusted stock and arrival-month distribution', matrixHeaders, matrixRows, [2.8, ...matrixHeaders.slice(1).map(() => 1)], report.months > 8 ? 8.5 : 9.2));
    blocks.push(paragraph(`SRC and SRP are detailed by exact model; all other models are grouped by their first three letters. Yard and arrival-month columns count retained MY2027 supply, not model-level closing inventory after sales. Target / covered / missing columns count distinct applicable models. Cancelled and unscheduled pool vehicles are excluded.${d.unknownYardModels ? ` ${d.unknownYardModels} virtual or unclassified yard units cannot confirm MY2027 coverage.` : ''}`));
    if (d.scheduleChanges.length) blocks.push(table(`Stock production slot changes (${d.scheduleChanges.length}) - pool returns are not cancellations`, ['Chassis', 'Model / MY', 'Source stage', 'Planned stage', 'Source AU', 'Planned AU', 'Dealer arrival', 'Reallocation', 'Protected'], d.scheduleChanges.map(a => [a.chassis, `${a.model} / ${a.modelYear || '-'}`, reportStage(a.group), reportStage(a.plannedGroup), date(a.originalAu), date(a.plannedAu), date(a.plannedArrival), a.reallocated ? 'Yes' : 'No', a.cancellationProtected ? 'Yes' : 'No']), [1.2, 1.8, 1, 1, 1, 1, 1, .9, .8]));
    blocks.push(table(`Cancellations (${d.summary.cancellations})`, ['Chassis', 'Model / MY', 'Stage', 'Original AU finish', 'Original arrival', 'Reason'], d.cancellations.map(a => [a.chassis, `${a.model} / ${a.modelYear || '-'}`, reportStage(a.group), date(a.originalAu), date(a.originalArrival), reportReason(a.reason)]), [1.3, 1.7, 1, 1.1, 1.1, 2]));
    for (const cohort of d.reallocationGroups) {
      if (cohort.year === 'other' && !cohort.incoming.length && !cohort.outgoing.length) continue;
      for (const [label, rows, counterpart] of [['IN', cohort.incoming, 'Original dealer'], ['OUT', cohort.outgoing, 'Receiving dealer']]) {
      blocks.push(table(`${cohort.year === 'other' ? 'Other / unknown MY' : `MY${cohort.year}`} Reallocation ${label} (${rows.length})`, ['Chassis', 'Model / MY', 'Stage', counterpart, 'Original AU', 'Virtual AU', 'Dealer arrival', 'Reason'], rows.map(a => [a.chassis, `${a.model} / ${a.modelYear || '-'}`, reportStage(a.group), label === 'IN' ? a.originalDealer : a.proposedDealer, date(a.originalAu), date(a.simulatedAu || a.plannedAu), date(a.plannedArrival), reportReason(a.reason)]), [1.1, 1.6, 1, 1.6, 1, 1, 1, 1.8]));
    }
    }
    if (d.dateChanges.length) blocks.push(table(`Other virtual date changes (${d.dateChanges.length})`, ['Chassis', 'Model / MY', 'Stage', 'Original AU', 'Virtual AU', 'Original arrival', 'Simulated arrival'], d.dateChanges.map(a => [a.chassis, `${a.model} / ${a.modelYear || '-'}`, reportStage(a.group), date(a.originalAu), date(a.simulatedAu), date(a.originalArrival), date(a.plannedArrival)])));
    if (d.review.length) blocks.push(table(`Assignments requiring review (${d.review.length})`, ['Chassis', 'Model / MY', 'Stage', 'Original dealer', 'Planned dealer', 'AU finish', 'Reason'], d.review.map(a => [a.chassis, `${a.model} / ${a.modelYear || '-'}`, reportStage(a.group), a.originalDealer, a.proposedDealer || '-', date(a.simulatedAu), reportReason(a.reason)]), [1.2, 1.5, 1, 1.5, 1.5, 1, 2]));
    blocks.push(paragraph(`Dealer totals: ${d.summary.cancellations} cancellations; ${d.summary.reallocationIn} reallocations in; ${d.summary.reallocationOut} reallocations out. All-dealer totals: ${model.totals.cancellations} cancellations; ${model.totals.reallocations} unique reallocations. Transfers shown on two dealer pages count once in the global total.`));
    page(blocks, d.name, i + 1);
  }
  doc.end(); return complete;
}
