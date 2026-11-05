"""Extract the Orderlist rows (in order, including reserved empty slots) and the Calendar
from a Planning Schedule .xlsm into JSON for scripts/rebaseline-from-planning-schedule.mjs.

    python scripts/extract-planning-schedule.py "Planning Schedule 2025 (4).xlsm" planning-schedule.json

Uses the workbook's cached values (what Excel last calculated); it never recalculates.
"""
import datetime, json, sys
import openpyxl

src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, read_only=True, data_only=True)

def val(v):
    if v is None: return None
    if isinstance(v, datetime.datetime): return v.strftime('%Y-%m-%d')
    if isinstance(v, float) and v.is_integer(): v = int(v)
    s = str(v).strip()
    return s or None

cols = 'ABCDEFGHIJKLMNOPQRST'
rows = []
for excel_row, r in enumerate(wb['Orderlist'].iter_rows(min_row=2, max_col=20, values_only=True), 2):
    cells = {c: val(v) for c, v in zip(cols, r)}
    if not any(cells[c] for c in 'GI'):   # neither an order nor a dealer slot
        continue
    rows.append({'excelRow': excel_row, **cells})

weeks = []
for excel_row, r in enumerate(wb['Calendar'].iter_rows(min_row=4, max_row=268, max_col=12, values_only=True), 4):
    _, _, C, _, _, _, _, H, I, J, K, L = r
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    weeks.append({'row': excel_row, 'monday': val(C), 'workingDays': num(H), 'daily': num(I), 'weekly': num(J), 'modification': num(K), 'start': num(L)})

last = rows[-1]['excelRow'] if rows else 1
if any(r['excelRow'] != i + 2 for i, r in enumerate(rows)):
    gaps = [r['excelRow'] for i, r in enumerate(rows) if r['excelRow'] != i + 2][:5]
    print('note: Orderlist has fully empty rows before row', last, 'first at', gaps, file=sys.stderr)
json.dump({'source': src.split('/')[-1], 'rows': rows, 'calendar': {'weeks': weeks}}, open(out, 'w'))
print(f'{len(rows)} rows (last Excel row {last}), {sum(1 for r in rows if r["G"])} orders, '
      f'{sum(1 for r in rows if not r["G"])} empty slots, {len(weeks)} calendar weeks')
