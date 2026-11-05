import { ChevronRight } from 'lucide-react';
import { ALERTS, type ActionCounts, type AlertKey } from './schedule-model';

type Target = { kind: 'schedule'; alert: AlertKey | 'due' | null; scope?: 'open' | 'slots' } | { kind: 'overdue' } | { kind: 'pending' };

export default function ActionPanel({ counts, zh, onGo }: { counts: ActionCounts; zh: boolean; onGo: (t: Target) => void }) {
  const cards: { key: string; n: number; bg: string; fg: string; title: string; hint: string; target: Target }[] = [
    { key: 'overdue', n: counts.overdue, bg: '#d9480f', fg: '#fff', title: zh ? '签字逾期' : 'Signature overdue', hint: zh ? '发图满 5 天未签字' : 'Plans sent ≥5 days, unsigned', target: { kind: 'overdue' } },
    { key: 'red', n: counts.red, bg: ALERTS.red.bg, fg: ALERTS.red.fg, title: zh ? '空位未填' : 'Empty slots', hint: zh ? '21 周内生产、还没有订单' : 'Producing within 21 weeks, no order', target: { kind: 'schedule', alert: 'red', scope: 'slots' } },
    { key: 'yellow', n: counts.yellow, bg: ALERTS.yellow.bg, fg: ALERTS.yellow.fg, title: zh ? '图纸未发经销商' : 'Plans not sent', hint: zh ? '26 周内，已发 Longtree' : 'Within 26 weeks, sent to Longtree', target: { kind: 'schedule', alert: 'yellow' } },
    { key: 'lightBlue', n: counts.lightBlue + counts.blue, bg: ALERTS.lightBlue.bg, fg: ALERTS.lightBlue.fg, title: zh ? '等待签字' : 'Awaiting signature', hint: zh ? '26 周内，已发图' : 'Within 26 weeks, plans sent', target: { kind: 'schedule', alert: 'lightBlue' } },
    { key: 'grey', n: counts.grey + counts.greyNoRequest, bg: ALERTS.grey.bg, fg: ALERTS.grey.fg, title: zh ? '已签字未发 PO' : 'Signed, PO not sent', hint: zh ? '25 周内；无交付日期客户车 100 周内' : '<25 wks; customer without request date <100 wks', target: { kind: 'schedule', alert: 'grey' } },
    { key: 'pending', n: counts.pending, bg: '#5b4bd1', fg: '#fff', title: zh ? '待排位' : 'Not placed', hint: zh ? '经销商没有空位或不在排产表' : 'No dealer slot / not in schedule', target: { kind: 'pending' } },
  ];
  for (const k of ['peach', 'green'] as const) if (counts[k]) cards.push({ key: k, n: counts[k], bg: ALERTS[k].bg, fg: ALERTS[k].fg, title: ALERTS[k][zh ? 'zh' : 'en'], hint: '', target: { kind: 'schedule', alert: k } });
  return <section className="action-panel">
    <div className="section-label">{zh ? '需要处理' : 'Needs attention'}<span>{zh ? '颜色与 Planning Schedule 的 A 列一致' : 'Colours match Planning Schedule column A'}</span></div>
    <div className="action-cards">
      {cards.map(c => <button key={c.key} className={`action-card ${c.n ? '' : 'zero'}`} onClick={() => onGo(c.target)}>
        <span className="swatch" style={{ background: c.bg, color: c.fg }}>{c.n.toLocaleString()}</span>
        <span className="action-text"><strong>{c.title}</strong><small>{c.hint}</small></span>
        <ChevronRight size={16} />
      </button>)}
    </div>
  </section>;
}
export type { Target };
