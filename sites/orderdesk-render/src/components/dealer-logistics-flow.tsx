import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

type Counts = { stock: number; customer: number; total: number };
type Stage = 'pool' | 'rolling' | 'locked' | 'cn' | 'sea' | 'au' | 'transport' | 'transit' | 'dealership';
type Kind = 'total' | 'customer' | 'stock';
export type DealerLogistics = { dealers: { slug: string; name: string; stages: Record<Stage, Counts> }[] };

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
  const selected = data.dealers.filter(d => dealer === 'all' || d.slug === dealer);
  const count = (stage: Stage) => selected.reduce((n, d) => n + d.stages[stage][kind], 0);
  const fmt = (n: number) => n.toLocaleString('en-AU');
  const scope = dealer === 'all' ? (zh ? '四家店合计' : 'All four dealers') : data.dealers.find(d => d.slug === dealer)?.name;

  return <section className="dl-flow" aria-label={zh ? '物流流程' : 'Logistics flow'}>
    <header className="dl-flow-header">
      <div className="dl-flow-title"><h3>{zh ? '物流流程' : 'Logistics flow'}</h3><span>{scope} · {zh ? '当前数量' : 'Current vehicles'}</span></div>
      <div className="dl-flow-filters">
        <div className="dl-flow-seg" role="group" aria-label={zh ? '物流门店筛选' : 'Logistics dealer filter'}>
          <button type="button" aria-pressed={dealer === 'all'} onClick={() => setDealer('all')}>{zh ? '总数' : 'Total'}</button>
          {data.dealers.map(d => <button type="button" key={d.slug} aria-pressed={dealer === d.slug} onClick={() => setDealer(d.slug)}>{d.name}</button>)}
        </div>
        <div className="dl-flow-seg" role="group" aria-label={zh ? '物流订单类型筛选' : 'Logistics order type filter'}>
          {([['total', zh ? '全部' : 'All'], ['customer', 'Customer'], ['stock', 'Stock']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}
        </div>
      </div>
    </header>
    <div className="dl-flow-scroll" tabIndex={0} role="region" aria-label={zh ? '物流各环节数量，窄屏可横向滚动' : 'Logistics stages; scroll horizontally on small screens'}>
      <div className="dl-flow-track">
        {steps.map(step => <div className={`dl-flow-step ${step.id === 'pool' ? 'dl-flow-intake' : ''}`} key={step.id} data-stage={step.id}>
          <span className="dl-flow-label">{zh ? step.zh : step.en}</span>
          <strong className="dl-flow-value">{fmt(count(step.id) + (step.id === 'pool' ? count('rolling') : 0))}<small>{zh ? '台' : 'vans'}</small></strong>
          {step.id === 'pool' ? <div className="dl-flow-breakdown"><span>{zh ? '订单池' : 'Pool'} <b>{fmt(count('pool'))}</b></span><span>{zh ? '滚动排产' : 'Rolling'} <b>{fmt(count('rolling'))}</b></span></div>
            : <span className="dl-flow-note">{zh ? step.noteZh : step.noteEn}</span>}
          <ArrowRight className="dl-flow-arrow" size={18} aria-hidden="true" />
        </div>)}
        <div className="dl-flow-dealerships" role="group" aria-label="Dealership">
          <span className="dl-flow-destination-label">Dealership</span>
          {data.dealers.map(d => <button type="button" key={d.slug} data-dealer={d.slug}
            className={`dl-flow-dealer${dealer !== 'all' && dealer !== d.slug ? ' is-muted' : ''}`}
            aria-pressed={dealer === d.slug} onClick={() => setDealer(d.slug)}>
            <span>{d.name}</span><strong>{fmt(d.stages.dealership[kind])}</strong>
          </button>)}
        </div>
      </div>
    </div>
    <footer className="dl-flow-footer"><span>{zh ? '新车 · 不含二手车 · 每台车只计一次' : 'New vehicles · excludes second hand · each chassis counted once'}</span>
      <span aria-live="polite">{scope} · {kind === 'total' ? (zh ? '全部' : 'All') : kind === 'customer' ? 'Customer' : 'Stock'} · {zh ? '到店' : 'At dealership'} <b>{fmt(count('dealership'))}</b></span></footer>
  </section>;
}
