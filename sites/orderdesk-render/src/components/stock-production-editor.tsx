import type { Simulation, SimulationAssumptions } from './stock-simulation-types';

export default function StockProductionEditor({ data, scenario, zh, disabled, onChange }: { data: Simulation; scenario: SimulationAssumptions; zh: boolean; disabled: boolean; onChange: (value: SimulationAssumptions) => void }) {
  const plan = data.auProduction;
  if (!plan) return <p className="sf-warning">{zh ? 'AU月度产能暂未读取。' : 'AU production is not available yet.'}</p>;
  return <section className="sim-production"><h3>{zh ? 'AU 每月制造量 · 可修改' : 'AU production · editable'}</h3>
    <label className="sim-customer-ratio">{zh ? '每周客户订单比例' : 'Weekly customer orders'} <input type="number" aria-label="Weekly customer order percentage" min={0} max={100} step={1} value={scenario.customerPercent} disabled={disabled} onChange={e => onChange({ ...scenario, customerPercent: Number(e.target.value) })} /> %</label>
    <p className="da-note">{zh ? '按每周可调整名额穿插客户单；不足的位置留空等待，不用 Stock 填补。客户单只在下方按时间排序的排产表显示。' : 'Customer places are spread through each week. Missing orders leave empty customer places; Stock never fills them. Customer orders appear only in the chronological schedule.'}</p>
    <p className="da-note">{zh ? '修改月产量，自动重算下线时间。客户车及已进入生产的车辆先预留名额。' : 'Edit monthly production to recalculate finish dates. Customer and physical production places are reserved first.'}</p>
    <div className="da-table sim-production-table"><table><thead><tr><th>{zh ? 'AU下线月份' : 'Month'}</th><th>AU production</th><th>{zh ? 'Stock排产' : 'Stock plan'}</th><th>{zh ? '剩余名额' : 'Spare places'}</th></tr></thead><tbody>
      {plan.months.map(m => { const later = data.finalSchedule?.following.filter(a => a.plannedAu.startsWith(m.month)).length || 0; return <tr key={m.month}><td><b>{m.month}</b></td><td><input type="number" min={m.minimum} max={10000} step={1} disabled={disabled} aria-label={`${m.month} AU monthly production`} value={scenario.auMonthlyProduction[m.month] ?? m.sourceTotal} onChange={e => { const values = { ...scenario.auMonthlyProduction }; const value = Number(e.target.value); if (value === m.sourceTotal) delete values[m.month]; else values[m.month] = value; onChange({ ...scenario, auMonthlyProduction: values }); }} /></td><td>{m.plannedStock + later || ''}</td><td>{Math.max(0, m.unfilled - later) || ''}</td></tr>; })}
    </tbody></table></div>
    <label className="sim-slot-toggle"><input type="checkbox" checked={scenario.exchangeSlots} disabled={disabled} onChange={e => onChange({ ...scenario, exchangeSlots: e.target.checked })} />{zh ? '优先交换锁定线／库存池名额，减少 Reallocation' : 'Exchange locked / pool places before Reallocation'}</label>
    <p className="da-note">{zh ? `订单池排入 ${data.totals.scheduledFromPool} 台 · 换回订单池 ${data.totals.returnedToPool} 台（不是取消）` : `${data.totals.scheduledFromPool} admitted from pool · ${data.totals.returnedToPool} returned to pool (not cancelled)`}</p>
  </section>;
}
