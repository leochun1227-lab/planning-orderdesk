import { useState } from 'react';
import type { Simulation, SimulationAssumptions } from './stock-simulation-types';

export default function StockProductionEditor({ data, scenario, zh, disabled, onChange }: { data: Simulation; scenario: SimulationAssumptions; zh: boolean; disabled: boolean; onChange: (value: SimulationAssumptions) => void }) {
  const plan = data.auProduction;
  const [endDate, setEndDate] = useState('');
  const rolling = data.finalSchedule.rollingMix || [];
  const selected = rolling.find(r => r.day === endDate) || rolling.find(r => r.thirty.stock || r.thirty.customers) || rolling[0];
  const changeover = data.finalSchedule.changeover;
  if (!plan) return <p className="sf-warning">{zh ? 'AU月度产能暂未读取。' : 'AU production is not available yet.'}</p>;
  return <section className="sim-production"><h3>{zh ? 'AU 每月制造量 · 可修改' : 'AU production · editable'}</h3>
    <label className="sim-customer-ratio">{zh ? '客户订单目标比例（滚动 7 天／30 天）' : 'Customer order target (rolling 7 / 30 days)'} <input type="number" aria-label="Weekly customer order percentage" min={0} max={100} step={1} value={scenario.customerPercent} disabled={disabled} onChange={e => onChange({ ...scenario, customerPercent: Number(e.target.value) })} /> %</label>
    <p className="da-note">{zh ? '先排 Stock，再按比例穿插已签客户单。只有 Stock 排程需要、尚无客户单的名额才显示为等待。' : 'Signed customers are interleaved with scheduled Stock. Waiting places appear where the Stock plan needs a customer order.'}</p>
    {changeover && <p className="da-note"><b>{zh ? '可调整 Stock 的 AU 下线' : 'Editable Stock AU finish'}</b> · {zh ? '最后一台 MY2026' : 'Last MY2026'} {changeover.last2026 || '—'} · {zh ? '第一台 MY2027' : 'First MY2027'} {changeover.first2027 || '—'}{changeover.held2026 > 0 && ` · MY2026 ${zh ? '待排' : 'awaiting a place'} ${changeover.held2026}`}</p>}
    <div className="da-table sim-production-table"><table><thead><tr><th>{zh ? 'AU下线月份' : 'Month'}</th><th>AU production</th><th>{zh ? 'Stock排产' : 'Stock plan'}</th><th>{zh ? '剩余名额' : 'Spare places'}</th></tr></thead><tbody>
      {plan.months.map(m => { const later = data.finalSchedule?.following.filter(a => a.plannedAu.startsWith(m.month)).length || 0; return <tr key={m.month}><td><b>{m.month}</b></td><td><input type="number" min={m.minimum} max={10000} step={1} disabled={disabled} aria-label={`${m.month} AU monthly production`} value={scenario.auMonthlyProduction[m.month] ?? m.sourceTotal} onChange={e => { const values = { ...scenario.auMonthlyProduction }; const value = Number(e.target.value); if (value === m.sourceTotal) delete values[m.month]; else values[m.month] = value; onChange({ ...scenario, auMonthlyProduction: values }); }} /></td><td>{m.plannedStock + later || ''}</td><td>{data.finalSchedule.auMonthlyMix.find(row => row.month === m.month)?.stockEmpty || ''}</td></tr>; })}
    </tbody></table></div>
    <h4>{zh ? '最终 AU 下线 · 每月客户／Stock 比例' : 'Final AU finish · monthly customer / Stock mix'}</h4>
    <p className="da-note">{zh ? '实际客户比例＝已排客户单 ÷（已排客户单＋已排 Stock）。同一台车按最终 AU 下线日期计一次。' : 'Actual customer share is scheduled customer orders divided by all scheduled vehicles, using final AU finish dates.'}</p>
    <div className="da-table"><table><thead><tr>{[zh ? 'AU 下线月' : 'AU finish month', 'Stock', zh ? '客户单' : 'Customer orders', zh ? '实际客户比例' : 'Actual customer share', zh ? '目标' : 'Target', zh ? '缺客户单' : 'Awaiting customers'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{data.finalSchedule.auMonthlyMix.map(m => <tr key={m.month}><td>{m.month}</td><td>{m.stock}</td><td>{m.customers}</td><td><b>{m.actualCustomerPercent == null ? '—' : `${m.actualCustomerPercent}%`}</b></td><td>{data.assumptions.customerPercent}%</td><td>{m.waiting || '—'}</td></tr>)}</tbody></table></div>
    {selected && <div className="sim-quota-audit"><label>{zh ? '滚动比例核对 · 截止日' : 'Rolling mix · ending on'} <input type="date" aria-label="Rolling mix end date" min={rolling[0].day} max={rolling.at(-1)?.day} value={selected.day} onChange={e => setEndDate(e.target.value)} /></label>
      <div className="da-table"><table><thead><tr>{[zh ? '区间' : 'Window', 'Stock', zh ? '客户单' : 'Customer orders', zh ? '实际客户比例' : 'Actual share', zh ? '缺客户单' : 'Awaiting customers'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{(['seven', 'thirty'] as const).map((key, i) => { const v = selected[key]; return <tr key={key}><th>{i ? 30 : 7} {zh ? '天' : 'days'}</th><td>{v.stock}</td><td>{v.customers}</td><td>{v.actualPercent == null ? '—' : `${v.actualPercent}%`}</td><td>{v.waiting || '—'}</td></tr>; })}</tbody></table></div></div>}
    <label className="sim-slot-toggle"><input type="checkbox" checked={scenario.exchangeSlots} disabled={disabled} onChange={e => onChange({ ...scenario, exchangeSlots: e.target.checked })} />{zh ? '以库存倍数平衡为目标，同等效果优先交换本店锁定线／库存池' : 'Balance inventory first; prefer own-dealer slot exchanges for equivalent outcomes'}</label>
    <p className="da-note">{zh ? `订单池排入 ${data.totals.scheduledFromPool} 台 · 换回订单池 ${data.totals.returnedToPool} 台（不是取消）` : `${data.totals.scheduledFromPool} admitted from pool · ${data.totals.returnedToPool} returned to pool (not cancelled)`}</p>
  </section>;
}
