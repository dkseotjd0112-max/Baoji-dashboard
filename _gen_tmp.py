import pandas as pd, numpy as np, json, os, datetime as dt, html
D=os.path.expanduser('~/mnt/baoji-dashboard')
F=D+'/data_admin.xlsx'
x=pd.read_excel(F,sheet_name=None)
r=x['재고현황'].copy(); o=x['주문로그'].copy()
o['날짜']=pd.to_datetime(o['날짜']).dt.normalize()
now=dt.datetime.utcnow()+dt.timedelta(hours=9)
today=pd.Timestamp(now.date()); yest=today-pd.Timedelta(days=1)
dates=sorted(o['날짜'].unique())
if yest in dates: ref=yest; subst=''
else:
    ref=pd.Timestamp(dates[-1])
    subst=f"실제 어제({yest:%Y-%m-%d}) 데이터가 없어 최근 영업일({ref:%Y-%m-%d}) 기준으로 대체했습니다."
prev=max(d for d in dates if d<ref)
CH={'카페24/바오지':'자사몰','아이두젠카페24':'자사몰','체크아웃/바오지':'자사몰','체크아웃':'자사몰','스토어팜/바오지':'스토어팜','스토어팜':'스토어팜','아이두젠':'아이두젠몰','아이두젠CS':'아이두젠몰','쿠팡로켓':'쿠팡로켓','쿠팡그로스':'쿠팡그로스','쿠팡/알파플러스':'쿠팡그로스','알리':'알리'}
o['채널']=o['판매처'].map(CH)
unm=o[o['채널'].isna()].groupby('판매처')['수량'].sum()
o['채널']=o['채널'].fillna(o['판매처'])
price=r.set_index('상품코드')['온라인판매가']
o['단가']=o['상품코드'].map(price)
o['매출']=o['수량']*o['단가']
unmatched_rows=int(o['단가'].isna().sum()); unmatched_units=int(o.loc[o['단가'].isna(),'수량'].sum()); tot_units=int(o['수량'].sum())
s=o[o['출고유형']=='일반판매']
n=lambda v:f"{int(round(v)):,}"
def pct(c,p):
    if p==0: return ('신규' if c>0 else '-','new' if c>0 else 'neu')
    v=(c-p)/p*100
    return (f"{v:+.1f}%", 'up' if v>0 else 'down' if v<0 else 'neu')
def pc(c,p):
    t,k=pct(c,p); return f'<span class="{k}">{t}</span>'
def table(h,rows):
    return '<table><tr>'+''.join(f'<th>{a}</th>' for a in h)+'</tr>'+''.join('<tr>'+''.join(f'<td>{c}</td>' for c in row)+'</tr>' for row in rows)+'</table>'
e=html.escape
charts=[]
def chart(cid,cap,cfg):
    charts.append((cid,cfg))
    return f'<div class="cap">{cap}</div><div class="cw"><canvas id="{cid}"></canvas></div>'
def bar(labels,sets,horiz=False,stack=False):
    return {'type':'bar','data':{'labels':labels,'datasets':sets},'options':{'indexAxis':'y' if horiz else 'x','responsive':True,'maintainAspectRatio':False,'animation':False,'plugins':{'legend':{'display':len(sets)>1}},'scales':{'x':{'stacked':stack},'y':{'stacked':stack,'beginAtZero':True}}}}
BL,GR,RD,GY='#2f6db5','#1e8a4c','#c0392b','#9aa5b1'
def ds(lbl,data,col): return {'label':lbl,'data':[float(v) for v in data],'backgroundColor':col}

