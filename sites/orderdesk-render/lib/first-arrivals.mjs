import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const solver = fileURLToPath(new URL('./first_arrivals.py', import.meta.url));
const python = fileURLToPath(new URL('../.solver/bin/python', import.meta.url));
export const firstRangeStock = a => String(a.modelYear) === '2027' && a.policy === 'display' && /^(SRC|SRP)/i.test(a.model);

export function planFirstArrivals({today, end, dealers, locked, following, actions, assumptions, signed}) {
  if (today > '2027-12-31') return [];
  const jobs = [...locked.map(a => ({...a, schedulePart:'locked'})), ...following.map(a => ({...a, schedulePart:'following'}))]
    .filter(firstRangeStock).sort((a,b) => a.slotOrder-b.slotOrder).map(a => ({...a, signed:signed(a)}));
  if (!jobs.length) return [];
  const ids = new Set(jobs.map(a => a.chassis));
  const fixed = [...actions.filter(a => !following.some(v => v.chassis===a.chassis)), ...following]
    .filter(a => !ids.has(a.chassis) && a.receive && a.plannedArrival && !['pool','cancel'].includes(a.action));
  const input = {today, planningEnd:end, dealers:dealers.map(({slug,lead,target,cap,weeklyStock,assumptions,my2027Yard}) =>
    ({slug,lead,target,cap,weeklyStock,assumptions,my2027Yard})), jobs, fixed, originals:actions.filter(firstRangeStock), assumptions:{finishDates:assumptions.finishDates,exchangeSlots:assumptions.exchangeSlots}};
  const output = execFileSync(existsSync(python) ? python : 'python3', [solver], {
    input:JSON.stringify(input), encoding:'utf8', timeout:55000, maxBuffer:8*1024*1024, env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}
  });
  return JSON.parse(output);
}
