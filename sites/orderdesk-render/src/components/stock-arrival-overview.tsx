import { useState } from 'react';
import type { SimulationDealer } from './stock-simulation-types';

export default function StockArrivalOverview({ dealers, zh, pending }: { dealers: SimulationDealer[]; zh: boolean; pending: boolean }) {
  const [search, setSearch] = useState('');
  const list = dealers.filter(d => `${d.name} ${d.slug}`.toLowerCase().includes(search.trim().toLowerCase()));
  const totals = [3,4].map(i => dealers.reduce((n,d) => {
    const m = d.my2027SrcSrpArrivals.months[i];
    return {src:n.src+m.src,srp:n.srp+m.srp};
  },{src:0,srp:0}));
  return <section className={`sim-arrival-overview ${pending ? 'sim-calculating' : ''}`} aria-label="MY2027 SRC SRP Stock arrivals">
    <div className="sim-toolbar"><h3>{zh ? '各 Dealer · MY2027 SRC / SRP Stock 到货柱状图' : 'All dealers · MY2027 SRC / SRP Stock arrivals'}</h3><input aria-label={zh ? '搜索到货图Dealer' : 'Search arrival chart dealers'} placeholder="Dealer" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <p className="da-note">{zh ? '仅统计 MY2027 Stock，按调整后的接收 Dealer 和 2027 年预计到店月份统计；不含客户车、已取消车辆及未排产库存池。图表月份不受下方 8 / 14 个月切换影响。' : 'MY2027 Stock only, by receiving dealer after adjustments and arrival month in calendar 2027. Excludes customers, cancelled vehicles and the unscheduled pool. This full-year chart is independent of the 8 / 14-month inventory view.'}</p>
    <p><b>{zh ? '4、5 月预计到店' : 'April and May arrivals'} · {totals.reduce((n,m)=>n+m.src+m.srp,0)}</b>
      {totals.map((m,i)=><span key={i}> · {zh ? (i+4)+' 月' : ['Apr','May'][i]} SRC {m.src} / SRP {m.srp}</span>)}</p>
    <div className="sim-arrival-grid">{list.map(d => {
      const s = d.my2027SrcSrpArrivals, values = s.months, maximum = Math.max(1, ...values.flatMap(m => [m.src, m.srp])), top = 24, bottom = 153, left = 28, step = 28;
      const y = (n: number) => bottom - n / maximum * (bottom - top), x = (i: number) => left + i * step;
      const src = values.reduce((n, m) => n + m.src, 0), srp = values.reduce((n, m) => n + m.srp, 0);
      return <article className="sim-arrival-card" key={d.slug} data-arrival-dealer={d.slug}><header><b>{d.name}</b><span>SRC <strong>{src}</strong> · SRP <strong>{srp}</strong></span></header>
        <svg viewBox="0 0 377 183" role="img" aria-label={`${d.name} MY2027 SRC ${src} SRP ${srp} Stock arrivals in 2027`}>
          {[0, .5, 1].map(f => <g key={f}><line x1={left - 5} x2={369} y1={y(maximum * f)} y2={y(maximum * f)} stroke="#dce5ef" /><text x={left - 9} y={y(maximum * f) + 4} textAnchor="end" fontSize="10" fill="#64748b">{Math.round(maximum * f * 10) / 10}</text></g>)}
          {values.map((m, i) => <g key={m.month}><rect x={x(i)} y={y(m.src)} width="9" height={bottom - y(m.src)} fill="#1966b3"><title>{m.month} · SRC {m.src}</title></rect><rect x={x(i) + 10} y={y(m.srp)} width="9" height={bottom - y(m.srp)} fill="#dd8b38"><title>{m.month} · SRP {m.srp}</title></rect>{m.src > 0 && <text x={x(i) + 4.5} y={y(m.src) - 4} textAnchor="middle" fontSize="9" fill="#1966b3">{m.src}</text>}{m.srp > 0 && <text x={x(i) + 14.5} y={y(m.srp) - 4} textAnchor="middle" fontSize="9" fill="#a75d16">{m.srp}</text>}<text x={x(i) + 10} y={174} textAnchor="middle" fontSize="10" fill="#64748b">{m.month.slice(5)}</text></g>)}
        </svg><div className="sim-arrival-legend"><span><i />SRC</span><span><i />SRP</span><small>2027 · {zh ? '到店月份' : 'arrival month'}</small></div>
        {d.firstRecommended && <p>{zh ? '首辆推荐车到店' : 'First recommended arrival'} · {(['SRC','SRP'] as const).map(k => k+' '+(d.firstRecommended?.[k]==='pending'?(zh?'待定':'Pending'):d.firstRecommended?.[k] || '—')).join(' · ')}</p>}
        {d.displayWindow && <p>{zh ? '预计在店型号' : 'Models on yard'} · 31 Mar <b>{d.displayWindow.atStart}/{d.displayWindow.target}</b> · 7 Apr <b>{d.displayWindow.atEnd}/{d.displayWindow.target}</b> · 30 Apr <b>{d.displayWindow.inApril}/{d.displayWindow.target}</b></p>}
        <p>{zh ? 'MY2026 最晚到店：' : 'Last MY2026 arrival: '}{d.latestMY2026Arrival || (d.pendingMY2026Arrivals ? (zh ? '待核对' : 'Review') : (zh ? '无待到店车辆' : 'No inbound'))}</p>
        {s.outsideYear > 0 && <small className="sim-arrival-note">{zh ? `另有 ${s.outsideYear} 台在其他年份到店` : `${s.outsideYear} arrivals outside 2027`}</small>}
      </article>;
    })}</div>{!list.length && <p className="sf-empty">{zh ? '没有符合条件的Dealer' : 'No matching dealers'}</p>}
  </section>;
}