# ① 발주 필요
need=r[r['발주필요']=='발주필요']
n_need=len(need)
by=need.groupby('모델명')['부족수량'].sum().sort_values(ascending=False).head(8)
t5=need.sort_values('부족수량',ascending=False).head(5)
sec1=f'<div class="warnbox">안전재고 미설정 — 2개월판매 기준으로 대체 판정: 안전재고가 전체 {len(r)}개 SKU에서 0이라 발주필요 판정은 시스템 값(발주필요 컬럼)을 그대로 쓰며, 2개월판매 기준 부족수량입니다. 2개월판매에는 체험단·샘플발송·CS출고가 포함돼 있어 필요량이 과대 계상됐을 수 있습니다.</div>'
if n_need==0: sec1='<div class="none">특이사항 없음</div>'
else:
    sec1+=f'<p class="interp">발주필요 SKU는 {n_need}개, 부족수량 합계 {n(need["부족수량"].sum())}개입니다. 상위 모델 {by.index[0]}({n(by.iloc[0])}개)부터 OEM 발주 수량을 검토하세요.</p>'
    sec1+=chart('c1','어느 모델이 가장 많이 부족한가? (부족수량 합계, 상위 8 모델)',bar(list(by.index),[ds('부족수량',by.values,RD)],True))
    sec1+=table(['상품코드','상품명','브랜드','현재고','부족수량'],[[e(str(a.상품코드)),e(str(a.상품명)),e(str(a.브랜드)),n(a.현재고),n(a.부족수량)] for a in t5.itertuples()])

# ② 소진임박
r['d7']=r['최근7일판매']/7
r['d60']=r['2개월판매']/60
r['rate']=np.where(r['최근7일판매']>0,r['d7'],r['d60'])
r['src']=np.where(r['최근7일판매']>0,'7일','60일')
r['days']=np.where(r['rate']>0,r['현재고']/r['rate'].replace(0,np.nan),np.nan)
fl=r[(r['rate']>0)&(r['days']<=7)].copy()
n_fl=len(fl)
if n_fl==0: sec2='<div class="none">특이사항 없음</div>'
else:
    fb=fl.groupby('브랜드').size().sort_values(ascending=False)
    fm=fl.groupby('모델명').size().sort_values(ascending=False).head(8)
    u=fl.sort_values('days').head(5)
    n7=int((fl['src']=='7일').sum())
    sec2=f'<p class="interp">현재 속도 기준 7일 내 소진 SKU가 {n_fl}개({n7}개는 최근 7일 속도, {n_fl-n7}개는 60일 평균 대체)입니다. 7일 속도는 프로모션 직후 긴급도를 과대평가할 수 있어 소진일수 하위 SKU부터 재고·입고 일정을 대조하세요.</p>'
    sec2+='<div class="two"><div>'+chart('c2a','어느 브랜드에 소진임박이 몰려 있나? (SKU 수)',bar(list(fb.index),[ds('SKU',fb.values,BL)]))+'</div><div>'+chart('c2b','어느 모델이 가장 급한가? (SKU 수, 상위 8)',bar(list(fm.index),[ds('SKU',fm.values,BL)],True))+'</div></div>'
    sec2+=table(['상품코드','상품명','현재고','dailyRate','소진일수','속도 기준'],[[e(str(a.상품코드)),e(str(a.상품명)),n(a.현재고),f'{a.rate:.2f}',f'{a.days:.1f}',a.src+(' (대체)' if a.src=='60일' else '')] for a in u.itertuples()])

