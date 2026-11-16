import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

type Counts = { stock: number; customer: number; total: number; stockMonths: Record<string, number>; stockUndated: number };
type Stage = 'pool' | 'rolling' | 'locked' | 'cn' | 'sea' | 'au' | 'transport' | 'transit' | 'dealership';
type Kind = 'total' | 'customer' | 'stock';
type Vehicle = 'all' | 'motorised' | 'towable';
export type DealerLogistics = { dealers: { slug: string; name: string; featured: boolean; stages: Record<Stage, Counts>; byVehicle: Record<Exclude<Vehicle, 'all'>, Record<Stage, Counts>> }[] };
type Dealer = DealerLogistics['dealers'][number];
const fmt = (n: number) => n.toLocaleString('en-AU');

function aggregate(dealers: Dealer[], stages: Stage[]): Counts {
  const out: Counts = { stock: 0, customer: 0, total: 0, stockMonths: {}, stockUndated: 0 };
  for (const d of dealers) for (const stage of stages) {
    const c = d.stages[stage];
    out.stock += c.stock; out.customer += c.customer; out.total += c.total; out.stockUndated += c.stockUndated;
    for (const [month, n] of Object.entries(c.stockMonths)) out.stockMonths[month] = (out.stockMonths[month] || 0) + n;
  }
  return out;
}

function StockArrivals({ counts, zh, customerOnly }: { counts: Counts; zh: boolean; customerOnly: boolean }) {
  const months = customerOnly ? [] : Object.entries(counts.stockMonths).sort(([a], [b]) => a.localeCompare(b));
  const undated = customerOnly ? 0 : counts.stockUndated;
  return <div className="dl-flow-arrivals">
    <span>{zh ? '预计到店 Stock' : 'Stock arrivals'}</span>
    <div className="dl-flow-months" tabIndex={months.length > 4 ? 0 : undefined}>
      {months.length || undated ? <table aria-label={zh ? '到店 Stock 月份及数量' : 'Stock arrival months and quantities'}><tbody>
        {months.map(([month, n]) => <tr key={month}><td>{month}</td><td>{fmt(n)}</td></tr>)}
        {undated > 0 && <tr className="dl-flow-undated"><td>{zh ? '月份待确定' : 'Month TBC'}</td><td>{fmt(undated)}</td></tr>}
      </tbody></table> : <span className="dl-flow-no-stock">{zh ? '0 台' : '0 vans'}</span>}
    </div>
  </div>;
}

const steps: { id: Exclude<Stage, 'rolling' | 'dealership'>; zh: string; en: string; noteZh: string; noteEn: string }[] = [
  { id: 'pool', zh: '订单池 + 滚动排产线', en: 'Order pool + rolling', noteZh: '', noteEn: '' },
  { id: 'locked', zh: '排产锁定线', en: 'Locked schedule', noteZh: '已锁定 · 待上线', noteEn: 'Locked · not started' },
  { id: 'cn', zh: '国内生产', en: 'China production', noteZh: 'Longtree', noteEn: 'Longtree' },
  { id: 'sea', zh: '海运', en: 'Sea freight', noteZh: '中国 → 澳洲', noteEn: 'China → Australia' },
  { id: 'au', zh: '澳洲生产', en: 'AU production', noteZh: 'Melbourne factory', noteEn: 'Melbourne factory' },
  { id: 'transport', zh: 'Transport', en: 'Transport', noteZh: '已下线 · 待发车', noteEn: 'Finished · awaiting dispatch' },
  { id: 'transit', zh: 'Transit', en: 'Transit', noteZh: '已发出 · 未到店', noteEn: 'Dispatched · not at dealer' },
];

