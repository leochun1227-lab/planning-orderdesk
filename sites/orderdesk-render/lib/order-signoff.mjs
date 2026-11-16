import { toDay } from './order-engine.mjs';

/** An actual signed-plans receipt date, not a status label, PO date, yes/no flag or future placeholder. */
export function signedPlansDate(values, today = '9999-12-31') {
  for (const value of values) {
    const day = toDay(value);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) continue;
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day) return day;
  }
  return '';
}