# ③ 판매 동향
last14=dates[-14:]; cur=last14[-7:]; pre=last14[:7] if len(last14)>=14 else dates[:-7]
sc=s[s['날짜'].isin(cur)]; sp=s[s['날짜'].isin(pre)]
dq=s[s['날짜'].isin(last14)].groupby('날짜')['수량'].sum().reindex(last14,fill_value=0)
cols=[GY]*len(pre)+[BL]*len(cur)
cA=bar([d.strftime('%m-%d') for d in last14],[{'label':'일반판매 수량','data':[float(v) for v in dq.values],'backgroundColor':cols}])
bq=pd.DataFrame({'cur':sc.groupby('브랜드')['수량'].sum(),'pre':sp.groupby('브랜드')['수량'].sum()}).fillna(0)
cB=bar(list(bq.index),[ds(f'직전 구간',bq['pre'],GY),ds('최근 구간',bq['cur'],BL)])
mq=pd.DataFrame({'cur':sc.groupby('모델명')['수량'].sum(),'pre':sp.groupby('모델명')['수량'].sum()}).fillna(0).sort_values('cur',ascending=False).head(5)
chq=pd.DataFrame({'cur':sc.groupby('채널')['수량'].sum(),'pre':sp.groupby('채널')['수량'].sum()}).fillna(0).sort_values('cur',ascending=False)
raw=o.groupby('채널')['판매처'].apply(lambda v:', '.join(sorted(set(v))))
tc,tp=sc['수량'].sum(),sp['수량'].sum()
win=f'최근 구간 {cur[0]:%Y-%m-%d}~{cur[-1]:%Y-%m-%d} (판매일 {len(cur)}일) vs 직전 구간 {pre[0]:%Y-%m-%d}~{pre[-1]:%Y-%m-%d} (판매일 {len(pre)}일)'
sec3=f'<div class="notebox">{win}. 일반판매만 집계(체험단·샘플발송 등 제외). 판매 데이터가 있는 날짜 기준 구간이며 달력 7일이 아닙니다.</div>'
sec3+=f'<p class="interp">최근 구간 일반판매 {n(tc)}개로 직전 구간({n(tp)}개) 대비 {pct(tc,tp)[0]}입니다. 증감을 이끈 브랜드·모델은 아래 표에서 확인하세요.</p>'
sec3+='<div class="two"><div>'+chart('c3a','최근 14 판매일 일별 판매량은? (회색=직전, 파랑=최근)',cA)+'</div><div>'+chart('c3b','브랜드별 판매량이 직전 대비 어떻게 달라졌나?',cB)+'</div></div>'
sec3+='<h3>모델명 TOP5 (일반판매)</h3>'+table(['모델명','최근','직전','변화'],[[e(str(i)),n(a.cur),n(a.pre),pc(a.cur,a.pre)] for i,a in mq.iterrows()])
sec3+='<h3>판매처 (정규화)</h3>'+table(['판매처','수량','비중','직전','변화','포함된 원본 표기'],[[e(str(i)),n(a.cur),f'{a.cur/tc*100:.1f}%' if tc else '-',n(a.pre),pc(a.cur,a.pre),e(raw[i])] for i,a in chq.iterrows()])
if len(unm): sec3+='<div class="notebox">미분류 판매처(매핑 추가 필요, 원본 유지): '+e(', '.join(f'{k}({int(v)}개)' for k,v in unm.items()))+'</div>'
nr=o[o['출고유형'].isin(['체험단','샘플발송'])]
nc=nr[nr['날짜'].isin(cur)]['수량'].sum(); npv=nr[nr['날짜'].isin(pre)]['수량'].sum()
sec3+=f'<div class="sub">비매출(체험단+샘플발송) 최근 구간 {n(nc)}개 / 직전 구간 {n(npv)}개 — 매출 집계에서 제외.</div>'

# ④ 재고 부담
dm=r[(r['최근7일판매']==0)&(r['2개월판매']==0)&(r['현재고']>0)].copy()
cost='입고단가' in r.columns and r['입고단가'].notna().any()
vc='입고단가' if cost else '온라인판매가'
dm['val']=dm['현재고']*dm[vc].fillna(0)
lab='입고단가 기준' if cost else '판매가 기준 (not cost)'
if len(dm)==0: sec4='<div class="none">특이사항 없음</div>'
else:
    dmm=dm.groupby('모델명')['현재고'].sum().sort_values(ascending=False).head(8)
    top=dm.sort_values('현재고',ascending=False).head(5)
    sec4=f'<p class="interp">최근 7일·2개월 모두 판매 0인 재고 SKU는 {len(dm)}개(전체 {len(r)}개의 {len(dm)/len(r)*100:.1f}%), 묶인 수량 {n(dm["현재고"].sum())}개, 금액 {n(dm["val"].sum())}원({lab})입니다. 상위 모델부터 프로모션·이관·발주 보류 여부를 판단하세요.</p>'
    sec4+=chart('c4','어느 모델에 안 팔리는 재고가 많은가? (현재고 수량, 상위 8)',bar(list(dmm.index),[ds('현재고',dmm.values,GY)],True))
    sec4+=table(['상품코드','상품명','현재고','금액('+('입고단가' if cost else '판매가')+')'],[[e(str(a.상품코드)),e(str(a.상품명)),n(a.현재고),n(a.val)] for a in top.itertuples()])
    sec4+=f'<div class="sub">정의: 최근7일판매==0 AND 2개월판매==0 AND 현재고>0 (안전재고 미설정으로 대체한 규칙).</div>'

