import PDFDocument from 'pdfkit';
import { finalScheduleView, scheduleHeaders, scheduleCells } from '../lib/stock-schedule-view.mjs';

/** A compact, chronological production list, with repeated headers on normal
 * landscape pages. It is a read-only snapshot of the current AU capacity plan. */
export async function buildFinalSchedulePdf(report) {
  const plan = finalScheduleView(report), doc = new PDFDocument({ autoFirstPage: false, margin: 0, size: 'A4', layout: 'landscape', bufferPages: true });
  const chunks = [], done = new Promise((resolve, reject) => { doc.on('data', p => chunks.push(p)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = 841.89, height = 595.28, left = 24, usable = width - 48;
  const weights = [1.1, 1.15, 1.45, .55, 1.5, 1.2, 1.5, .9, 1.5, 1.5], sum = weights.reduce((a, b) => a + b), widths = weights.map(n => n / sum * usable);
  const clean = v => String(v ?? '').replace(/[\u2010-\u2015\u2212]/g, '-');
  const text = (v, x, y, w, bold = false, color = '#19394f') => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color).text(clean(v), x, y, { width: w, lineGap: 0 });
  let y = 0, titleNow = 'FINAL AU PRODUCTION SCHEDULE';
  function row(cells, header = false, red = false) {
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const h = Math.max(23, ...cells.map((v, i) => doc.heightOfString(clean(v), { width: widths[i] - 8 }) + 12));
    if (!header && y + h > height - 30) page(titleNow);
    doc.rect(left, y, usable, h).fill(header ? '#19394f' : red ? '#ffe8e8' : cells[5] === 'Waiting for customer' ? '#fff7dc' : '#f3f6fa');
    let x = left;
    cells.forEach((v, i) => { text(v, x + 4, y + 6, widths[i] - 8, header || red, header ? '#ffffff' : red ? '#b42318' : '#19394f'); x += widths[i]; });
    y += h + 1;
  }
  function page(title) {
    titleNow = title; doc.addPage(); y = 24;
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#19394f').text(title, left, y, { width: usable }); y += 28;
    text(`${report.today}  |  Customer quota ${report.assumptions.customerPercent ?? 35}%  |  Stock ${plan.stock}  |  Customers ${plan.customers}  |  Waiting ${plan.waiting}  |  SRH MY2026 ${plan.srh2026.length}`, left, y, usable); y += 20;
    row(scheduleHeaders, true);
  }
  page('FINAL AU PRODUCTION SCHEDULE');
  for (const a of plan.rows) row(scheduleCells(a), false, a.srh2026);
  if (!plan.rows.length) row(['', '', 'No production dates available', '', '', '', '', '', '', '']);
  if (plan.transfers.length) {
    page('REALLOCATION - AU FINISH ORDER');
    for (const a of plan.transfers) row(scheduleCells(a), false, a.srh2026);
  }
  if (plan.srh2026.length) {
    page('SRH MY2026 - ORIGINAL DEALER RETAINED');
    for (const a of plan.srh2026) row(scheduleCells(a), false, true);
  }
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); text(`${i + 1} / ${pages.count}`, width - 90, height - 19, 65); }
  doc.end(); return done;
}
