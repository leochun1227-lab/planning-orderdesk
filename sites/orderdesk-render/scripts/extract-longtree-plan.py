#!/usr/bin/env python3
"""Build data/longtree-plan-2026-11-12.json from the Longtree monthly plan workbooks (sheet 排产).

Usage: python3 scripts/extract-longtree-plan.py <2026年11月排产计划.xlsx> <2026年12月排产计划.xlsx> [out.json]

Order: every car of the first (November) sheet in sheet order, then the cars that only appear in the later sheet.
Dates for a car that is in both sheets come from the later sheet (the newer plan) when it has them.
Per car: 钣焊计划上线 (weldPlan), 总装计划上线 (assemblyPlan), 总装计划下线 (assemblyEndPlan), 总装计划交付 (finishPlan).
A cell like 「总装1月计划」 has no day yet: kept as a month (assemblyEndMonth / finishMonth, yyyy-mm). '/' or empty = nothing.
"""
import datetime as dt
import json
import re
import sys

import openpyxl

COL = {'seq': 2, 'chassis': 3, 'model': 5, 'type': 6, 'weld': 8, 'assembly': 36, 'assemblyEnd': 38, 'finish': 40}
CHASSIS = re.compile(r'^(SR[A-Z]|NG[A-Z])-?\d{6}$')
MONTH = re.compile(r'(\d{1,2})\s*月')


def as_date(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, (int, float)) and 40000 < v < 60000:  # Excel serial date
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    return ''


def as_month(v, sheet_month):
    """'总装1月计划' in the 2026-12 sheet → 2027-01 (months before the sheet's month roll into next year)."""
    if not isinstance(v, str):
        return ''
    m = MONTH.search(v)
    if not m:
        return ''
    mon, (sy, sm) = int(m.group(1)), sheet_month
    year = sy + 1 if mon < sm - 6 else sy
    return f'{year}-{mon:02d}'


def read(path, sheet_month):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)['排产']
    out = []
    for r in ws.iter_rows(min_row=6, values_only=True):
        c = r[COL['chassis']] if len(r) > COL['chassis'] else None
        if not (isinstance(c, str) and CHASSIS.match(c.strip().upper())):
            continue
        get = lambda k: r[COL[k]] if len(r) > COL[k] else None
        out.append({
            'seq': get('seq'), 'chassis': c.strip().upper().replace('-', ''), 'model': str(get('model') or '').strip(), 'type': str(get('type') or '').strip(),
            'weldPlan': as_date(get('weld')), 'assemblyPlan': as_date(get('assembly')),
            'assemblyEndPlan': as_date(get('assemblyEnd')), 'assemblyEndMonth': as_month(get('assemblyEnd'), sheet_month),
            'finishPlan': as_date(get('finish')), 'finishMonth': as_month(get('finish'), sheet_month),
        })
    return out


DATE_KEYS = ['weldPlan', 'assemblyPlan', 'assemblyEndPlan', 'assemblyEndMonth', 'finishPlan', 'finishMonth']


def main(nov_path, dec_path, out_path='data/longtree-plan-2026-11-12.json'):
    sheets = [('2026-11', read(nov_path, (2026, 11))), ('2026-12', read(dec_path, (2026, 12)))]
    rows, by = [], {}
    for sheet, cars in sheets:
        for i, car in enumerate(cars, 1):
            seq = int(car['seq']) if isinstance(car['seq'], (int, float)) else i  # the sheet's own 序号
            ref = f'{sheet}#{seq}'
            if car['chassis'] in by:  # also in an earlier sheet: one row; newer sheet wins for dates it has
                row = by[car['chassis']]
                row['months'].append(ref)
                for k in ('weldPlan', 'assemblyPlan'):
                    if car[k]:
                        row[k] = car[k]
                for pair in (('assemblyEndPlan', 'assemblyEndMonth'), ('finishPlan', 'finishMonth')):
                    if any(car[k] for k in pair):
                        for k in pair:
                            row[k] = car[k]
                continue
            row = {'chassis': car['chassis'], 'order': len(rows) + 1, 'sheet': sheet, 'seq': seq, 'model': car['model'], 'type': car['type'], 'months': [ref], **{k: car[k] for k in DATE_KEYS}}
            rows.append(row)
            by[car['chassis']] = row
    doc = {
        'name': 'Longtree 2026年11月 / 12月排产计划',
        'files': ['2026年11月排产计划（20261104 版）', '2026年12月排产计划（20261202 版）'],
        'note': '一次性快照：排产按这个顺序；11 月表在前，12 月表新增的车接在后面。同一台车出现在两个月的表里只算一次，日期取较新的 12 月表。'
                '国内计划下线 = 总装计划交付日期（没有就用总装计划下线日期）；只写了「总装1月计划」之类的记月份，没有就空。',
        'activeUntil': '2026-12-31',
        'rows': rows,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(len(rows), 'cars →', out_path)


if __name__ == '__main__':
    main(*sys.argv[1:])