# ⑤ 전일 매출
R=s[s['날짜']==ref]; P=s[s['날짜']==prev]
def agg(df): return df['수량'].sum(),df['매출'].sum(),len(df)
rq,rv,rl=agg(R); pq,pv,pl=agg(P)
un_ref_u=int(R.loc[R['단가'].isna(),'수량'].sum()); un_ref_share=un_ref_u/rq*100 if rq else 0
head=f'기준일 {ref:%Y-%m-%d} vs 비교일 {prev:%Y-%m-%d}'
sec5=''
if subst: sec5+=f'<div class="notebox">{subst}</div>'
if un_ref_share>5 or unmatched_units/tot_units>0.05:
    sec5+=f'<div class="warnbox"><b>경고: 매출 누락 가능성.</b> 상품코드가 재고현황과 매칭되지 않아 단가를 알 수 없는 행이 전체 {unmatched_rows:,}행·{unmatched_units:,}개(전체 수량의 {unmatched_units/tot_units*100:.1f}%)입니다. 기준일 일반판매 중 미매칭 수량은 {un_ref_u:,}개({un_ref_share:.1f}%). 해당 행의 매출은 0원으로 집계됩니다.</div>'
else: sec5+=f'<div class="notebox">상품코드 미매칭: {unmatched_rows}행 / {unmatched_units}개 (전체 수량의 {unmatched_units/tot_units*100:.1f}%).</div>'
sec5+=f'<p class="interp">{head}: 일반판매 수량 {n(rq)}개({pct(rq,pq)[0]}), 매출 {n(rv)}원({pct(rv,pv)[0]}), 주문 {rl}건. 매출은 일반판매(수량×온라인판매가)만이며 체험단·샘플발송은 비매출입니다.</p>'
def kpi(l,v,d,k): return f'<div class="kpi"><div class="l">{l}</div><div class="v">{v}</div><div class="d"><span class="{k}">{d}</span> <span class="neu">(비교일 {{}})</span></div></div>'
tiles=''
for l,c,p,u in [('수량',rq,pq,'개'),('매출액',rv,pv,'원'),('주문 건수',rl,pl,'건')]:
    t,k=pct(c,p); tiles+=f'<div class="kpi"><div class="l">{l}</div><div class="v">{n(c)}{u}</div><div class="d"><span class="{k}">{t}</span> <span class="neu">비교일 {n(p)}{u}</span></div></div>'
sec5+=f'<div class="kpis3">{tiles}</div>'
bb=pd.DataFrame({'q':R.groupby('브랜드')['수량'].sum(),'v':R.groupby('브랜드')['매출'].sum(),'pq':P.groupby('브랜드')['수량'].sum(),'pv':P.groupby('브랜드')['매출'].sum()}).fillna(0)
sec5+='<div class="two"><div>'+chart('c5a','브랜드별 매출이 비교일 대비 어떻게 달라졌나? (원)',bar(list(bb.index),[ds(f'비교일 {prev:%m-%d}',bb['pv'],GY),ds(f'기준일 {ref:%m-%d}',bb['v'],BL)]))+'</div>'
def top5(df,col):
    g=df.groupby(col)['매출'].sum().sort_values(ascending=False)
    t=g.head(5).copy()
    if len(g)>5: t['기타']=g.iloc[5:].sum()
    return t
