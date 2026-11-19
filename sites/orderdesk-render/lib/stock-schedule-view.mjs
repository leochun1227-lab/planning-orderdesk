import { isSRH2026 } from './stock-simulation-metrics.mjs';
export const scheduleOrder = (a, b) => (a.auFinish || '9999').localeCompare(b.auFinish || '9999') || (a.slotOrder ?? Infinity) - (b.slotOrder ?? Infinity) || a.chassis.localeCompare(b.chassis);
export function scheduleRow(a) {
  const transfer = Boolean((a.reallocated || a.action === 'reallocate') && a.from !== a.to && a.to);
  return { ...a, auFinish: a.receive || a.continuation || a.slotScheduled ? a.plannedAu || a.simulatedAu || '' : '', dealer: a.proposedDealer || a.originalDealer || '',
    reallocation: transfer, outDealer: transfer ? a.originalDealer : '', inDealer: transfer ? a.proposedDealer : '', srh2026: isSRH2026(a) };
}
export function finalScheduleView(report) {
  const rows = (report.finalSchedule?.rows || ['own', 'jv', 'independent'].flatMap(g => report[g]?.actions || []).filter(a => a.receive && a.group === 'locked' && a.action !== 'cancel')).map(scheduleRow).sort(scheduleOrder);
  const byChassis = new Map(rows.map(a => [a.chassis, a]));
  const srh = (report.finalSchedule?.srh2026 || ['own', 'jv', 'independent'].flatMap(g => report[g]?.actions || []).filter(a => isSRH2026(a) && a.action !== 'cancel')).map(a => byChassis.get(a.chassis) || scheduleRow(a)).sort(scheduleOrder);
  const transfers = [...new Map([...['own', 'jv', 'independent'].flatMap(g => report[g]?.actions || []), ...(report.finalSchedule?.following || [])].map(a => [a.chassis,a])).values()].filter(a => a.action !== 'cancel' && (a.reallocated || a.action === 'reallocate') && a.to && a.from !== a.to).map(scheduleRow).sort(scheduleOrder);
  return { rows, transfers, srh2026: srh, stock: rows.filter(a => !a.kind || a.kind === 'stock').length, customers: rows.filter(a => a.kind === 'customer').length, waiting: rows.filter(a => a.kind === 'customer-gap').length, locked: rows.filter(a => a.kind !== 'customer-gap' && a.schedulePart !== 'following').length, following: rows.filter(a => a.kind !== 'customer-gap' && a.schedulePart === 'following').length,
    srh2026Scheduled: rows.filter(a => a.srh2026 && (!a.kind || a.kind === 'stock')).length, boundary: report.finalSchedule?.boundary || '' };
}
export const scheduleHeaders = ['AU finish', 'Chassis', 'Model', 'MY', 'Dealer', 'Order', 'Customer', 'Reallocation', 'OUT - from', 'IN - to'];
export const scheduleCells = a => [a.auFinish, a.chassis, a.model, a.modelYear, a.dealer,
  a.kind === 'customer-gap' ? 'Waiting for customer' : a.kind === 'customer' ? 'Customer' : a.schedulePart === 'following' ? 'Next Stock' : a.group === 'yard' ? 'In yard' : ['au', 'sea', 'cn', 'pgi', 'transport'].includes(a.group) ? 'Inbound Stock' : a.receive ? 'Locked Stock' : 'Not scheduled',
  a.kind === 'customer' ? a.customer : '', a.reallocation ? a.reallocationCheck?.reason === 'springDisplay' ? 'Mar/Apr model coverage' : a.reallocationCheck?.reason === 'inventoryBalance' ? 'Balance Stock / Ideal' : a.reallocationCheck?.reason === 'fixedCeiling' ? 'Fixed date / limit' : a.reallocationCheck?.reason === 'modelNoOwnOrder' ? 'No eligible own model' : 'Yes' : '', a.outDealer, a.inDealer];
