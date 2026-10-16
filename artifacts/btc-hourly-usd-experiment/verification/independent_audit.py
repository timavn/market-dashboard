#!/usr/bin/env python3
"""Independent source reconstruction; does not import production research calculations."""
import csv,json,math,hashlib
from collections import Counter
from datetime import datetime,timedelta,timezone
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'artifacts/btc-hourly-usd-experiment'
BASE=ROOT/'artifacts/btc-hourly-bias-experiment'
H=timedelta(hours=1)
def when(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
def iso(d): return d.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
def readcsv(p): return list(csv.DictReader(p.open()))
def rows(p): return json.loads(p.read_text())['rows']
def number(v): return float(v) if v!='' and v is not None else None
def corr(x,y):
 if len(x)<2 or min(np.var(x),np.var(y))<=0: return None
 return float(np.corrcoef(x,y)[0,1])
def close(a,b): return a is None and b is None or a is not None and b is not None and math.isclose(a,b,rel_tol=1e-10,abs_tol=1e-10)

dh=rows(OUT/'source-usd/hourly.json'); dd=rows(OUT/'source-usd/daily-dxy.json'); bd=rows(OUT/'source-usd/daily-btc.json')
D={when(r['endAt']):r for r in dh}; bmap={r['date']:r for r in bd}
btc=readcsv(BASE/'hourly-observations.csv'); observed=readcsv(OUT/'hourly-observations.csv')
B={when(r['endAt']):r for r in btc}; btc_by_start={r['hourStart']:r for r in btc}
assert len(D)==len(dh) and len(B)==len(btc) and len(observed)==len(btc)
daily=[]; paired=[]
for d in dd:
 if d['date'] not in bmap: continue
 b=bmap[d['date']]; paired.append((d['close'],b['close']))
 daily.append({'available':max(when(d['availableAt']),when(b['availableAt']))+H,'date':d['date'],
               'corr15Level':corr(*zip(*paired[-15:])) if len(paired)>=15 else None,
               'corr30Level':corr(*zip(*paired[-30:])) if len(paired)>=30 else None})
returns=[]
for t in sorted(D.keys() & B.keys()):
 if t-H in D and t-H in B:
  returns.append((t,D[t]['close']/D[t-H]['close']-1,float(B[t]['close'])/float(B[t-H]['close'])-1))
checks=Counter(); errors=[]; rebuilt=[]
for r in observed:
 t=when(r['hourStart']); e=t-H; p=D.get(e); day=[d for d in daily if d['available']<=t][-1]
 f={'corr15Level':day['corr15Level'],'corr30Level':day['corr30Level'],'usdSessionMoveBp':None,'usdHourMoveBp':None,'corr120Return':None}
 assert day['date']==r['corrSourceDate'] and iso(day['available'])==r['corrAvailableAt']
 if p:
  assert iso(e)==r['usdObservedAt'] and iso(e+H)==r['usdAvailableAt'] and e+H<=t
  prev=D.get(e-H)
  if prev: f['usdHourMoveBp']=(p['close']/prev['close']-1)*10000
  refs=[d for d in dd if when(d['endAt'])<e and when(d['availableAt'])+H<=t]
  if refs:
   ref=refs[-1]; f['usdSessionMoveBp']=(p['close']/ref['close']-1)*10000
   assert ref['date']==r['usdSessionCloseDate'] and when(r['usdReferenceAvailableAt'])<=t
 else: assert not r['usdObservedAt']
 ret=[x for x in returns if x[0]<=e][-120:]; ret=[x for x in ret if x[0]>=e-timedelta(days=21)]
 if len(ret)==120: f['corr120Return']=corr([x[1] for x in ret],[x[2] for x in ret])
 assert len(ret)==int(r['corr120ReturnCount'])
 assert (r['indicatorEligible']=='True')==(p is not None)
 for k,v in f.items():
  checks[k]+=1
  if not close(v,number(r[k])): errors.append({'hour':r['hourStart'],'field':k,'expected':v,'observed':number(r[k])})
 original=btc_by_start[r['hourStart']]
 for k in ['open','close','direction','trend','signalAvailableAt','currentBullishRun']:
  assert original[k]==r[k]
 assert not r['signalAvailableAt'] or when(r['signalAvailableAt'])<=t
 rebuilt.append({**r,**f,'eligible':p is not None,'returnPct':float(r['returnPct'])})
assert not errors,errors[:5]

def cohort(r,g):
 return {'Current bullish run':r['currentBullishRun']=='True','All bullish periods':r['trend']=='BULLISH','Bearish periods':r['trend']=='BEARISH','Neutral periods':r['trend']=='NEUTRAL','All known-signal hours':r['trend']!='UNKNOWN'}[g]
def eligible(r,s): return r['eligible'] and r[s['correlationField']] is not None and r[s['moveField']] is not None
def choose(r,s):
 if not eligible(r,s) or r[s['correlationField']]>float(s['correlationMax'])+1e-12: return False
 x=r[s['moveField']]; b=float(s['minimumMoveBp'])
 return x>=b-1e-9 if s['usdDirection']=='UP' else x<=-b+1e-9
stats=readcsv(OUT/'statistics.csv'); group_errors=[]; selections={}
for s in stats:
 pool=[r for r in rebuilt if cohort(r,s['cohort']) and eligible(r,s)]
 cor=[r for r in pool if r[s['correlationField']]<=float(s['correlationMax'])+1e-12]
 selected=[r for r in cor if choose(r,s)]; counts=Counter(r['direction'] for r in selected)
 expected={'hours':len(selected),'days':len({r['pacificDay'] for r in selected}),'up':counts['UP'],'down':counts['DOWN'],'unchanged':counts['UNCHANGED'],'eligibleHours':len(pool),'negativeCorrelationHours':len(cor)}
 for k,v in expected.items():
  if int(s[k])!=v: group_errors.append([s['variation'],s['cohort'],s['usdDirection'],k,v,s[k]])
 selections[(s['variation'],s['cohort'],s['usdDirection'])]=selected
assert not group_errors,group_errors

sett=readcsv(BASE/'settlement-changes.csv'); S={r['hourStart']:r for r in sett}; assert len(S)==len(sett)
official=rows(BASE/'source-prices/settlements.json'); official_by_event={r['eventTicker']:r for r in official}
assert len(official_by_event)==len(official)
for r in sett:
 assert when(r['endAt'])-when(r['hourStart'])==H
 assert close(float(r['returnPct']),(float(r['settlement'])/float(r['previousSettlement'])-1)*100)
 current=official_by_event[r['eventTicker']]; previous=official_by_event[r['previousEventTicker']]
 assert current['status']==previous['status']=='finalized'
 assert current['closeAt']==r['endAt'] and previous['closeAt']==r['hourStart']
 assert float(r['settlement'])==current['value'] and float(r['previousSettlement'])==previous['value']

# Independent daily-block bootstrap only for the official-settlement verification.
def summary(rs,name):
 c=Counter(r['direction'] for r in rs); d=sorted({r['pacificDay'] for r in rs}); n=len(rs)
 rets=[float(r['returnPct']) for r in rs]
 result={'hours':n,'days':len(d),'up':c['UP'],'down':c['DOWN'],'unchanged':c['UNCHANGED'],
 'upPct':c['UP']/n*100 if n else None,'downPct':c['DOWN']/n*100 if n else None,
 'meanReturnPct':float(np.mean(rets)) if n else None,'medianReturnPct':float(np.median(rets)) if n else None,
 'limitedSample':n<30 or len(d)<10,'upPct95':None}
 if len(d)>1:
  b=np.array([[sum(r['pacificDay']==day for r in rs),sum(r['pacificDay']==day and r['direction']=='UP' for r in rs)] for day in d])
  seed=20260915^int.from_bytes(hashlib.sha256(name.encode()).digest()[:4],'little')
  x=np.random.default_rng(seed).integers(0,len(d),(10000,len(d))); t=b[x].sum(axis=1)
  result['upPct95']=np.percentile(100*t[:,1]/t[:,0],[2.5,97.5]).tolist()
 return result

brti=[]; stability=[]
for variation in ['main','hour_move']:
 for group in ['All bullish periods','Current bullish run']:
  for direction in ['DOWN','UP']:
   key=(variation,group,direction); select=selections[key]; match=[S[r['hourStart']] for r in select if r['hourStart'] in S]
   for r in match:
    original=btc_by_start[r['hourStart']]
    assert r['endAt']==original['endAt'] and r['trend']==original['trend'] and r['currentBullishRun']==original['currentBullishRun']
   r={'variation':variation,'cohort':group,'usdDirection':direction,'coinbaseSelectedHours':len(select),'missingOfficialPairs':len(select)-len(match),**summary(match,'|'.join(key))}
   r['coinbaseSameMatchedHours']=summary([x for x in select if x['hourStart'] in S],'coinbase|'+'|'.join(key))
   r['eventTickers']=[x['eventTicker'] for x in match]
   r['rawResponses']=sorted({p for x in match for k in ['rawResponses','previousRawResponses'] for p in json.loads(x[k])})
   brti.append(r)
   if variation=='hour_move':
    daycounts=Counter(x['pacificDay'] for x in select); months=Counter(x['pacificDay'][:7] for x in select)
    stable={'cohort':group,'usdDirection':direction,**summary(select,'stability|'+'|'.join(key)),
      'topDays':[{'date':d,'hours':n} for d,n in daycounts.most_common(10)],'monthCounts':dict(sorted(months.items())),
      'largestDaySharePct':100*max(daycounts.values())/len(select) if select else None,
      'earlier':summary([x for x in select if x['hourStart']<'2026-02-20T00:00:00Z'],'early|'+'|'.join(key)),
      'later':summary([x for x in select if x['hourStart']>='2026-02-20T00:00:00Z'],'late|'+'|'.join(key)),
      'observations':[{'hourStart':x['hourStart'],'usdObservedAt':x['usdObservedAt'],'usdAvailableAt':x['usdAvailableAt'],
                       'corrAvailableAt':x['corrAvailableAt'],'usdHourMoveBp':x['usdHourMoveBp'],'corr30Level':x['corr30Level'],
                       'btcDirection':x['direction'],'btcReturnPct':x['returnPct']} for x in select]}
    stability.append(stable)
inputs=[OUT/'source-usd/hourly.json',OUT/'source-usd/daily-dxy.json',OUT/'source-usd/daily-btc.json',OUT/'hourly-observations.csv',OUT/'statistics.csv',BASE/'hourly-observations.csv',BASE/'settlement-changes.csv',BASE/'source-prices/settlements.json']
report={'method':'Independent reimplementation using numpy Pearson, archived provider inputs, and direct UTC datetime joins; no imports from root research calculations.',
 'reconstructedHours':len(rebuilt),'featureChecks':dict(checks),'featureMismatches':errors,'statisticRowsChecked':len(stats),'countMismatches':group_errors,
 'timingAudit':'DXY ending T−1h is available at T; previous DXY hourly close ends T−2h; BTC outcome T→T+1h. Daily pairs require max(provider conservative availability)+1h ≤ T. No feature uses BTC outcome or same/future DXY hour.',
 'officialSettlementChecks':brti,'hourMoveStability':stability,'sourceFinalityAndValuesCheckedSettlementPairs':len(sett),
 'inputs':[{'path':str(p.relative_to(ROOT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs]}
(OUT/'verification/independent-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'reconstructedHours':len(rebuilt),'statisticRowsChecked':len(stats),'mismatches':len(errors)+len(group_errors),
 'brti':[{k:r[k] for k in ['variation','cohort','usdDirection','hours','days','up','down','upPct','meanReturnPct','missingOfficialPairs']} for r in brti],
 'stability':[{k:r[k] for k in ['cohort','usdDirection','hours','days','upPct','largestDaySharePct','earlier','later','monthCounts']} for r in stability]},indent=2))
