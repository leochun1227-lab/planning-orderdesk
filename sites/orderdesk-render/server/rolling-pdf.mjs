import PDFDocument from 'pdfkit';
const number = v => v == null || !Number.isFinite(v) ? 'N/A' : v.toFixed(2);
const pct = v => v == null ? 'N/A' : `${(v * 100).toFixed(1)}%`;
const groupName = g => ({ own: 'Self-owned', jv: 'JV', independent: 'Independent' })[g] || g;
const reasonName = r => ({ duplicateOrPhysical: 'Duplicate / already physical', inactive: 'Cancelled / completed', unsigned: 'Signed plans not received', deliveryDate: 'Delivery date needs review', notReady: 'Not ready within rolling horizon', quantityOrMix: 'Waiting for quantity / weekly mix' })[r] || r;
export async function buildRollingPdf(p) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 34, bufferPages: true,
    info: { Title: 'Rolling Production Report - Regent RV', Author: 'Regent RV Planning' } });
  const chunks = [], complete = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = doc.page.width - 68, bottom = doc.page.height - 62;
  let y = 34;
  const newPage = () => { doc.addPage(); y = 34; };
  function paragraph(text, size = 9) {
    doc.font('Helvetica').fontSize(size); const height = doc.heightOfString(text, { width });
    if (y + height > bottom) newPage();
    doc.fillColor('#475569').text(text, 34, y, { width }); y += height + 9;
  }
  function heading(text) {
    if (y + 55 > bottom) newPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#18364b').text(text, 34, y, { width }); y += 25;
  }
  function table(title, headers, rows, proportions) {
    heading(title);
    const widths = (proportions || headers.map(() => 1)).map(n => width * n / (proportions || headers.map(() => 1)).reduce((a, b) => a + b, 0));
    function draw(row, header = false, index = 0) {
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const values = row.map(v => v == null || v === '' ? '-' : String(v));
      const height = Math.max(24, ...values.map((v, i) => doc.heightOfString(v, { width: widths[i] - 10 }) + 12));
      if (y + height > bottom) { newPage(); doc.font('Helvetica-Bold').fontSize(10).fillColor('#18364b').text(`${title} (continued)`, 34, y); y += 23; if (!header) draw(headers, true); }
      let x = 34;
      doc.save().rect(x, y, width, height).fill(header ? '#18364b' : index % 2 ? '#f1f5f9' : '#ffffff').restore();
      values.forEach((v, i) => { doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(header ? '#ffffff' : '#172b3a').text(v, x + 5, y + 6, { width: widths[i] - 10 }); x += widths[i]; });
      y += height;
    }
    draw(headers, true); (rows.length ? rows : [headers.map((_, i) => i ? '-' : 'None')]).forEach((r, i) => draw(r, false, i)); y += 16;
  }
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#18364b').text('ROLLING PRODUCTION REPORT', 34, y); y += 34;
  paragraph(`REGENT RV   |   Saved ${p.createdAt.slice(0, 19).replace('T', ' ')} UTC   |   Proposal ${p.id}`, 9);
  paragraph(`Target ${p.quantity} units  |  Weekly Customer ${p.customerPercent}% / Stock ${100 - p.customerPercent}%  |  Requested delivery date <= AU finish date`, 11);
  table('Production result', ['Target', 'Real orders', 'Customer', 'Dealer Stock', 'New Stock needed', 'Unfilled actual', 'Inventory / settings hold', 'Capacity gap'],
    [[p.quantity, p.scheduled, p.customerCount, p.stockCount, p.newOrders, p.actualGap, p.inventoryBlocked, p.capacityGap]]);
  paragraph(p.quantityMet ? 'The requested quantity is fully assigned to real orders.' : `The requested quantity is not fully covered by real orders. ${p.newOrders} draft Stock orders remain to be created; blocked places do not reserve production capacity.`);
  paragraph(`Quantity takes priority over the weekly mix. Customers are selected by signed-plan receipt date, earliest first among orders ready for the slot. Unsigned, duplicate, inactive and physical vehicles are excluded. AU-finish horizon: ${p.earliest} to ${p.latest} AU finish (configured lead time included).`);
  paragraph(`Stock allocation: minimise excess above ${p.maxStockMonths ?? 3} months of average Stock handovers first, then fill Ideal deficits for Self-owned, then JV, then Independent. Additional units minimise projected peak Stock / Ideal. Ideal x ${p.report.stockCeilingMultiplier} is a reference, not a production cutoff. Results assume saved cancellations, delays and reallocations are implemented; this report does not execute them.`);
  if (p.adjustmentBasis) {
    const b = p.adjustmentBasis, s = b.summary;
    paragraph(`Confirmed inventory basis: ${b.confirmedAt} by ${b.confirmedBy}. ${s.cancellations} cancellations, ${s.delays} delays, ${s.reallocations} reallocations; ${s.total} distinct chassis. ${s.poolExcluded} pool do-not-build rows excluded. This proposal uses that saved snapshot, assuming its adjustments are implemented.`);
  }
  if (p.basisReplay) paragraph(`Capacity replay: ${p.basisReplay.cancelled} locked orders removed, ${p.basisReplay.shifted} orders postponed, ${p.basisReplay.reallocated} receiving dealers changed. Fixed-line last AU finish after adjustments: ${p.basisReplay.lastFixed || 'N/A'}. Surviving locked orders are repacked after cancellations (${p.basisReplay.rescheduledLocked || 0} locked dates recalculated). Rolling starts from the adjusted locked-line tail (${p.basisReplay.rollingBoundary || 'N/A'}) and uses consecutive remaining daily places: ${p.start || 'N/A'} to ${p.end || 'N/A'}. Stock cover does not postpone the period.`);
  if (p.report.coverExceptions?.length) table(`Stock cover exceptions - target ${p.maxStockMonths} months`, ['Dealer', 'Cover months (peak / snapshot)', 'Reason'], p.report.coverExceptions.map(d => [d.name, number(d.peakStockMonths), d.reason === 'noStockHandoverHistory' ? 'No positive Stock handover history; cover cannot be verified' : d.reason === 'existingStockOrFixedInbound' ? 'Existing stock / fixed inbound; no new Stock allocated' : 'Mandatory quantity / fixed inbound; target could not be maintained']));
  if (p.report.coverExceptions?.length) paragraph('Cover exceptions use peak Stock after the first new arrival for replenished dealers. Dealers receiving no new Stock use inventory at the report snapshot date; their existing excess is not attributed to this proposal.');
  if (p.report.uncertainIncoming) paragraph(`Stock forecasts include ${p.report.uncertainIncoming} pending existing inbound vehicles, reserved at their adjusted known arrival dates or conservatively from today if undated. Confirm these dates before acting on stock coverage.`);
  if (p.report.reallocationCount) paragraph(`${p.report.reallocationCount} self-owned pool Stock orders have a planned receiving-dealer reallocation. CRM / SAP orders are unchanged; implement and confirm these allocations separately.`);
  if (p.report.nonRecommendedCount) paragraph(`${p.report.nonRecommendedCount} nonrecommended model orders are included to meet the mandatory quantity after preferred models were used.`);
  paragraph(`Inventory snapshot: ${p.report.asOf}. Stock / Ideal uses projected Towable Stock at this date. Stock / average monthly Stock handovers is months of cover, using the previous ${p.report.handoverMonths} complete months. Zero or missing denominators show N/A. Group ratios use sums, not averages of dealer ratios. Real-order inventory excludes uncreated Stock orders; planned inventory includes them.`);
  table('Dealer group coverage', ['Group', 'Customer', 'Stock', 'New Stock', 'Projected Stock (real)', 'Stock / Ideal', 'Stock / avg handovers', 'Stock / all new handovers', 'Pending inbound reserve', 'Missing dealers'],
    p.report.groups.map(g => [groupName(g.group), g.customer, g.stock, g.newOrders, number(g.actual), number(g.actualIdeal), number(g.stockMonths), number(g.allNewMonths), g.uncertainIncoming || 0, g.missing]), [1.5,.7,.7,.8,1.1,1,1.2,1.2,1.2,.8]);
  if (p.report.unclassified) paragraph(`${p.report.unclassified} real orders have an unclassified dealer and are excluded from group coverage.`);
  table(`Dealer coverage at ${p.report.asOf}`, ['Dealer', 'Group', 'Cust.', 'Stock', 'New', 'Before', 'After real', 'Ideal', '/ Ideal', '/ Stock avg', '/ All new avg', 'Peak / Ideal'],
    p.report.dealers.map(d => [d.name, groupName(d.group), d.customer, d.stock, d.newOrders, number(d.before), number(d.actual), number(d.ideal), number(d.actualIdeal), number(d.stockMonths), number(d.allNewMonths), number(d.peakIdeal)]), [1.7,1.1,.5,.5,.5,.8,.9,.7,.8,.9,.9,1.2]);
  table('Weekly AU finish mix - new rolling orders only', ['Week commencing', 'Target', 'Customer', 'Stock', 'New Stock', 'Held', 'Customer share (real)', 'Share with drafts', 'Mix met*', 'Fixed C / S'],
    p.weeks.map(w => [w.week, w.target, w.customer, w.stock, w.newOrders, w.blocked, pct(w.customerShare), pct(w.plannedCustomerShare), w.ratioMet ? 'Yes' : 'No', `${w.fixedCustomer} / ${w.fixedStock}`]), [1.5,.6,.8,.6,.8,.6,1.2,1.2,.8,1]);
  paragraph('* Whole-vehicle rounding allows floor/ceiling of the weekly target. Capacity and quantity take precedence when the requested mix cannot be achieved; fixed preceding production is shown separately.');
  for (const [title, rows] of [['Models', p.report.models], ['Model ranges', p.report.ranges]]) table(title, ['Model / range', 'Customer', 'Dealer Stock', 'Total real', 'Draft Stock needed'], rows.map(r => [r.name, r.customer, r.stock, r.totalActual, r.newOrders]));
  if (p.confirmedAdjustments?.length) table('Confirmed inventory adjustment prerequisite - pool exclusions omitted',
    ['Chassis', 'Actions', 'Original dealer', 'Receiving dealer', 'Original AU', 'Planned AU', 'Planned arrival'],
    p.confirmedAdjustments.map(a => [a.chassis, a.action === 'cancel' ? 'Cancel' : [a.delayed ? 'Delay' : '', a.reallocated ? 'Reallocate' : ''].filter(Boolean).join(' + '), a.originalDealer || a.from, a.proposedDealer || a.to, a.originalAu, a.plannedAu, a.plannedArrival]), [1.2,1.1,1.5,1.5,1,1,1]);
  table('Real orders - saved production dates', ['Chassis', 'Type', 'Receiving dealer (from original if transferred)', 'Model', 'Signed plans', 'Request delivery', 'CN start', 'AU finish', 'Dealer arrival'],
    p.schedule.map(a => [a.chassis, a.kind === 'customer' ? 'Customer' : 'Stock', a.reallocated ? `${a.dealer} (from ${a.originalDealer})` : a.dealer, a.model, a.signedAt, a.requestDate, a.cnStart, a.auEnd, a.arrival]), [1.3,.8,1.5,1.1,1.1,1.1,1.1,1.1,1.1]);
  table('Draft Stock orders and blocked places - not real orders', ['Status', 'Dealer', 'Model', 'Quantity', 'Target AU', 'Proposed AU', 'Arrival', 'Reason'],
    p.requests.map(a => [a.status === 'newOrder' ? 'Create Stock order' : 'Blocked', a.dealer, a.model, a.quantity, a.requestedAu, a.auEnd, a.arrival, a.status === 'newOrder' ? 'Not yet ordered' : a.reason]), [1.3,1.4,1.1,.6,1,1,1,1.2]);
  table('Customers remaining in the pool / requiring review', ['Chassis', 'Dealer', 'Model', 'Signed plans', 'Request delivery', 'Earliest eligible AU', 'Reason'],
    p.customerHolds.map(a => [a.chassis, a.dealer, a.model, a.signedAt, a.requestDate, a.ready, reasonName(a.reason)]), [1.1,1.3,1,1,1,1,2]);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(`Regent RV | Saved planning snapshot - refresh and regenerate after source changes`, 34, doc.page.height - 48, { width: width - 90, lineBreak: false }); doc.text(`${i + 1} / ${range.count}`, doc.page.width - 110, doc.page.height - 48, { width: 76, align: 'right', lineBreak: false }); }
  doc.end(); return complete;
}
