exec(open('inspect_orderlist.py',encoding='utf-8').read().split('root,cells=read(3)')[0])
r,cs=read(14)
print('CALENDAR L NONEMPTY')
ls=[(a,val(c),c.find('m:f',N).text if c.find('m:f',N) is not None else None,dict(c.find('m:f',N).attrib) if c.find('m:f',N) is not None else {}) for a,c in cs.items() if re.match(r'L\d+$',a) and (val(c) is not None or c.find('m:f',N) is not None)]
print(ls[:12]);print(ls[-4:])
for row in [40,41,42,43,44,45,50,100,200,268]:
    print('CAL',row,[(a,val(c),c.find('m:f',N).text if c.find('m:f',N) is not None else None) for a,c in cs.items() if a in [f'{col}{row}' for col in ['C','H','I','J','K','L']]])
r,cs=read(6)
print('REFERENCE',[(a,val(c)) for a,c in cs.items() if re.match(r'[ABC]\d+$',a) and val(c) is not None][:90])
for n in ['xl/externalLinks/_rels/externalLink1.xml.rels','xl/externalLinks/externalLink1.xml']:
    rt=E.fromstring(z.read(n))
    if n.endswith('.rels'): print('EXTERNAL_TARGET',[(x.get('Target').split('/')[-1]) for x in rt])
    else:
        print('EXTERNAL_HEADERS',[(c.get('r'),''.join(c.itertext())) for c in rt.findall('.//m:row[@r="1"]/m:cell',N)][:30])
r,cs=read(3)
print('HIDDEN_COLS',[x.attrib for x in r.findall('m:cols/m:col',N) if x.get('hidden')=='1'])
print('ERROR_CELLS',[(a,val(c)) for a,c in cs.items() if c.get('t')=='e'][:15])
print('T coverage',sum(1 for a,c in cs.items() if a.startswith('T') and c.find('m:f',N) is not None), 'last', max(int(a[1:]) for a,c in cs.items() if a.startswith('T') and c.find('m:f',N) is not None))
print('VBA size',len(z.read('xl/vbaProject.bin')))
