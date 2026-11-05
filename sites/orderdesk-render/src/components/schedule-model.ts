import { forecastResolver } from '@/lib/schedule.mjs';
import { alertFor, dueUnsigned, excelCells, requestMismatch, ALERTS } from '@/lib/schedule-colors.mjs';
import { isOverdue } from '@/lib/order-engine.mjs';

export type Order = Record<string, any>;
export type AlertKey = keyof typeof ALERTS;
export type ScheduleRow = {
  id: string;                 // order id or slot:<excelRow>
  excelRow: number;
  forecastDate: string | null;
  dealer: string | null;
  order: Order | null;
  alert: AlertKey | null;
  due: boolean;               // yellow-bold row rule
  mismatch: boolean;          // B column rule
  weekStart: boolean;         // first row of a production week
  finished: boolean;
  kind?: 'campervan' | 'pending' | 'cancelled' | 'other';   // set on rows that are not Orderlist rows
};

export function buildSchedule(data: any, today: string): ScheduleRow[] {
  if (!data?.schedule?.rows) return [];
  const byId = new Map<string, Order>(data.orders.map((o: Order) => [o.id, o]));
  const forecast = forecastResolver(data.calendar);
  let prevWeek: string | null = null;
  return data.schedule.rows.map(([chassis, dealer]: [string | null, string | null], i: number) => {
    const excelRow = i + 2;
    const forecastDate = forecast(excelRow);
    const order = chassis ? byId.get(chassis) || null : null;
    const cells = excelCells({ forecastDate, order });
    const weekStart = forecastDate !== prevWeek; prevWeek = forecastDate;
    return {
      id: order ? order.id : `slot:${excelRow}`, excelRow, forecastDate, dealer, order,
      alert: alertFor(cells, today) as AlertKey | null, due: dueUnsigned(cells, today), mismatch: requestMismatch(cells),
      weekStart, finished: order?.productionStatus === 'Finished' || order?.status === 'completed',
    };
  });
}

/** Orders that have no Orderlist row (campervans, not placed, cancelled), as table rows. */
export function buildExtraRows(data: any, plan: Record<string, any> | undefined, today: string): ScheduleRow[] {
  if (!data?.orders) return [];
  const inRows = new Set((data.schedule?.rows || []).map((r: [string | null]) => r[0]).filter(Boolean));
  const pending = new Set(data.schedule?.pending || []);
  return data.orders.filter((o: Order) => !inRows.has(o.id)).map((o: Order) => {
    const camper = o.group === 'campervan' || /^SR[VM]/.test(String(o.id));
    const kind = o.status === 'cancelled' ? 'cancelled' : camper ? 'campervan' : pending.has(o.id) ? 'pending' : 'other';
    const forecastDate = camper ? (plan?.[o.id]?.forecastDate ?? o.forecastDate ?? null) : o.forecastDate ?? null;
    return { id: o.id, excelRow: 0, forecastDate, dealer: o.dealer, order: o, alert: null, due: false, mismatch: false, weekStart: false,
      finished: o.status === 'completed' || o.productionStatus === 'Finished', kind } as ScheduleRow;
  }).sort((a: ScheduleRow, b: ScheduleRow) => String(a.forecastDate || '9999').localeCompare(String(b.forecastDate || '9999')) || String(a.order?.chassis).localeCompare(String(b.order?.chassis)));
}

export type ActionCounts = Record<AlertKey | 'overdue' | 'pending', number>;
export function actionCounts(rows: ScheduleRow[], data: any, today: string): ActionCounts {
  const counts = Object.fromEntries(Object.keys(ALERTS).map(k => [k, 0])) as ActionCounts;
  for (const r of rows) if (r.alert) counts[r.alert]++;
  counts.overdue = (data?.orders || []).filter((o: Order) => isOverdue(o, today)).length;
  counts.pending = data?.schedule?.pending?.length || 0;
  return counts;
}

export { ALERTS };