tc5=top5(R,'카테고리')
sec5+='<div>'+chart('c5b','어떤 카테고리가 매출을 만들었나? (기준일, 상위 5 + 기타)',bar(list(tc5.index),[ds('매출',tc5.values,BL)],True))+'</div></div>'
sec5+='<h3>브랜드별 실적</h3>'+table(['브랜드','수량','매출액(원)','수량 증감','매출 증감'],[[e(str(i)),n(a.q),n(a.v),pc(a.q,a.pq),pc(a.v,a.pv)] for i,a in bb.iterrows()])
tm=top5(R,'모델명')
sec5+='<h3>모델명 매출 TOP5 + 기타</h3>'+table(['모델명','기준일 매출(원)'],[[e(str(i)),n(v)] for i,v in tm.items()])
ty=o[o['날짜']==ref].groupby('출고유형')['수량'].sum()
main=['일반판매','체험단','샘플발송']
tyr={k:int(ty.get(k,0)) for k in main}; tyr['기타']=int(ty.drop([k for k in main if k in ty.index]).sum())
sec5+='<h3>출고유형별 수량</h3>'+table(['출고유형','수량','구분'],[[k,n(v),'매출 집계' if k=='일반판매' else '비매출' if k in('체험단','샘플발송') else '기타(비매출 포함)'] for k,v in tyr.items()])
if rq==0 and rl==0: sec5='<div class="none">특이사항 없음</div>'

# KPI strip
t,k=pct(rv,pv)
strip=''.join(f'<div class="kpi"><div class="l">{l}</div><div class="v">{v}</div><div class="d {kk}">{d}</div></div>' for l,v,d,kk in [('발주필요 건수',f'{n_need}건',f'부족수량 합 {n(need["부족수량"].sum())}','neu'),('소진임박 건수',f'{n_fl}건','7일 내 소진 예상','neu'),(f'기준일({ref:%m-%d}) 매출액',f'{n(rv)}원',f'수량 {n(rq)}개','neu'),('전일 대비 증감률',t,f'비교일 {prev:%m-%d} 매출 {n(pv)}원',k)])
mt=dt.datetime.fromtimestamp(os.path.getmtime(F))+dt.timedelta(hours=0)
foot=f'데이터: data_admin.xlsx · 수정 {mt:%Y-%m-%d %H:%M} · 재고현황 {len(r):,}행 / 주문로그 {len(o):,}행 · 주문로그 판매일 {len(dates)}일({dates[0]:%Y-%m-%d}~{dates[-1]:%Y-%m-%d}) · 생성 {now:%Y-%m-%d %H:%M} KST'
if ref<today-pd.Timedelta(days=2): foot+=f' · 주의: 데이터 최신일이 {ref:%Y-%m-%d}로 실행일보다 오래됨'
css=open(D+'/daily_briefing_2026-10-01.html',encoding='utf-8').read().split('<style>')[1].split('</style>')[0]
css+='.cw{position:relative;height:240px}.warnbox,.notebox{font-size:13px}.foot{font-size:11px;color:#6b7480;margin-top:16px}@media print{body{padding:0}}@page{size:A4}'
cards=[('① 발주 필요',sec1),('② 소진임박 경고',sec2),('③ 판매 동향 (최근 7 판매일)',sec3),('④ 재고 부담 (재고과다 주의)',sec4),(f'⑤ 전일 매출 실적 — {head}',sec5)]
body=''.join(f'<div class="card"><h2>{a}</h2>{b}</div>' for a,b in cards)
js=''.join(f'new Chart(document.getElementById("{i}"),{json.dumps(c,ensure_ascii=False)});' for i,c in charts)
out=f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>일일 판매·재고 브리핑 {ref:%Y-%m-%d}</title><style>{css}</style></head><body><h1>일일 판매·재고 브리핑 — {ref:%Y-%m-%d}</h1><div class="sub">바오지 · 아이두젠 · 볼트겔 / 일반판매 기준, 체험단·샘플발송은 비매출</div><div class="kpis">{strip}</div>{body}<div class="foot">{foot}</div><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script><script>{js}</script></body></html>'
p=f'{D}/daily_briefing_{ref:%Y-%m-%d}.html'
open(p,'w',encoding='utf-8').write(out)
print(p,n_need,n_fl,rv,t,subst,len(dm),unmatched_units,tot_units)