export default function DealerLogisticsFlow({ data, zh }: { data: DealerLogistics; zh: boolean }) {
  const [dealer, setDealer] = useState('all');
  const [kind, setKind] = useState<Kind>('total');
  const [vehicle, setVehicle] = useState<Vehicle>('all');
  const displayed = data.dealers.map(d => ({ ...d, stages: vehicle === 'all' ? d.stages : d.byVehicle[vehicle] }));
  const selected = displayed.filter(d => dealer === 'all' || d.slug === dealer);
  const count = (stage: Stage) => selected.reduce((n, d) => n + d.stages[stage][kind], 0);
  const featured = displayed.filter(d => d.featured);
  const others = displayed.filter(d => !d.featured);
  const otherYard = aggregate(others, ['dealership']);
  const scope = dealer === 'all' ? (zh ? '所有经销商' : 'All dealers') : data.dealers.find(d => d.slug === dealer)?.name;

  return <section className="dl-flow" aria-label={zh ? '物流流程' : 'Logistics flow'}>
    <header className="dl-flow-header">
      <div className="dl-flow-title"><h3>{zh ? '物流流程' : 'Logistics flow'}</h3><span>{scope} · {zh ? '当前数量' : 'Current vehicles'}</span></div>
      <div className="dl-flow-filters">
        <div className="dl-flow-seg" role="group" aria-label={zh ? '物流门店筛选' : 'Logistics dealer filter'}>
          <button type="button" aria-pressed={dealer === 'all'} onClick={() => setDealer('all')}>{zh ? '全部订单' : 'All orders'}</button>
          {featured.map(d => <button type="button" key={d.slug} aria-pressed={dealer === d.slug} onClick={() => setDealer(d.slug)}>{d.name}</button>)}
        </div>
        <div className="dl-flow-seg" role="group" aria-label={zh ? '物流订单类型筛选' : 'Logistics order type filter'}>
          {([['total', zh ? '全部' : 'All'], ['customer', 'Customer'], ['stock', 'Stock']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}
        </div>
        <div className="dl-flow-seg" role="group" aria-label={zh ? '物流车辆类型筛选' : 'Logistics vehicle type filter'}>
          {([['all', zh ? '全部' : 'All'], ['motorised', 'Motorised'], ['towable', 'Towable']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={vehicle === id} onClick={() => setVehicle(id)}>{label}</button>)}
        </div>
      </div>
    </header>
    <div className="dl-flow-scroll" tabIndex={0} role="region" aria-label={zh ? '物流各环节数量，窄屏可横向滚动' : 'Logistics stages; scroll horizontally on small screens'}>
      <div className="dl-flow-track">
        {steps.map(step => <div className="dl-flow-stage" key={step.id} data-stage={step.id}>
          <div className="dl-flow-step">
            <span className="dl-flow-label">{zh ? step.zh : step.en}</span>
            <strong className="dl-flow-value">{fmt(count(step.id) + (step.id === 'pool' ? count('rolling') : 0))}<small>{zh ? '台' : 'vans'}</small></strong>
            {step.id === 'pool' ? <div className="dl-flow-breakdown"><span>{zh ? '订单池' : 'Pool'} <b>{fmt(count('pool'))}</b></span><span>{zh ? '滚动排产' : 'Rolling'} <b>{fmt(count('rolling'))}</b></span></div>
              : <span className="dl-flow-note">{zh ? step.noteZh : step.noteEn}</span>}
            <ArrowRight className="dl-flow-arrow" size={18} aria-hidden="true" />
          </div>
          <StockArrivals counts={aggregate(selected, step.id === 'pool' ? ['pool', 'rolling'] : [step.id])} zh={zh} customerOnly={kind === 'customer'} />
        </div>)}
        <div className="dl-flow-dealerships" role="group" aria-label="Dealership">
          <span className="dl-flow-destination-label">Dealership</span>
          {featured.map(d => <div className={`dl-flow-destination${dealer !== 'all' && dealer !== d.slug ? ' is-muted' : ''}`} key={d.slug} data-dealer={d.slug}>
            <button type="button" className="dl-flow-dealer" aria-pressed={dealer === d.slug} onClick={() => setDealer(d.slug)}>
              <span>{d.name}</span><strong>{fmt(d.stages.dealership[kind])}</strong>
            </button>
          </div>)}
          <div className={`dl-flow-destination${dealer !== 'all' ? ' is-muted' : ''}`} data-dealer="other-dealers">
            <div className="dl-flow-dealer dl-flow-other"><span>{zh ? '其他经销商' : 'Other dealers'}</span><strong>{fmt(otherYard[kind])}</strong></div>
          </div>
        </div>
      </div>
    </div>
    <footer className="dl-flow-footer"><span>{zh ? '全部订单含所有经销商及未分配订单 · 新车 · 日期缺失标为待确定' : 'All dealers and unassigned orders · new vehicles · missing arrival dates shown as TBC'}</span>
      <span aria-live="polite">{scope} · {vehicle === 'all' ? (zh ? '全部车型' : 'All vehicles') : vehicle === 'motorised' ? 'Motorised' : 'Towable'} · {kind === 'total' ? (zh ? '全部' : 'All') : kind === 'customer' ? 'Customer' : 'Stock'} · {zh ? '到店' : 'At dealership'} <b>{fmt(count('dealership'))}</b></span></footer>
  </section>;
}
