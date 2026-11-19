import { finalScheduleView, scheduleRow, scheduleOrder } from './stock-schedule-view.mjs';
import { stockActions, dealerStockMetrics, reallocationYears } from './stock-simulation-metrics.mjs';
const groups = ['own', 'jv', 'independent'];
const key = v => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
const chassis = v => key(v).replace(/[-\s]/g, '');
export const modelRange = v => key(v).slice(0, 3) || 'UNK';
export const reportModel = v => ['SRC', 'SRP'].includes(modelRange(v)) ? key(v) : modelRange(v);
const unique = rows => [...new Map(rows.map(a => [chassis(a.chassis), a])).values()];
const sort = rows => [...rows].sort((a, b) => (a.plannedArrival || a.simulatedAu || '9999').localeCompare(b.plannedArrival || b.simulatedAu || '9999') || chassis(a.chassis).localeCompare(chassis(b.chassis)));
export const reportStage = group => ({ locked: 'Locked', au: 'AU production', cn: 'China production', sea: 'Shipping', rolling: 'Rolling', pgi: 'PGI transit', transport: 'Transport', customers: 'Stock pool', processing: 'Processing', later: 'Unscheduled' })[group] || group;
export const reportReason = code => ({ coverage: 'MY2027 model gap', balance: 'Month-end Stock / Ideal balance', ceiling: 'Retained model; ceiling conflict', deleted: 'Deleted MY2027 model', notOnYard: 'Not-on-yard model', settings: 'Receiving settings / applicable model review', date: 'AU finish / arrival date needed', horizon: 'Outside planning horizon', fixed: 'Fixed inbound', pool: 'Unscheduled stock pool', ownOrderSlot: 'Own-dealer order uses the AU slot', slotReplacement: 'Locked slot released; order retained in pool' })[code] || code || '-';

/** The report is a projection of one successful simulation, not a new allocation run. */
export function buildSimulationReport(report) {
  const dealers = groups.flatMap(group => (report[group]?.dealers || []).map(d => ({ ...d, group })));
  const actions = sort(unique(stockActions([...groups.flatMap(g => report[g]?.actions || []), ...(report.finalSchedule?.following || [])])));
  const finalPlan = finalScheduleView(report);
  const planRows = [...new Map([...actions.filter(a => a.receive && a.action !== 'cancel'), ...finalPlan.srh2026, ...finalPlan.rows.filter(a => !a.kind || a.kind === 'stock')].map(a => [chassis(a.chassis), scheduleRow(a)])).values()].sort(scheduleOrder);
  const cancellations = actions.filter(a => a.action === 'cancel');
  const reallocations = actions.filter(a => (a.reallocated || a.action === 'reallocate') && a.from && a.to && a.from !== a.to && a.action !== 'cancel');
  return { finalPlan, srh2026Count: finalPlan.srh2026.length, today: report.today, months: report.months, planningEnd: report.planningEnd, assumptions: report.assumptions,
    totals: { cancellations: cancellations.length, reallocations: reallocations.length, reallocationsByMY: reallocationYears(reallocations), dealers: dealers.length },
    dealers: dealers.map(d => {
      const canceled = cancellations.filter(a => a.from === d.slug), incoming = reallocations.filter(a => a.to === d.slug), outgoing = reallocations.filter(a => a.from === d.slug);
      const related = actions.filter(a => a.from === d.slug || a.to === d.slug);
      const months = d.monthly.map(m => m.month);
      const applicable = new Set((d.assumptions?.models || report.assumptions?.dealers.find(s => s.slug === d.slug)?.models || [...(d.coverage?.models || []), ...(d.coverage?.missing || [])]).map(key));
      const covered = new Set((d.coverage?.models || []).map(key));
      const matrix = new Map();
      function get(model) {
        const label = reportModel(model);
        if (!matrix.has(label)) matrix.set(label, { label, range: modelRange(model), target: 0, covered: 0, missing: 0, yard: 0, arrivals: Object.fromEntries(months.map(m => [m, 0])), later: 0, review: 0, total: 0 });
        return matrix.get(label);
      }
      for (const m of applicable) { const r = get(m); r.target++; if (covered.has(m)) r.covered++; else r.missing++; }
      const yard = unique(d.my2027Yard ?? (d.coverage?.details || []).filter(v => v.via === 'yard'));
      for (const v of yard) { const r = get(v.model); r.yard++; r.total++; }
      for (const a of actions) {
        if (String(a.modelYear) !== '2027' || a.action === 'cancel' || a.action === 'pool') continue;
        const destination = a.receive ? a.to : a.to || a.from;
        if (destination !== d.slug) continue;
        const r = get(a.model); r.total++;
        if (!a.receive || !a.plannedArrival) r.review++;
        else if (months.includes(a.plannedArrival.slice(0, 7))) r.arrivals[a.plannedArrival.slice(0, 7)]++;
        else r.later++;
      }
      const distribution = [...matrix.values()].sort((a, b) => a.label.localeCompare(b.label));
      return { ...d, planRows: planRows.filter(a => a.from === d.slug || a.to === d.slug), srh2026Count: finalPlan.srh2026.filter(a => (a.to || a.from) === d.slug).length, ...dealerStockMetrics(d.slug, actions), distribution, distributionMonths: months,
        showLater: distribution.some(r => r.later), showReview: distribution.some(r => r.review),
        cancellations: canceled, incoming, outgoing,
        reallocationGroups: ['2026', '2027', 'other'].map(year => ({ year, incoming: incoming.filter(a => (['2026', '2027'].includes(String(a.modelYear)) ? String(a.modelYear) : 'other') === year), outgoing: outgoing.filter(a => (['2026', '2027'].includes(String(a.modelYear)) ? String(a.modelYear) : 'other') === year) })),
        scheduleChanges: related.filter(a => (a.scheduleChanged || a.slotReleased) && a.from === d.slug),
        dateChanges: related.filter(a => a.action !== 'cancel' && !reallocations.includes(a) && a.virtualDate && !a.scheduleChanged && !a.slotReleased && (a.to || a.from) === d.slug),
        review: related.filter(a => ['pending', 'blocked'].includes(a.action) && (a.to || a.from) === d.slug),
        summary: { cancellations: canceled.length, reallocationIn: incoming.length, reallocationOut: outgoing.length, reallocations: incoming.length + outgoing.length },
      };
    }) };
}
