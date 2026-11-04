exec(open('inspect_updating.py',encoding='utf-8').read().split('for s in E.fromstring')[0])
from collections import Counter
for idx in [1,2,4,5]:
    root=E.fromstring(z.read(f'xl/worksheets/sheet{idx}.xml'))
    cells=root.findall('.//m:sheetData/m:row/m:c',N)
    print('SHEET',idx)
    if idx==1:
        for row in range(5,10):print('ROW',row,[(c.get('r'),value(c)) for c in cells if re.search(r'\d+',c.get('r')).group()==str(row)])
    if idx==2:
        for col in 'CFGH IJKLMPS'.replace(' ',''):
            selected=[c for c in cells if re.match('[A-Z]+',c.get('r')).group()==col and value(c) not in [None,'']]
            print('COL',col,'count',len(selected),'sample',[(c.get('r'),value(c),c.find('m:f',N).text if c.find('m:f',N) is not None else None) for c in selected[:4]])
    if idx==4: print([(c.get('r'),value(c)) for c in cells if value(c) not in [None,''] and not re.match('[ABC]',c.get('r'))])
    if idx==5:
        for col in ['A','I','R','U']:
            vals=[(c.get('r'),value(c)) for c in cells if re.match('[A-Z]+',c.get('r')).group()==col and value(c) not in [None,'']]
            print('OUTPUT',col,'n',len(vals),'first',vals[:4],'last',vals[-3:])
        print('FORMULA_COUNT',sum(c.find('m:f',N) is not None for c in cells))
for name in z.namelist():
    if name.startswith('xl/externalLinks/_rels/'):
        print('EXTERNAL',name,[x.get('Target').split('/')[-1] for x in E.fromstring(z.read(name))])
