export const isSRH2026 = v => String(v.modelYear || '').trim() === '2026' && /^SRH/i.test(String(v.model || '').trim());
const stock = a => a.kind ? a.kind === 'stock' : a.customer == null || /stock$/i.test(String(a.customer).trim());
const key = value => String(value || '').trim().toUpperCase();
export const stockActions = actions => actions.filter(stock);
export function reallocationYears(actions) {
  const byYear = { '2026': 0, '2027': 0, other: 0 };
  for (const a of stockActions(actions)) if (a.action !== 'cancel' && (a.reallocated || a.action === 'reallocate') && a.from !== a.to) byYear[['2026', '2027'].includes(String(a.modelYear)) ? String(a.modelYear) : 'other']++;
  return byYear;
}
export function dealerStockMetrics(slug, actions, calendarYear = 2027) {
  const rows = stockActions(actions), year = String(calendarYear);
  const inbound = rows.filter(a => a.to === slug && a.receive && a.action !== 'cancel' && a.action !== 'pool');
  const old = inbound.filter(a => String(a.modelYear) === '2026' && a.plannedArrival);
  const latestMY2026Arrival = old.map(a => a.plannedArrival).sort().at(-1) || '';
  const pendingMY2026Arrivals = rows.filter(a => String(a.modelYear) === '2026' && (a.to || a.from) === slug && !a.receive && !['cancel', 'pool'].includes(a.action)).length;
  const reallocationByMY = Object.fromEntries(['2026', '2027', 'other'].map(y => {
    const selected = rows.filter(a => (a.reallocated || a.action === 'reallocate') && a.from !== a.to && a.action !== 'cancel' && (['2026', '2027'].includes(String(a.modelYear)) ? String(a.modelYear) : 'other') === y);
    return [y, { incoming: selected.filter(a => a.to === slug).length, outgoing: selected.filter(a => a.from === slug).length }];
  }));
  const srcSrp = inbound.filter(a => String(a.modelYear) === '2027' && ['SRC', 'SRP'].includes(key(a.model).slice(0, 3)));
  const months = Array.from({ length: 12 }, (_, i) => { const month = `${year}-${String(i + 1).padStart(2, '0')}`, arr = srcSrp.filter(a => a.plannedArrival?.startsWith(month)); return { month, src: arr.filter(a => key(a.model).startsWith('SRC')).length, srp: arr.filter(a => key(a.model).startsWith('SRP')).length }; });
  const firstRecommended = Object.fromEntries(['SRC','SRP'].map(range => {
    const units = srcSrp.filter(a => a.policy === 'display' && key(a.model).startsWith(range));
    return [range, units.map(a => a.plannedArrival).filter(Boolean).sort()[0] || (units.length ? 'pending' : '')];
  }));
  return { firstRecommended, latestMY2026Arrival, pendingMY2026Arrivals, reallocationByMY,
    my2027SrcSrpArrivals: { calendarYear, months, outsideYear: srcSrp.filter(a => a.plannedArrival && !a.plannedArrival.startsWith(`${year}-`)).length,
      unresolved: rows.filter(a => String(a.modelYear) === '2027' && ['SRC', 'SRP'].includes(key(a.model).slice(0, 3)) && (a.to || a.from) === slug && (!a.receive || !a.plannedArrival) && !['cancel', 'pool'].includes(a.action)).length } };
}
