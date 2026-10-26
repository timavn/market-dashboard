const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const express=require('express');
const {createAnalystWorkspace}=require('./analystWorkspace.cjs');
// Every request in this file closes its connection. A pooled keep-alive socket
// arms a native (global) setTimeout in Node's fetch client. When a fixture's
// server closes, the client socket is torn down asynchronously, often during
// the next test; if that test mocks setTimeout, the client's clearTimeout is
// the mock and the real timer survives. It later fires against a collected
// parser ("Cannot destructure property 'socket' of 'parser.deref(...)'") and
// fails this file at file level. Without keep-alive no such timer exists.
const fetch=(input,init={})=>{
 const headers=new Headers(init.headers);
 headers.set('Connection','close');
 return globalThis.fetch(input,{...init,headers});
};
// Existing provider fixtures describe captured runs. Expose the sidecar's
// compact status route separately, with the identity captured at run creation.
const reviewTransports=new WeakMap();
function reviewTransport(provider){
 if(reviewTransports.has(provider))return reviewTransports.get(provider);
 const identities=new Map();
 const aliases=new Map();
 const request=async(url,options={})=>{
  const status=url.match(/^\/internal\/reviews\/([^/]+)\/status$/);
  const identifier=status?.[1]||url.match(/^\/internal\/reviews\/([^/]+)$/)?.[1];
  const providerUrl=identifier&&aliases.has(identifier)?`/internal/reviews/${aliases.get(identifier)}`:status?`/internal/reviews/${status[1]}`:url;
  const result=await provider(providerUrl,options);
  const run=result?.run||result;
  if(url==='/internal/reviews'&&options.method==='POST'&&run?.runId){
   const allocated=options.body.runId||run.runId;
   identities.set(allocated,{runId:allocated,conversationId:options.body.conversationId,reviewKind:options.body.reviewKind});
   aliases.set(allocated,run.runId);
   const captured={...run,...identities.get(allocated)};
   return result?.run?{...result,run:captured}:captured;
  }
  if(identifier&&identities.has(identifier)){
   const captured={...run,...identities.get(identifier)};
   if(status){
    const keys=['runId','conversationId','reviewKind','state','phase','outcome','deadlineAt','createdAt','updatedAt','completedAt','error'];
    return {ok:true,run:{...Object.fromEntries(keys.map(key=>[key,captured[key]])),active:['accepted','running'].includes(captured.state)}};
   }
   return result?.run?{...result,run:captured}:captured;
  }
  return result;
 };
 reviewTransports.set(provider,request);
 return request;
}
class Socket extends EventEmitter {
 static OPEN=1; static sockets=[];
 constructor(){super(); this.sent=[]; this.readyState=1; Socket.sockets.push(this);setImmediate(()=>this.emit('open'));}
 send(data){this.sent.push(JSON.parse(data));}
 close(){this.readyState=3;this.emit('close');}
 frame(data){this.emit('message',JSON.stringify(data));}
}

test('signal alerts survive publication-gate failure and broker outage, deduplicate, and resolve from holdings', async t => {
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const observed=new Date('2026-09-04T15:00:00Z');
 const event={entityType:'security',entityId:'IGV',qualityStatus:'validated',eventType:'trade_signal',signalValue:'BEARISH',sourceMessageId:'new-signal',fieldPath:'data.trade',publishedAt:observed.toISOString(),signalProvenance:{field:'trade',method:'explicit-field',sourceField:'data.IGV.trade',sourceText:'IGV trade BEARISH'}};
 let offline=true;
 let exited=false;
 const external=async url=>{
  if(url.endsWith('/readiness'))throw new Error('Publication provider unavailable');
  if(url.endsWith('/changes'))return {events:[event],cursor:'new-cursor'};
  if(url.endsWith('/holdings')){
   if(offline)throw new Error('Broker unavailable');
   return {liveVerified:true,complete:true,asOf:observed.toISOString(),positions:exited?[]:[{symbol:'IGV',quantity:10}],ruleHoldings:exited?[]:[{holding:'IGV',heldSide:'LONG',trade:'BEARISH',trend:'NEUTRAL',weightPct:4}]};
  }
  assert.fail('No daily review should start while publication readiness fails');
 };
 const {workspace}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>observed});
 await daily.tick();
 let findings=(await workspace.call('findings')).findings;
 assert.equal(findings.length,1);
 assert.equal(findings[0].state,'pending verification');
 offline=false;
 await daily.tick();
 findings=(await workspace.call('findings')).findings;
 assert.equal(findings.length,1);
 assert.equal(findings[0].payload.rule.targetWeight,0);
 await workspace.call('finding-read',{id:findings[0].id,acknowledge:true});
 await daily.tick();
 assert.equal((await workspace.call('findings')).findings[0].state,'open');
 exited=true;
 await daily.tick();
 assert.equal((await workspace.call('findings')).findings[0].state,'resolved');
});
const pause=()=>new Promise(r=>setTimeout(r,15));
async function fixture(t, external, options={}){
 const dir=mkdtempSync(path.join(tmpdir(),'analyst-integration-'));
 const request=async(url,options={})=>{
  if (external && (!url.startsWith('/internal/workspace/') || ['readiness','changes','holdings'].includes(url.split('/').at(-1)))) return external(url, options);
  const operation=url.split('/').at(-1);
  if(operation==='import')return {};
  // Mirror the sidecar route: a KeyError keeps its own status and typed code
 // (404 not found, 410 deleted); a plain KeyError stays an untyped 404.
 const code=["import sys,json","from pathlib import Path","sys.path.insert(0,'scripts/analyst_sidecar')","from workspace import WorkspaceStore",
  "p=json.load(sys.stdin)","try:","    print(json.dumps(WorkspaceStore(Path(p['db'])).dispatch(p['operation'],p['body'])))",
  "except KeyError as exc:","    print(json.dumps({'error':str(exc),'statusCode':getattr(exc,'status_code',404),'code':getattr(exc,'code',None)}))","    sys.exit(3)"].join('\n');
  const result=spawnSync('python3',['-c',code],{input:JSON.stringify({db:path.join(dir,'workspace.db'),operation,body:options.body||{}}),encoding:'utf8'});
  if(result.status===3){
   const failure=JSON.parse(result.stdout);
   throw Object.assign(new Error(failure.error),{statusCode:failure.statusCode,...(failure.code?{code:failure.code}:{})});
  }
  if(result.status!==0)throw Object.assign(new Error(result.stderr), {statusCode: 409});
  return JSON.parse(result.stdout);
 };
 Socket.sockets=[];
 const workspace=createAnalystWorkspace({request,WebSocketImpl:Socket,...options});
 const app=express();app.use(express.json());app.use(workspace.router);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const api=async(url,body,method)=>{const r=await fetch(base+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};};
 t.after(async()=>{
  // A socket close persists its terminal frame asynchronously. Finish each
  // owner while its SQLite fixture still exists, then close the HTTP server.
  await Promise.all([...workspace.active.values()].map(owner=>owner.stop()));
  Socket.sockets.forEach(s=>s.close());
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise((resolve,reject)=>{
   server.close(error=>error?reject(error):resolve());
  });
  await new Promise(resolve=>setImmediate(resolve));
  rmSync(dir,{recursive:true,force:true});
 });
 return {workspace,api,base,dbPath:path.join(dir,'workspace.db')};
}

test('compact GET stages propagate Python timings, bound retained reads, and exclude report evidence', async t => {
 const calls=[];
 const workspace=createAnalystWorkspace({request:async(url,options={})=>{
  calls.push({url,body:options.body});
  if(!url.endsWith('/get'))return {};
  await new Promise(resolve=>setTimeout(resolve,12));
  options.onResponse({serverTiming:'workspace;dur=1.25, projection;dur=2.5, encode;dur=3, private;desc="private evidence"'});
  return {conversation:{id:options.body.conversationId,reviewRunId:'captured-run',activeTurn:{id:'owned-turn'},
   messages:[{id:'post',text:'private report evidence',citations:[{id:'private-citation'}]}]}};
 }});
 const app=express();app.use(workspace.router);
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 attachDailyWorkflow({workspace,request:async()=>{throw new Error('No provider request expected');}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=async id=>{const response=await fetch(`${base}/conversations/${id}?includeBriefs=false&briefScope=latest`);
  return {status:response.status,text:await response.text()};};
 const first=await get('conversation-0');assert.equal(first.status,200);
 assert.deepEqual(calls.find(call=>call.url.endsWith('/get')).body,
  {conversationId:'conversation-0',includeBriefs:false,briefView:'compact',briefScope:'latest'});
 const diagnostic=workspace.getReadDiagnostics()[0];
 assert.equal(diagnostic.runId,'captured-run');
 assert.deepEqual(diagnostic.stages.map(stage=>stage.stage),['route','initialize','worker-get','reconcile','serialize']);
 assert.ok(diagnostic.stages.every(stage=>stage.outcome==='completed'&&stage.startedAt&&stage.completedAt&&stage.durationMs>=0));
 const worker=diagnostic.stages.find(stage=>stage.stage==='worker-get');
 assert.deepEqual(worker.pythonTimings,{workspace:1.25,projection:2.5,encode:3});
 assert.ok(worker.durationMs>=8);
 assert.equal(diagnostic.stages.find(stage=>stage.stage==='serialize').responseBytes,Buffer.byteLength(first.text));
 worker.pythonTimings.workspace=999;
 assert.equal(workspace.getReadDiagnostics()[0].stages.find(stage=>stage.stage==='worker-get').pythonTimings.workspace,1.25);
 const callCount=calls.length;
 const monitor=await (await fetch(`${base}/monitor?reviewStages=true`)).json();
 assert.equal(calls.length,callCount);
 assert.deepEqual(monitor.workspaceReadDiagnostics,workspace.getReadDiagnostics());
 for(let index=0;index<22;index+=1)await get('conversation-0');
 assert.equal(workspace.getReadDiagnostics()[0].stages.length,96);
 // Contract change: the fifty most recent conversations are retained (was three).
 const ids=Array.from({length:50},(_,index)=>`conversation-${index+1}`);
 for(const id of ids)await get(id);
 const retained=workspace.getReadDiagnostics();
 assert.deepEqual(retained.map(read=>read.conversationId),ids);
 for(const value of ['private report evidence','private-citation','private evidence','Authorization'])assert.equal(JSON.stringify(retained).includes(value),false);
});

test('explicit fresh portfolio requests route before general-chat acceptance and do not require Hermes', async t => {
 const {workspace,api}=await fixture(t,undefined,{canGenerate:()=>false});
 const requests=[];
 workspace.setPortfolioRefreshHandler(async body=>{requests.push(body);return {conversation:{id:'portfolio-review',kind:'portfolio-review',messages:[]}};});
 const response=await api('/messages',{requestId:'fresh-portfolio',text:'refresh my portfolio'});
 assert.equal(response.status,202);
 assert.equal(response.conversation.kind,'portfolio-review');
 assert.deepEqual(requests,[{requestId:'fresh-portfolio',conversationId:undefined,text:'refresh my portfolio'}]);
 assert.deepEqual((await workspace.call('list')).conversations,[]);
 assert.equal(Socket.sockets.length,0);
 assert.equal((await api('/messages',{text:'portfolio refresh'})).status,400);
 assert.equal(requests.length,1);
});

test('ordinary portfolio questions and negated refreshes preserve the existing chat route', async t => {
 const {workspace,api}=await fixture(t);
 workspace.setPortfolioRefreshHandler(()=>assert.fail('An incidental or narrower question cannot launch a review'));
 for(const [index,text] of ["Don't refresh my portfolio",'Explain the last Portfolio Review','Review my portfolio exposure to gold','Refresh my portfolio quotes'].entries()){
  const result=await api('/messages',{requestId:`ordinary-${index}`,text});
  assert.equal(result.status,202);
  assert.equal(result.conversation.kind,'chat');
  Socket.sockets.at(-1).frame({type:'message_complete',text:'Answer'});
  await pause();
 }
 assert.equal(Socket.sockets.length,4);
});

test('message operations are rejected before any conversation is accepted', async t => {
 const {api}=await fixture(t);
 const response=await api('/messages',{requestId:'operation-request',operation:'portfolio-cross-verification',text:'Check my complete current portfolio.'});
 assert.equal(response.status,400);
 assert.deepEqual((await api('/conversations')).conversations,[]);
 assert.equal(Socket.sockets.length,0);
});

test('exact request recovery survives later turns and reports unknown or deleted requests without resubmission',async t=>{
 const {api,base}=await fixture(t);
 const first=await api('/messages',{requestId:'original:request',text:'Original user question'});
 Socket.sockets[0].frame({type:'message_complete',text:'Original saved answer'});
 await pause();
 const followup=await api('/messages',{requestId:'later-request',conversationId:first.conversation.id,text:'Later user question'});
 const response=await fetch(`${base}/requests/${encodeURIComponent('original:request')}`);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 const recovered=await response.json();
 assert.equal(recovered.requestId,'original:request');
 assert.equal(recovered.conversation.id,first.conversation.id);
 assert.equal(recovered.conversation.activeTurn.id,followup.turn.id);
 assert.equal(recovered.turn.id,first.turn.id,'the receipt must identify the requested turn, not only the latest turn');
 assert.equal(recovered.status,'accepted');
 assert.equal(recovered.deleted,false);
 const missing=await fetch(`${base}/requests/unknown-request`);
 assert.equal(missing.status,200);
 assert.deepEqual(await missing.json(),{status:'missing',conversation:null,turn:null,requestId:'unknown-request',deleted:false});
 assert.equal((await api(`/requests/${'x'.repeat(201)}`)).status,400);
 assert.equal((await api(`/conversations/${first.conversation.id}`,undefined,'DELETE')).status,200);
 const deleted=await fetch(`${base}/requests/original%3Arequest`);
 assert.equal(deleted.status,200);
 assert.deepEqual(await deleted.json(),{status:'deleted',conversation:null,turn:null,requestId:'original:request',deleted:true});
 assert.equal(Socket.sockets.length,2,'receipt reads must never create a new response');
});

test('late saved completion recovers the same failed turn only with exact prompt and verified same-turn portfolio evidence', async t => {
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-30T14:20:00Z')});
 const socketsBefore=Socket.sockets.length;
 const text='Check my complete current portfolio against research products.';
 const citation={id:'cite_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',documentId:'doc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',product:'risk-ranges',title:'Dated portfolio evidence',sourceUri:'https://example.com/original-report',publicationDate:'2026-09-30',excerpt:'Original published reading'};
 const conversation={id:'late-chat',hermes_id:'stored-hermes',activeTurn:null,
  lastTurn:{id:'late-turn',state:'failed',error:'The response exceeded its time limit. Retry is available.',created_at:'2026-09-30T14:00:00Z',updated_at:'2026-09-30T14:10:00Z'},
  messages:[{role:'user',turn_id:'late-turn',text}]};
 const source={conversationId:conversation.id,turnId:'late-turn',hermesId:'stored-hermes',sourceMessageId:'hermes-message:final',completedAt:'2026-09-30T14:13:05Z',
  expectedTurnCreatedAt:conversation.lastTurn.created_at,expectedTurnUpdatedAt:conversation.lastTurn.updated_at,
  messages:[{role:'user',content:text,timestamp:Date.parse('2026-09-30T14:00:01Z')/1000},
   {role:'tool',name:'mcp__market_dashboard_analyst__get_portfolio_context',content:JSON.stringify({status:'available',liveVerified:true,freshness:'live',asOf:'2026-09-30T14:01:00Z',citations:[citation]})},
   {role:'assistant',content:`Captured portfolio findings ${citation.id}`,timestamp:Date.parse('2026-09-30T14:13:05Z')/1000}],citations:[citation]};
 const calls=[];
 let snapshot=source;
 const completed={...conversation,lastTurn:{...conversation.lastTurn,state:'complete',error:null}};
 const workspace=createAnalystWorkspace({request:async(url,{body})=>{
  calls.push({url,body});
  if(url.endsWith('/response-source'))return {source:snapshot};
  if(url.endsWith('/reconcile-response'))return {conversation:completed};
  assert.fail(`No generation is required to recover a saved answer: ${url}`);
 }});
 assert.equal(await workspace.reconcileCompletedResponse(conversation),completed);
 assert.equal(calls.length,2);
 assert.deepEqual(calls[1].body,{conversationId:'late-chat',turnId:'late-turn',hermesId:'stored-hermes',expectedTurnCreatedAt:source.expectedTurnCreatedAt,expectedTurnUpdatedAt:source.expectedTurnUpdatedAt,sourceMessageId:source.sourceMessageId,completedAt:source.completedAt,text:'Captured portfolio findings [1]',citations:[citation]});

 for(const content of [{status:'unavailable',liveVerified:false},{status:'mock',liveVerified:true},{status:'available'}, {status:'available',liveVerified:false}]){
  calls.length=0;
  snapshot={...source,messages:source.messages.map(message=>message.role==='tool'?{...message,content:JSON.stringify(content)}:message)};
  assert.equal(await workspace.reconcileCompletedResponse(conversation),conversation);
  assert.equal(calls.length,1,'Unverified archived evidence cannot bypass the live gate');
 }
 calls.length=0;
 snapshot={...source,messages:source.messages.map(message=>message.role==='user'?{...message,content:'A different portfolio request'}:message)};
 assert.equal(await workspace.reconcileCompletedResponse(conversation),conversation);
 assert.equal(calls.length,1);
 calls.length=0;
 assert.equal(await workspace.reconcileCompletedResponse({...conversation,activeTurn:{id:'newer-turn'}}).then(result=>result.activeTurn.id),'newer-turn');
 assert.equal(calls.length,0,'A newer active request must remain untouched');
 assert.equal(Socket.sockets.length,socketsBefore);
});

test('fresh requests bypass saved off-hours portfolio reuse, retain the real request and deduplicate captures', async t => {
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const starts=[];
 let state='running';
 const external=async(url,options={})=>{
  if(url.endsWith('/readiness'))return {};
  if(url.endsWith('/changes'))return {events:[]};
  if(url==='/internal/reviews'&&options.method==='POST'){
   starts.push(options.body);
   return {runId:`fresh-run-${starts.length}`,state:'running'};
  }
  if(url==='/internal/reviews/fresh-run-1')return {run:{runId:'fresh-run-1',state,outcome:'ready',reportMarkdown:'Fresh captured report',completedAt:'2026-09-19T15:00:01Z'}};
  assert.fail(`Fresh portfolio request must not open an old reference: ${url}`);
 };
 const {workspace,api}=await fixture(t,external,{canGenerate:()=>false});
 const old=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-18',title:'Portfolio Review'})).conversation;
 await workspace.call('append',{conversationId:old.id,sourceId:'previous-report',text:'Old immutable report'});
 await workspace.call('setting',{key:`daily-run:${old.id}`,value:{runId:'old-run',completedAt:'2026-09-19T14:59:59Z'}});
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-19T15:00:00Z')});
 const input={requestId:'explicit-catchup',conversationId:old.id,text:'Please run a fresh portfolio review'};
 const [first,again]=await Promise.all([api('/messages',input),api('/messages',input)]);
 assert.equal(first.status,202);assert.equal(again.status,202);
 assert.equal(first.conversation.id,old.id);assert.equal(again.conversation.id,old.id);
 assert.equal(starts.length,1);
 assert.equal(first.conversation.messages.filter(message=>message.role==='user'&&message.text===input.text).length,1);
 assert.equal(first.conversation.messages[0].text,'Old immutable report');
 assert.equal(Socket.sockets.length,0);
 assert.equal((await api('/messages',{...input,text:'full portfolio review'})).status,409);
 state='succeeded';
 await daily.tick();
 const saved=(await api(`/conversations/${old.id}`)).conversation;
 assert.equal(saved.messages.at(-1).text,'Fresh captured report');
 assert.equal(saved.messages.at(-1).reviewRunId,starts[0].runId);
 assert.equal(saved.messages[0].text,'Old immutable report');
 const replay=await api('/messages',input);
 assert.equal(replay.conversation.id,old.id);assert.equal(starts.length,1);
 assert.equal((await workspace.call('list')).conversations.length,1);
});

test('refreshes from another chat leave it intact and deleted request owners are rejected', async t => {
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 let starts=0;
 const external=async(url,options={})=>{
  if(url.endsWith('/readiness'))return {};
  if(url==='/internal/reviews'&&options.method==='POST'){starts+=1;return {runId:'owner-review',state:'running'};}
  assert.fail(`Unexpected capture request ${url}`);
 };
 const {workspace,api}=await fixture(t,external);
 const original=await workspace.call('accept',{requestId:'ordinary-owner',text:'Original discussion'});
 await workspace.call('frame',{turnId:original.turn.id,type:'complete',text:'Saved original answer'});
 attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-19T15:00:00Z')});
 const result=await api('/messages',{requestId:'new-owner-review',conversationId:original.conversation.id,text:'portfolio refresh'});
 assert.equal(result.status,202);assert.equal(result.conversation.kind,'portfolio-review');
 assert.notEqual(result.conversation.id,original.conversation.id);
 const retained=(await api(`/conversations/${original.conversation.id}`)).conversation;
 assert.equal(retained.kind,'chat');assert.equal(retained.messages.at(-1).text,'Saved original answer');
 await workspace.call('delete',{conversationId:original.conversation.id});
 // Contract change: a tombstoned owner answers 410 with its typed code (was an untyped 404).
 const rejected=await api('/messages',{requestId:'deleted-owner-review',conversationId:original.conversation.id,text:'portfolio refresh'});
 assert.equal(rejected.status,410);
 assert.equal(rejected.code,'ANALYST_CONVERSATION_DELETED');
 assert.equal(starts,1);
});

test('the first captured-review follow-up binds its new Hermes session before submitting context', async t => {
 const {workspace,api}=await fixture(t);
 const review=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-18',title:'Portfolio Review'})).conversation;
 await workspace.call('append',{conversationId:review.id,sourceId:'daily-report:captured-run',text:'Captured report'});
 const accepted=await api('/messages',{requestId:'review-followup',conversationId:review.id,text:'Explain the findings'});
 await pause();
 const socket=Socket.sockets.at(-1);
 assert.deepEqual(socket.sent[0],{action:'new_chat',requestId:accepted.turn.id});
 socket.frame({type:'session',storedSessionId:'new-review-session'});
 await pause();
 assert.equal((await workspace.call('get',{conversationId:review.id})).conversation.hermes_id,'new-review-session');
 assert.deepEqual(socket.sent[1],{action:'prompt',text:'Explain the findings',sessionId:'new-review-session',requestId:accepted.turn.id,reviewRunId:'captured-run'});
 socket.frame({type:'message_complete',text:'Cited interpretation'});
 await pause();
});

test('visible report requests receive capture metadata only from a persisted server-owned post binding', async t => {
 const {workspace}=await fixture(t);
 const review=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-18',title:'Portfolio Review'})).conversation;
 const accepted=await workspace.call('accept',{conversationId:review.id,requestId:'daily-turn:unconfirmed',reviewPostId:'unconfirmed',text:'A request mentioning a run'});
 await workspace.call('frame',{turnId:accepted.turn.id,type:'complete',text:'Saved discussion'});
 let saved=(await workspace.call('get',{conversationId:review.id})).conversation;
 assert.equal(saved.messages.at(-1).reviewRunId,undefined);
 await workspace.call('setting',{key:`review-post:${review.id}:unconfirmed`,value:{runId:'different-run'}});
 saved=(await workspace.call('get',{conversationId:review.id})).conversation;
 assert.equal(saved.messages.at(-1).reviewRunId,undefined);
 await workspace.call('setting',{key:`review-post:${review.id}:unconfirmed`,value:{runId:'unconfirmed'}});
 saved=(await workspace.call('get',{conversationId:review.id})).conversation;
 assert.equal(saved.messages.at(-1).reviewRunId,'unconfirmed');
 assert.equal(saved.messages[0].text,'A request mentioning a run');
});

test('loading review Sources starts diagnosis without delaying or changing the saved capture', async t => {
 const inspected=[];
 const sourceDiagnostics={inspect:sources=>{inspected.push(sources);return new Promise(()=>{});}};
 let conversationId;
 const external=async url=>{
  assert.equal(url,'/internal/reviews/diagnostic-run/sources');
  return {runId:'diagnostic-run',conversationId,reviewKind:'portfolio-review',state:'succeeded',
   capturedAt:'2026-09-22T16:23:36Z',checkedAt:'2026-09-22T16:24:48Z',
   items:[{id:'early-look',label:'Early Look',status:'missing',observedAt:null}]};
 };
 const {workspace,api}=await fixture(t,external,{sourceDiagnostics});
 const daily=await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-22',title:'Portfolio Review'});
 conversationId=daily.conversation.id;
 await workspace.call('setting',{key:`daily-run:${conversationId}`,value:{runId:'diagnostic-run'}});
 const result=await api(`/conversations/${conversationId}/sources`);
 assert.equal(result.status,200);
 assert.equal(result.items[0].status,'missing');
 assert.equal(result.capturedAt,'2026-09-22T16:23:36Z');
 assert.equal(inspected.length,1);
 assert.equal(inspected[0].runId,'diagnostic-run');
 sourceDiagnostics.inspect=async()=>{throw new Error('Investigation temporarily unavailable');};
 assert.equal((await api(`/conversations/${conversationId}/sources`)).status,200);
});

test('daily stale recovery preserves a live quiet response and still recovers orphaned or expired owners', async t => {
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const external=async url=>{
  if(url.endsWith('/changes'))return {events:[]};
  if(url.endsWith('/readiness'))throw new Error('Unrelated research unavailable');
  assert.fail('Recovery must not start another review');
 };
 const {workspace,api,dbPath}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-06T15:00:00Z')});
 const live=await api('/messages',{requestId:'quiet-live',text:'Take time to reason'});
 const expired=await api('/messages',{requestId:'expired-owner',text:'Expired response'});
 const orphan=await workspace.call('accept',{requestId:'orphaned-response',text:'No local socket'});
 const aged=spawnSync('python3',['-c',"import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute(\"UPDATE turns SET updated_at=datetime('now','-10 minutes')\");db.commit()",dbPath],{encoding:'utf8'});
 assert.equal(aged.status,0,aged.stderr);
 assert.ok(workspace.active.get(live.turn.id).deadlineAt>Date.now());
 workspace.active.get(expired.turn.id).deadlineAt=Date.now()-1;
 await daily.tick();
 assert.equal((await workspace.call('get',{conversationId:live.conversation.id})).conversation.activeTurn.id,live.turn.id);
 for(const entry of [expired,orphan])assert.equal((await workspace.call('get',{conversationId:entry.conversation.id})).conversation.lastTurn.state,'interrupted');
 Socket.sockets[0].frame({type:'message_complete',text:'Reasoned answer'});
 await pause();
 const saved=(await workspace.call('get',{conversationId:live.conversation.id})).conversation;
 assert.equal(saved.lastTurn.state,'complete');
 assert.equal(saved.messages.at(-1).text,'Reasoned answer');
 assert.equal(workspace.active.has(live.turn.id),false);
});

test('the response timeout releases its active recovery exclusion', async t => {
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1_000_000});
 const frames=[];
 const workspace=createAnalystWorkspace({
  WebSocketImpl:Socket,
  request:async(_url,{body})=>{frames.push(body);return {};},
 });
 workspace.generate({turn:{id:'timed-response'},conversation:{id:'timed-chat',title:'Question',messages:[{turn_id:'timed-response',role:'user',text:'Question'}]}});
 const socket=Socket.sockets.at(-1);
 assert.equal(workspace.active.has('timed-response'),true);
 assert.equal(workspace.active.get('timed-response').deadlineAt,2_800_000);
 t.mock.timers.tick(190_000);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(workspace.active.has('timed-response'),true);
 assert.ok(workspace.active.get('timed-response').deadlineAt>Date.now());
 assert.deepEqual(frames,[]);
 t.mock.timers.tick(1_610_000);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(workspace.active.has('timed-response'),false);
 assert.equal(socket.readyState,3);
 assert.deepEqual(frames,[{turnId:'timed-response',type:'failed',includeConversation:false,error:'The response exceeded its time limit. Retry is available.'}]);
});

test('stream bursts persist in one batch and completion flushes all text without dropping or duplicating event IDs', async t => {
 const {workspace,api}=await fixture(t);
 const accepted=await api('/messages',{requestId:'batched-text',text:'Question'});
 const socket=Socket.sockets.at(-1);
 for(let i=0;i<700;i++)socket.frame({type:'message_delta',eventId:`delta-${i}`,text:`${i},`});
 socket.frame({type:'message_delta',eventId:'delta-699',text:'duplicate'});
 socket.frame({type:'message_complete'});
 await pause();
 const saved=(await api(`/conversations/${accepted.conversation.id}`)).conversation;
 assert.equal(saved.messages.at(-1).text,Array.from({length:700},(_,i)=>`${i},`).join(''));
 assert.equal(saved.lastTurn.state,'complete');
 const events=(await workspace.call('events',{after:0})).events.filter(event=>event.turn_id===accepted.turn.id);
 assert.equal(events.filter(event=>['delta','delta_batch'].includes(event.type)).length,1);
});

test('Stop discards unsent text and does not wait behind an in-flight delta write', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 const frames=[];
 let releaseBatch;
 const workspace=createAnalystWorkspace({WebSocketImpl:Socket,request:async(_url,{body})=>{
  frames.push(body);
  if(body.type==='delta_batch')await new Promise(resolve=>{releaseBatch=resolve;});
  return {ok:true};
 }});
 workspace.generate({turn:{id:'stop-stream'},conversation:{id:'stop-chat',title:'Question',messages:[{turn_id:'stop-stream',role:'user',text:'Question'}]}});
 const socket=Socket.sockets.at(-1);
 socket.frame({type:'message_delta',eventId:0,text:'Already sent'});
 t.mock.timers.tick(200);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(frames[0].type,'delta_batch');
 assert.equal(frames[0].entries[0].eventId,0);
 socket.frame({type:'message_delta',eventId:1,text:'Unsent'});
 await workspace.active.get('stop-stream').stop();
 assert.equal(workspace.active.has('stop-stream'),false);
 assert.equal(socket.readyState,3);
 assert.deepEqual(frames.map(frame=>frame.type),['delta_batch','interrupted']);
 assert.ok(frames.every(frame=>frame.includeConversation===false));
 releaseBatch();
 t.mock.timers.tick(1000);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(frames.length,2);
});

test('a full-book response completing after thirteen minutes is saved once before its bounded deadline', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 const frames=[];
 const workspace=createAnalystWorkspace({WebSocketImpl:Socket,request:async(_url,{body})=>{frames.push(body);return {};}});
 workspace.generate({turn:{id:'long-response'},conversation:{id:'long-chat',title:'Question',messages:[{turn_id:'long-response',role:'user',text:'Question'}]}});
 const socket=Socket.sockets.at(-1);
 t.mock.timers.tick(785_000);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(frames,[]);
 socket.frame({type:'message_complete',text:'Verified answer after live tool checks'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(workspace.active.has('long-response'),false);
 assert.equal(socket.readyState,3);
 t.mock.timers.tick(1_800_000);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(frames.length,1);
 assert.equal(frames[0].type,'complete');
 assert.equal(frames[0].text,'Verified answer after live tool checks');
});

test('daily ticks do not create empty miscellaneous chats through provider outages or Eastern date rollover',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 let observed=new Date('2026-09-06T03:59:00Z');
 const external=async url=>{
  assert.ok(url.endsWith('/changes')||url.endsWith('/readiness'),'Idle workspace must not request a review, holdings, or Hermes');
  throw new Error('Research and broker providers are unavailable');
 };
 const {workspace,api}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),canGenerate:()=>false,now:()=>observed});
 await Promise.all([daily.tick(),daily.tick()]);
 await daily.tick();
 assert.deepEqual((await api('/conversations')).conversations,[]);
 assert.equal(Socket.sockets.length,0);
 assert.deepEqual((await workspace.call('events',{after:0})).events,[]);
 observed=new Date('2026-09-06T04:00:00Z');
 await daily.tick();
 assert.deepEqual((await api('/conversations')).conversations,[]);
 assert.deepEqual((await workspace.call('events',{after:0})).events,[]);
 assert.equal(Socket.sockets.length,0);
});

test('an existing miscellaneous chat accepts a first message and survives subsequent daily ticks',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const external=async url=>{
  if(url.endsWith('/changes'))return {events:[]};
  if(url.endsWith('/readiness'))throw new Error('Research unavailable');
  assert.fail('No automatic generation for a miscellaneous chat');
 };
 const {workspace,api}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-06T15:00:00Z')});
 const original=(await workspace.call('daily',{kind:'daily-chat',date:'2026-09-06',title:'Miscellaneous'})).conversation;
 const accepted=await api('/messages',{conversationId:original.id,requestId:'misc-first',text:'A question for today'});
 assert.equal(accepted.status,202);
 assert.equal(accepted.conversation.id,original.id);
 assert.equal(Socket.sockets.length,1);
 await pause();
 assert.equal(Socket.sockets[0].sent[0].action,'new_prompt');
 assert.equal(Socket.sockets[0].sent[0].text,'A question for today');
 Socket.sockets[0].frame({type:'message_complete',text:'Saved reply'});
 await pause();
 await daily.tick();
 const saved=(await api(`/conversations/${original.id}`)).conversation;
 assert.equal(saved.title,'Miscellaneous');
 assert.equal(saved.trading_date,'2026-09-06');
 assert.equal(saved.created_at,original.created_at);
 assert.deepEqual(saved.messages.map(message=>message.text),['A question for today','Saved reply']);
 assert.equal(saved.lastTurn.state,'complete');
 assert.equal((await api('/conversations')).conversations.length,1);
 assert.equal(Socket.sockets.length,1);
});

test('inbox projects evidenced changes from durable observations and keeps acknowledgment through repeat publications and holdings refreshes',async t=>{
 const {workspace,api}=await fixture(t);
 const observation=(symbol,date,signalValue)=>{
  const productKey=symbol==='IBIT'?'bitcoin-trend-tracker':'risk-ranges';
  const id=`${symbol}-${date}`;
  const sourceId=`${productKey}-${date}`;
  const sourceUrl=`https://app.hedgeye.com/feed_items/${sourceId}`;
  const publishedAt=`${date}T00:00:00Z`;
  const excerpt=`${symbol}: ${signalValue}`;
  return {id,sourceId,symbol,action:'signal change',state:'open',fingerprint:`${id}-initial`,
   quantity:15,holdingsVerified:true,holdingsVerifiedAt:'2026-09-14T15:00:00Z',
   rule:{weightPct:2,targetWeight:1},
   event:{entityType:'security',entityId:symbol,productKey,
    productLabel:symbol==='IBIT'?'Bitcoin Tracker':'Risk Ranges',
    eventType:symbol==='IBIT'?'trade_signal':'risk_range',
    fieldPath:`data.${symbol}`,qualityStatus:'validated',signalValue,
    sourceMessageId:sourceId,sourceUrl,publishedAt,marketDate:date,excerpt,contentSha256:`${id}-source`},
   citation:{id:`cite_${id}`,title:productKey,product:productKey,publicationDate:date,sourceUri:sourceUrl,excerpt}};
 };
 const baseline=observation('AMZN','2026-09-09','NEUTRAL');
 const bitcoinBaseline=observation('IBIT','2026-09-09','BULLISH');
 for(const finding of [baseline,bitcoinBaseline])await workspace.call('finding',{finding});
 assert.deepEqual((await api('/inbox')).findings,[]);
 assert.equal((await api('/inbox')).unread,0);
 assert.equal((await workspace.call('findings')).unread,2);

 const changed=observation('AMZN','2026-09-10','BEARISH');
 await workspace.call('finding',{finding:changed});
 let inbox=await api('/inbox');
 assert.equal(inbox.status,200);
 assert.equal(inbox.unread,1);
 assert.deepEqual(inbox.findings.map(f=>f.id),[changed.id]);
 assert.equal(inbox.findings[0].payload.event.previousEvent.signalValue,'NEUTRAL');
 assert.equal(inbox.findings[0].payload.alertContext.previousAt,baseline.event.publishedAt);
 assert.equal(inbox.findings[0].payload.alertContext.changedAt,changed.event.publishedAt);
 assert.equal((await api(`/inbox/${changed.id}/read`,{acknowledge:true})).status,200);
 assert.equal((await api('/inbox')).unread,0);

 const repeat=observation('AMZN','2026-09-14','BEARISH');
 const bitcoinRepeat=observation('IBIT','2026-09-14','BULLISH');
 for(const finding of [repeat,bitcoinRepeat])await workspace.call('finding',{finding});
 inbox=await api('/inbox');
 assert.deepEqual(inbox.findings.map(f=>f.id),[changed.id]);
 assert.equal(inbox.unread,0);
 assert.equal(inbox.findings[0].unread,0);
 assert.equal(inbox.findings[0].payload.event.signalValue,'BEARISH');
 assert.equal(inbox.findings[0].payload.alertContext.previousAt,baseline.event.publishedAt);
 assert.equal(inbox.findings[0].payload.alertContext.changedAt,changed.event.publishedAt);
 assert.equal(inbox.findings[0].payload.alertContext.lastConfirmedAt,repeat.event.publishedAt);
 assert.equal(inbox.findings[0].payload.alertContext.previousCitation.sourceUri,baseline.citation.sourceUri);
 assert.equal(inbox.findings[0].payload.alertContext.latestCitation.sourceUri,repeat.citation.sourceUri);

 const acknowledged=inbox.findings[0].acknowledged_at;
 for(const refresh of [
  {state:'pending verification',fingerprint:'provider-offline',quantity:null,holdingsVerified:false,rule:null},
  {state:'open',fingerprint:'holdings-refreshed',quantity:10,holdingsVerified:true,
   holdingsVerifiedAt:'2026-09-14T16:00:00Z',rule:{weightPct:1.5,targetWeight:1}},
 ]){
  Object.assign(changed,refresh);
  assert.equal((await workspace.call('finding',{finding:changed})).material,false);
  inbox=await api('/inbox');
  assert.deepEqual(inbox.findings.map(f=>f.id),[changed.id]);
  assert.equal(inbox.unread,0);
  assert.equal(inbox.findings[0].acknowledged_at,acknowledged);
  assert.equal(inbox.findings[0].state,refresh.state);
 }
 const raw=await workspace.call('findings');
 assert.equal(raw.findings.length,5);
 assert.equal(raw.unread,4);
 assert.equal(raw.findings.find(f=>f.id===changed.id).payload.quantity,10);
 assert.equal(raw.findings.find(f=>f.id===changed.id).unread,0);
 assert.ok(raw.findings.some(f=>f.id===baseline.id));
 assert.ok(raw.findings.some(f=>f.id===repeat.id));
 assert.ok(raw.findings.some(f=>f.id===bitcoinRepeat.id));
});

test('HTTP acceptance, independent sockets, duplicate frames, targeted Stop and replay use durable SQLite without archive actions',async t=>{
 const {api,base}=await fixture(t);
 const a=await api('/messages',{requestId:'a',text:'A'});
 const b=await api('/messages',{requestId:'b',text:'B'});
 assert.equal(a.status,202);assert.notEqual(a.conversation.id,b.conversation.id);
 const duplicate=await api('/messages',{requestId:'a',text:'A'});
 assert.equal(duplicate.created,false);assert.equal(Socket.sockets.length,2);
 Socket.sockets[0].frame({type:'message_delta',eventId:'delta-1',text:'A partial'});
 Socket.sockets[0].frame({type:'message_delta',eventId:'delta-1',text:'A partial'});
 await new Promise(resolve=>setTimeout(resolve,250));
 assert.equal((await api(`/conversations/${b.conversation.id}/turns/${a.turn.id}/stop`,{})).status,409);
 assert.equal((await api(`/conversations/${a.conversation.id}/turns/${a.turn.id}/stop`,{})).status,200);
 Socket.sockets[0].frame({type:'message_complete',text:'Wrong late result'});
 Socket.sockets[1].frame({type:'message_complete',text:'B completed'});
 await pause();
 const savedA=await api(`/conversations/${a.conversation.id}`);const savedB=await api(`/conversations/${b.conversation.id}`);
 assert.equal(savedA.conversation.messages.at(-1).text,'A partial');
 assert.equal(savedA.conversation.lastTurn.state,'interrupted');
 assert.equal(savedB.conversation.messages.at(-1).text,'B completed');
 const controller=new AbortController();
 const events=await fetch(base+'/events?after=0',{signal:controller.signal});
 const reader=events.body.getReader();const packet=await reader.read();
 assert.match(new TextDecoder().decode(packet.value),/id: \d+/);controller.abort();
 const archive=await fetch(`${base}/conversations/${a.conversation.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})});
 assert.equal(archive.status,404,'chat history no longer exposes an archive action');
 assert.equal((await api('/conversations')).conversations.length,2);
 assert.equal((await api(`/conversations/${a.conversation.id}`)).conversation.messages.at(-1).text,'A partial');
});

test('connected history streams receive accepted and completed messages without waiting for polling', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const {api,base}=await fixture(t);
 const controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),2000);
 t.after(()=>{clearTimeout(deadline);controller.abort();});
 const response=await fetch(base+'/events?after=0',{signal:controller.signal});
 const reader=response.body.getReader();
 const packet=async pattern=>{
  let text='';
  while(!pattern.test(text)){
   const next=await reader.read();
   assert.equal(next.done,false);
   text+=new TextDecoder().decode(next.value);
  }
  return text;
 };
 await packet(/event: ready/);
 const accepted=await api('/messages',{requestId:'immediate-history',text:'Question'});
 const acceptedEvent=await packet(/"type":"accepted"/);
 assert.ok(acceptedEvent.includes(accepted.conversation.id));
 Socket.sockets.at(-1).frame({type:'message_complete',text:'Saved answer'});
 await packet(/"type":"complete"/);
 const saved=(await api(`/conversations/${accepted.conversation.id}`)).conversation;
 assert.equal(saved.messages.at(-1).text,'Saved answer');
 assert.equal(saved.lastTurn.state,'complete');
});

test('latest history stream establishes a bounded cursor without replaying old history or initializing the workspace', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const calls=[];
 const events=[{seq:4,type:'accepted',conversation_id:'old-chat'},{seq:12,type:'complete',conversation_id:'old-chat'}];
 const request=async(url,options)=>{
  const operation=url.split('/').at(-1);calls.push({operation,...options});
  if(operation==='event-cursor')return {cursor:12};
  if(operation==='events')return {events:events.filter(event=>event.seq>options.body.after)};
  assert.fail('A read-only stream must not recover or import workspace history: '+operation);
 };
 const {base}=await fixture(t,null,{request});
 const controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),2000);
 try{
  const response=await fetch(base+'/events?after=latest',{signal:controller.signal});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader();let text='';
  while(!text.includes('event: ready'))text+=new TextDecoder().decode((await reader.read()).value);
  assert.match(text,/id: 12\nevent: ready\ndata: \{"cursor":12\}/);
  assert.doesNotMatch(text,/old-chat|"type":"accepted"|"type":"complete"/);
  assert.deepEqual(calls.map(call=>call.operation),['event-cursor','events']);
  assert.equal(calls[0].timeoutMs,5000);
  assert.deepEqual(calls[1].body,{after:12});
 }finally{clearTimeout(deadline);controller.abort();}
});

test('latest history stream delivers an event committed during the cursor handshake before the fallback poll', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const events=[{seq:7,type:'accepted',conversation_id:'old-chat'}];
 let releaseCursor;
 let cursorStarted;
 const started=new Promise(resolve=>{cursorStarted=resolve;});
 const reads=[];
 const request=async(url,{body})=>{
  const operation=url.split('/').at(-1);
  if(operation==='event-cursor'){
   const cursor=events.at(-1).seq;
   cursorStarted();
   await new Promise(resolve=>{releaseCursor=resolve;});
   return {cursor};
  }
  if(operation==='events'){reads.push(body.after);return {events:events.filter(event=>event.seq>body.after)};}
  assert.fail('Unexpected stream operation: '+operation);
 };
 const {base}=await fixture(t,null,{request});
 const controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),2000);
 try{
  const connecting=fetch(base+'/events?after=latest',{signal:controller.signal});
  await started;
  events.push({seq:8,type:'complete',conversation_id:'new-chat'});
  releaseCursor();
  const response=await connecting;
  const reader=response.body.getReader();let text='';
  while(!text.includes('new-chat')){
   const packet=await reader.read();assert.equal(packet.done,false);
   text+=new TextDecoder().decode(packet.value);
  }
  assert.match(text,/id: 7\nevent: ready\ndata: \{"cursor":7\}/);
  assert.match(text,/id: 8\ndata: .*"type":"complete".*new-chat/);
  assert.doesNotMatch(text,/old-chat/);
  assert.deepEqual(reads,[7]);
 }finally{clearTimeout(deadline);controller.abort();}
});

test('numeric Last-Event-ID takes precedence over latest and preserves reconnect replay including cursor zero', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const events=[{seq:1,type:'accepted',conversation_id:'first-chat'},{seq:9,type:'complete',conversation_id:'later-chat'}];
 const reads=[];
 const request=async(url,{body})=>{
  const operation=url.split('/').at(-1);
  assert.equal(operation,'events','A numeric reconnect must not fetch a new tail cursor or initialize');
  reads.push(body.after);return {events:events.filter(event=>event.seq>body.after)};
 };
 const {base}=await fixture(t,null,{request});
 for(const lastEventId of ['0','8']){
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),2000);
  try{
   const response=await fetch(base+'/events?after=latest',{headers:{'Last-Event-ID':lastEventId},signal:controller.signal});
   const reader=response.body.getReader();let text='';
   while(!text.includes('later-chat')){
    const packet=await reader.read();assert.equal(packet.done,false);
    text+=new TextDecoder().decode(packet.value);
   }
   assert.match(text,/id: 9/);
   if(lastEventId==='0')assert.match(text,/first-chat/);else assert.doesNotMatch(text,/first-chat/);
   assert.doesNotMatch(text,/event: ready/);
  }finally{clearTimeout(deadline);controller.abort();}
 }
 assert.deepEqual(reads,[0,8]);
});

// Contract change: EventSource closes permanently on a non-200 answer, so an
// unavailable or malformed tail cursor now opens the stream (was 503) and
// reports `unavailable` without an event id or any replayed event.
test('latest cursor failures and malformed cursors open the stream as unavailable without replaying events', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 for(const cursor of ['unavailable',undefined,-1,1.5,'9']){
  const calls=[];
  const request=async(url,options)=>{
   const operation=url.split('/').at(-1);calls.push({operation,...options});
   assert.equal(operation,'event-cursor','No event read may start before a verified tail cursor');
   if(cursor==='unavailable')throw new Error('Sidecar timed out');
   return {cursor};
  };
  const {base}=await fixture(t,null,{request});
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),2000);
  try{
   const response=await fetch(base+'/events?after=latest',{signal:controller.signal});
   assert.equal(response.status,200);
   assert.match(response.headers.get('content-type'),/text\/event-stream/);
   const reader=response.body.getReader();let text='';
   while(!text.includes('event: unavailable'))text+=new TextDecoder().decode((await reader.read()).value);
   assert.equal(text,'event: unavailable\ndata: {"error":"The Analyst event cursor is unavailable."}\n\n');
   assert.equal(calls.length,1);
   assert.equal(calls[0].timeoutMs,5000);
  }finally{clearTimeout(deadline);controller.abort();}
 }
});

test('an unavailable tail keeps retrying its cursor on the stream, then becomes ready without replaying old events', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const events=[{seq:3,type:'accepted',conversation_id:'old-chat'},{seq:5,type:'deleted',conversation_id:'old-chat'}];
 let available=false;
 const operations=[];
 const reads=[];
 const request=async(url,{body}={})=>{
  const operation=url.split('/').at(-1);operations.push(operation);
  if(operation==='event-cursor'){
   if(!available)throw Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'});
   return {cursor:events.at(-1).seq};
  }
  if(operation==='events'){reads.push(body.after);return {events:events.filter(event=>event.seq>body.after)};}
  assert.fail('A cold stream must not recover or import history: '+operation);
 };
 const {base}=await fixture(t,null,{request});
 const controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),2000);
 try{
  const response=await fetch(base+'/events?after=latest',{signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader();let text='';
  const until=async pattern=>{while(!pattern.test(text)){const next=await reader.read();assert.equal(next.done,false);text+=new TextDecoder().decode(next.value);}};
  await until(/event: unavailable/);
  t.mock.timers.tick(750);
  await until(/event: unavailable[\s\S]*event: unavailable/);
  assert.deepEqual(reads,[]);
  assert.doesNotMatch(text,/^id:/m,'no reconnect cursor exists before the tail is verified');
  available=true;
  t.mock.timers.tick(750);
  await until(/event: ready/);
  events.push({seq:6,type:'complete',conversation_id:'new-chat'});
  t.mock.timers.tick(750);
  await until(/new-chat/);
  assert.match(text,/id: 5\nevent: ready\ndata: \{"cursor":5\}/);
  assert.match(text,/id: 6\ndata: .*"type":"complete".*new-chat/);
  assert.doesNotMatch(text,/old-chat/);
  assert.equal(reads[0],5);
  assert.equal(operations.filter(operation=>operation==='event-cursor').length,3);
 }finally{clearTimeout(deadline);controller.abort();}
});

test('source-progress and other unknown event types stream like every other durable event', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const events=[{seq:2,type:'source-progress',conversation_id:'review-chat',payload:{runId:'run-1',source:'portfolio',status:'ready'}},
  {seq:3,type:'future-event-type',conversation_id:'review-chat'}];
 const request=async(url,{body})=>({events:events.filter(event=>event.seq>body.after)});
 const {base}=await fixture(t,null,{request});
 const controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),2000);
 try{
  const response=await fetch(base+'/events?after=1',{signal:controller.signal});
  const reader=response.body.getReader();let text='';
  while(!text.includes('future-event-type'))text+=new TextDecoder().decode((await reader.read()).value);
  assert.match(text,/id: 2\ndata: \{"seq":2,"type":"source-progress","conversation_id":"review-chat","payload":\{"runId":"run-1","source":"portfolio","status":"ready"\}\}/);
  assert.match(text,/id: 3\ndata: .*future-event-type/);
 }finally{clearTimeout(deadline);controller.abort();}
});

test('latest stream connects while list initialization is pending or failing without running recovery itself', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 let releaseRecovery;
 let recoveryStarted;
 const started=new Promise(resolve=>{recoveryStarted=resolve;});
 const operations=[];
 const request=async(url)=>{
  const operation=url.split('/').at(-1);operations.push(operation);
  if(operation==='recover'){
   recoveryStarted();await new Promise(resolve=>{releaseRecovery=resolve;});
   throw new Error('Cold recovery unavailable');
  }
  if(operation==='event-cursor')return {cursor:21};
  if(operation==='events')return {events:[]};
  assert.fail('No history mutation or hydration expected: '+operation);
 };
 const {api,base}=await fixture(t,null,{request});
 const listing=api('/conversations');
 await started;
 for(const state of ['pending','failed']){
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),2000);
  try{
   const response=await fetch(base+'/events?after=latest',{signal:controller.signal});
   const packet=await response.body.getReader().read();
   assert.equal(response.status,200);
   assert.match(new TextDecoder().decode(packet.value),/data: \{"cursor":21\}/);
   assert.equal(operations.filter(operation=>operation==='recover').length,1,state);
  }finally{clearTimeout(deadline);controller.abort();}
  if(state==='pending'){releaseRecovery();assert.equal((await listing).status,503);}
 }
 assert.equal(operations.filter(operation=>operation==='event-cursor').length,2);
 assert.equal(operations.filter(operation=>operation==='import').length,0);
});

test('a durable write during an in-flight event read is delivered before the fallback poll', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const events=[];
 let releaseRead;
 let eventReads=0;
 const request=async(url,{body})=>{
  const operation=url.split('/').at(-1);
  if(operation==='events'){
   eventReads++;
   const snapshot=events.filter(event=>event.seq>body.after);
   if(eventReads===1)await new Promise(resolve=>{releaseRead=resolve;});
   return {events:snapshot};
  }
  if(operation==='frame')events.push({seq:1,type:'delta',conversation_id:'chat',turn_id:body.turnId});
  return {ok:true};
 };
 const {workspace,base}=await fixture(t,null,{request});
 const controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),2000);
 t.after(()=>{clearTimeout(deadline);controller.abort();});
 const response=await fetch(base+'/events?after=0',{signal:controller.signal});
 assert.equal(typeof releaseRead,'function');
 await workspace.call('frame',{turnId:'response',type:'delta_batch',entries:[{text:'Saved text'}]});
 assert.equal(eventReads,1);
 releaseRead();
 let text='';
 const reader=response.body.getReader();
 while(!text.includes('"type":"delta"')){
  const next=await reader.read();
  assert.equal(next.done,false);
  text+=new TextDecoder().decode(next.value);
 }
 assert.equal(eventReads,2);
 assert.match(text,/id: 1/);
});

test('ready research, new publications, date rollover and API restart never create review conversations',async t=>{
 const {REQUIRED_PRODUCTS}=require('./analystPolicy.cjs');
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 let observed=new Date('2026-09-28T15:00:00Z');
 let revision='first';let starts=0;let scans=0;
 const runs=new Map();
 const external=async(url,options={})=>{
  if(url.endsWith('/readiness')){
   const date=observed.toISOString().slice(0,10);
   return {products:REQUIRED_PRODUCTS.map(([product])=>({product,latestPublicationDate:date,stages:{received:true,parsed:true,validated:true,indexed:true}})),indexed:REQUIRED_PRODUCTS.map(([product])=>({product,publication_date:date,document_id:product,content_hash:revision}))};
  }
  if(url.endsWith('/changes')){scans++;return {events:[],cursor:'checkpoint'};}
  if(url==='/internal/reviews'){
   const run={runId:`requested-${++starts}`,reviewKind:options.body.reviewKind,state:'succeeded',outcome:'ready',reportMarkdown:'Requested review',citations:[],completedAt:observed.toISOString()};
   runs.set(run.runId,run);return run;
  }
  if(url.startsWith('/internal/reviews/'))return runs.get(url.split('/').at(-1));
  throw new Error('Unexpected '+url);
 };
 const {workspace,api}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),canGenerate:()=>false,now:()=>observed});
 await daily.tick();await daily.tick();
 revision='corrected';
 await Promise.all([daily.tick(),daily.tick()]);
 assert.equal(starts,0);
 assert.equal((await api('/conversations')).conversations.length,0);
 assert.ok(scans>=3,'research ingestion continues independently');
 const first=await api('/daily/prediction-markets-review',{});
 assert.equal(starts,1);
 await daily.tick();
 assert.equal((await api(`/conversations/${first.conversation.id}`)).conversation.messages[0].text,'Requested review');
 await api(`/conversations/${first.conversation.id}`,undefined,'DELETE');
 observed=new Date('2026-09-29T15:00:00Z');
 await daily.tick();
 const restarted=attachDailyWorkflow({workspace:{...workspace,router:express.Router()},request:reviewTransport(external),canGenerate:()=>false,now:()=>observed});
 await restarted.tick();await restarted.tick();
 assert.equal(starts,1);
 assert.equal((await api('/conversations')).conversations.length,0);
 assert.equal((await workspace.call('deleted',{conversationId:first.conversation.id})).deleted,true);
 const requested=await api('/daily/prediction-markets-review',{});
 assert.equal(starts,2,'the review button still creates a requested review');
 assert.notEqual(requested.conversation.id,first.conversation.id);
});

test('DELETE stops just the owning response, stays deleted on replay, and leaves other chats running',async t=>{
 const {workspace,api}=await fixture(t);
 const a=await api('/messages',{requestId:'delete-a',text:'A'});
 const b=await api('/messages',{requestId:'keep-b',text:'B'});
 assert.equal((await api(`/conversations/${a.conversation.id}`,undefined,'DELETE')).status,200);
 assert.equal(Socket.sockets[0].readyState,3);
 assert.equal(Socket.sockets[1].readyState,1);
 Socket.sockets[0].frame({type:'message_complete',text:'Late deleted content'});
 // Contract change: reading a tombstoned chat answers 410 with its typed code
 // (was an untyped 404), so the browser can evict it as a verified deletion.
 const removed=await api(`/conversations/${a.conversation.id}`);
 assert.equal(removed.status,410);
 assert.equal(removed.code,'ANALYST_CONVERSATION_DELETED');
 const unknown=await api('/conversations/never-existed');
 assert.equal(unknown.status,404);
 assert.equal(unknown.code,'ANALYST_CONVERSATION_NOT_FOUND');
 assert.equal((await api('/messages',{requestId:'delete-a',text:'A'})).status,409);
 assert.equal((await api(`/conversations/${a.conversation.id}`,undefined,'DELETE')).status,200);
 assert.deepEqual((await api('/conversations')).conversations.map(c=>c.id),[b.conversation.id]);
 const replay=await workspace.call('events',{after:0});
 assert.equal(replay.events.filter(e=>e.conversation_id===a.conversation.id).length,1);
 assert.equal(replay.events.find(e=>e.conversation_id===a.conversation.id).type,'deleted');
});

test('DELETE acknowledges durable removal while response and review cancellation remain pending', async t => {
 let finishCleanup;
 const cleanup = new Promise(resolve => { finishCleanup = resolve; });
 const cancellations = [];
 let stopped = false;
 const request = async (url, { body } = {}) => {
  if (url.endsWith('/recover') || url.endsWith('/import')) return {};
  if (url.endsWith('/delete')) {
   assert.equal(body.conversationId, 'removed-chat');
   return { ok: true, turnId: 'response', cancelRunId: 'review' };
  }
  if (url.endsWith('/cancel-review')) { cancellations.push(body); await cleanup; return { ok: true }; }
  assert.fail(`Deletion must not depend on another history read: ${url}`);
 };
 const workspace = createAnalystWorkspace({ request });
 workspace.active.set('response', { stop: async () => { stopped = true; await cleanup; } });
 const app = express(); app.use(express.json()); app.use(workspace.router);
 const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
 t.after(() => { finishCleanup(); server.closeAllConnections(); server.close(); });
 const response = await fetch(`http://127.0.0.1:${server.address().port}/conversations/removed-chat`, {
  method: 'DELETE', signal: AbortSignal.timeout(1_000),
 });
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { ok: true });
 assert.equal(stopped, true);
 assert.deepEqual(cancellations, [{ runId: 'review', conversationId: 'removed-chat' }]);
});

test('Balance Review is retired: a launch is rejected before any review run starts', async t => {
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const calls=[];
 const external=async url=>{calls.push(url);throw new Error('Unexpected '+url);};
 const {workspace,api}=await fixture(t,external);
 attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-06T15:00:00Z')});
 const start=await api('/daily/balance-review',{});
 assert.equal(start.status,400);
 assert.equal(calls.some(url=>url.startsWith('/internal/reviews')),false);
 assert.equal((await api('/conversations')).conversations.length,0);
});

test('explicit refresh appends a full unchanged review while replay and background research keep its post', async t => {
 const {REQUIRED_PRODUCTS}=require('./analystPolicy.cjs');
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const date='2026-09-04';
 const evidence={products:REQUIRED_PRODUCTS.map(([product])=>({product,latestPublicationDate:date,stages:{received:true,parsed:true,validated:true,indexed:true}})),indexed:REQUIRED_PRODUCTS.map(([product])=>({product,publication_date:date,document_id:product,content_hash:'1'}))};
 const runs=new Map();
 const external=async (url,options={})=>{
  if(url.endsWith('/readiness'))return evidence;
  if(url.endsWith('/changes'))return {events:[]};
  if(url==='/internal/reviews'){
   const run={runId:`post-run-${runs.size+1}`,state:'succeeded',outcome:'ready',
    reportMarkdown:`Complete ${options.body.reviewKind} report`,sections:{kind:options.body.reviewKind,unchanged:true},completedAt:new Date().toISOString()};
   runs.set(run.runId,run);return run;
  }
  if(url.startsWith('/internal/reviews/'))return runs.get(url.split('/').at(-1));
  throw new Error('Unexpected '+url);
 };
 const {workspace,api}=await fixture(t,external);
 workspace.generate=accepted=>workspace.call('frame',{turnId:accepted.turn.id,type:'complete',text:'Notes for this review'});
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date(`${date}T15:00:00Z`)});
 for(const kind of ['portfolio-review','prediction-markets-review'])await api(`/daily/${kind}`,{});
 await daily.tick();await daily.tick();
 const rows=(await api('/conversations')).conversations;
 assert.equal(rows.length,2);
 assert.ok(rows.every(row=>row.message_count===1));
 for(const row of rows){
  const next=await api(`/daily/${row.kind}`,{refresh:true,conversationId:row.id,requestId:`refresh-${row.id}`});
  assert.equal(next.status,200);
  assert.equal(next.conversation.id,row.id);
 }
 // Empty pending reports add nothing; a report and its generated notes add one.
 assert.ok((await api('/conversations')).conversations.every(row=>row.message_count===1));
 await daily.tick();
 assert.ok((await api('/conversations')).conversations.every(row=>row.message_count===2));
 for(const row of rows){
  const detail=(await api(`/conversations/${row.id}`)).conversation;
  assert.equal(detail.messages.filter(message=>message.text===`Complete ${row.kind} report`).length,2);
  assert.ok(detail.messages.every(message=>!message.text.includes('No material changes')));
  assert.equal((await workspace.call('setting',{key:`daily-run:${row.id}`})).value.newPost,true);
 }
 const runCount=runs.size;
 for(const row of rows)await api(`/daily/${row.kind}`,{refresh:true,conversationId:row.id,requestId:`refresh-${row.id}`});
 assert.equal(runs.size,runCount);
 for(const row of rows.filter(item=>item.kind!=='portfolio-review')){
  const key=`daily-run:${row.id}`;
  const record=(await workspace.call('setting',{key})).value;
  await workspace.call('setting',{key,value:{...record,completedAt:'2026-01-01T00:00:00Z'}});
  await daily.prepare(row.kind,true);await pause();
 }
 await daily.tick();
 for(const row of rows.filter(item=>item.kind!=='portfolio-review')){
  const detail=(await api(`/conversations/${row.id}`)).conversation;
  assert.equal(detail.messages.filter(message=>message.text===`Complete ${row.kind} report`).length,3);
  assert.ok(detail.messages.every(message=>!message.text.includes('No material changes')));
 }
 const beforePublication=runs.size;
 evidence.indexed[0].content_hash='new-publication';
 await daily.tick();await daily.tick();
 assert.equal(runs.size,beforePublication);
 assert.ok((await api('/conversations')).conversations.every(row=>row.message_count===2));
});

for(const kind of ['portfolio-review','prediction-markets-review']){
 test(`explicit ${kind} refresh keeps saved ownership and deduplicates concurrent and completed requests`,async t=>{
  const {attachDailyWorkflow}=require('./analystDaily.cjs');
  const runs=new Map();
  let providerUnavailable=false;
  const external=async(url,options={})=>{
   if(providerUnavailable)throw new Error('Provider unavailable during replay');
   if(url.endsWith('/readiness'))return {products:[],indexed:[]};
   if(url.endsWith('/changes'))return {events:[]};
   if(url==='/internal/reviews'){
    assert.equal(options.body.reviewKind,kind);
    const run={runId:`saved-run-${runs.size+1}`,conversationId:options.body.conversationId,
     state:'succeeded',outcome:'ready',reportMarkdown:'Complete refreshed report',completedAt:new Date().toISOString()};
    runs.set(run.runId,run);return run;
   }
   if(url.startsWith('/internal/reviews/'))return runs.get(url.split('/').at(-1));
   throw new Error('Unexpected '+url);
  };
  const {workspace,api}=await fixture(t,external);
  workspace.generate=accepted=>workspace.call('frame',{turnId:accepted.turn.id,type:'complete',text:'Notes for this review'});
  const now=()=>new Date('2026-09-19T15:00:00Z');
  const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now});
  const first=(await workspace.call('daily',{kind,date:'2026-09-17',title:kind})).conversation;
  const other=(await workspace.call('daily',{kind,date:'2026-09-16',title:kind})).conversation;
  const refresh=(conversationId,requestId)=>api(`/daily/${kind}`,{refresh:true,conversationId,requestId});
  const responses=await Promise.all([refresh(first.id,'first-click'),refresh(first.id,'first-click'),refresh(first.id,'while-pending')]);
  assert.ok(responses.every(response=>response.status===200&&response.conversation.id===first.id));
  assert.ok(responses.every(response=>response.conversation.activeTurn.id===responses[0].conversation.activeTurn.id));
  assert.equal(runs.size,1);
  const second=await refresh(other.id,'other-click');
  assert.equal(second.conversation.id,other.id);
  assert.notEqual(second.conversation.activeTurn.id,responses[0].conversation.activeTurn.id);
  assert.equal(runs.size,2);
  assert.equal((await refresh(other.id,'first-click')).status,409);
  assert.deepEqual(new Set([...runs.values()].map(run=>run.conversationId)),new Set([first.id,other.id]));
  await daily.tick();
  assert.equal((await api('/conversations')).conversations.length,2);
  assert.ok((await api('/conversations')).conversations.every(row=>row.message_count===1));
  providerUnavailable=true;
  for(const requestId of ['first-click','while-pending'])assert.equal((await refresh(first.id,requestId)).conversation.id,first.id);
  // A new workflow instance uses the durable request record before contacting providers.
  const restarted=attachDailyWorkflow({workspace:{...workspace,router:express.Router()},request:reviewTransport(external),now});
  const restored=await restarted.prepare(kind,true,{refresh:true,conversationId:other.id,requestId:'other-click'});
  assert.equal(restored.id,other.id);
  assert.equal(runs.size,2);
 });
}

test('startup gate preserves history and does not create failed chat turns; explanation retry reuses the saved report',async t=>{
 let ready=false;
 const {workspace,api}=await fixture(t,null,{canGenerate:()=>ready});
 assert.equal((await api('/messages',{requestId:'startup',text:'Hello'})).status,503);
 assert.equal((await api('/conversations')).conversations.length,0);
 const c=(await workspace.call('daily',{kind:'balance-review',date:'2026-09-06',title:'Balance Review'})).conversation;
 await workspace.call('append',{conversationId:c.id,sourceId:'report',text:'Dated verified balance report'});
 const original=await workspace.call('accept',{conversationId:c.id,requestId:'daily-narrative:run',text:'Explain Balance Review',internalPrompt:true,reviewPostId:'requested-post'});
 await workspace.call('frame',{turnId:original.turn.id,type:'failed',error:'Connecting'});
 const path=`/conversations/${c.id}/turns/${original.turn.id}/retry`;
 assert.equal((await api(path,{requestId:'retry'})).status,503);
 assert.equal((await api(`/conversations/${c.id}`)).conversation.messages.length,1);
 ready=true;
 const retry=await api(path,{requestId:'retry'});
 assert.equal(retry.status,202);
 assert.equal(retry.turn.review_post_id,'requested-post');
 assert.equal(retry.conversation.messages.length,1);
 await pause();
 assert.match(Socket.sockets[0].sent[0].text,/Dated verified balance report/);
 assert.match(Socket.sockets[0].sent[0].text,/Call get_balance_context, get_portfolio_context/);
 assert.doesNotMatch(Socket.sockets[0].sent[0].text,/get_dashboard_context|get_prediction_market_snapshot/);
 Socket.sockets[0].frame({type:'message_complete',text:'Concise explanation'});
 await pause();
 const final=(await api(`/conversations/${c.id}`)).conversation;
 assert.deepEqual(final.messages.map(m=>m.text),['Dated verified balance report','Concise explanation']);
 assert.equal(final.lastTurn.state,'complete');
});

test('automatic reviews keep their report without launching Hermes while its startup gate is closed',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const external=async url=>{
  if(url==='/internal/reviews')return {runId:'gated'};
  if(url==='/internal/reviews/gated')return {state:'succeeded',reportMarkdown:'Verified balance',outcome:'partial'};
  if(url.endsWith('/readiness'))return {};
  if(url.endsWith('/changes'))return {events:[]};
  throw new Error(url);
 };
 const {workspace,api}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),canGenerate:()=>false,now:()=>new Date('2026-09-06T15:00:00Z')});
 const result=await api('/daily/prediction-markets-review',{});
 await daily.tick();
 const c=(await api(`/conversations/${result.conversation.id}`)).conversation;
 assert.equal(c.messages.length,1);
 assert.equal(c.messages[0].role,'assistant');
 assert.match(c.messages[0].text,/Verified balance/);
 assert.equal(c.lastTurn.state,'complete');
 assert.equal(Socket.sockets.length,0);
});

for (const date of ['2026-09-06', '2026-09-07', '2026-09-08']) {
 test(`manual Prediction Markets Review acquires its own evidence on ${date}`, async t => {
  const {attachDailyWorkflow}=require('./analystDaily.cjs');
  let runs=0, readinessCalls=0;
  const report='# Predictive Markets Review\n\nPartial\n\n**Native order book:** Unavailable\n\n- Sizing withheld.';
  const external=async(url, options={})=>{
   if(url.endsWith('/readiness')) { readinessCalls++; throw new Error('Research provider unavailable'); }
   if(url==='/internal/reviews') {
    assert.equal(options.body.reviewKind,'prediction-markets-review');
    runs++;
    return {runId:'requested-prediction'};
   }
   if(url==='/internal/reviews/requested-prediction') return {state:'succeeded',outcome:'partial',reportMarkdown:report,completedAt:new Date().toISOString()};
   throw new Error('Unexpected '+url);
  };
  const {workspace,api}=await fixture(t,external);
  const narratives=[];
  workspace.generate=accepted=>{
   narratives.push(accepted.narrative);
   return workspace.call('frame',{turnId:accepted.turn.id,type:'complete',text:'Missing native book; sizing withheld.'});
  };
  const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date(`${date}T15:00:00Z`)});
  const old=(await workspace.call('daily',{kind:'prediction-markets-review',date,title:'Predictive Markets Review'})).conversation;
  await workspace.call('append',{conversationId:old.id,sourceId:`waiting:${old.id}:closed`,text:`Market closed on ${date}. Daily reviews resume on the next exchange trading day.`});
  await workspace.call('append',{conversationId:old.id,sourceId:'saved-note',text:'Keep this dated source note.'});
  const first=await api('/daily/prediction-markets-review',{});
  assert.equal(first.status,200);
  assert.equal(first.conversation.id,old.id);
  assert.ok(first.conversation.activeTurn);
  assert.equal(readinessCalls,0);
  assert.equal(runs,1);
  assert.deepEqual(first.conversation.messages.map(m=>m.text),['Keep this dated source note.','']);
  const sourceOwner=first.conversation.messages[1];
  assert.equal(sourceOwner.role,'assistant');
  assert.equal(sourceOwner.state,'running');
  assert.equal(sourceOwner.turn_id,first.conversation.activeTurn.id);
  assert.equal(sourceOwner.reviewRunId,first.conversation.reviewRunId);
  assert.equal(sourceOwner.reviewRunId,first.conversation.activeTurn.request_id.slice('daily-turn:'.length));
  assert.equal(sourceOwner.reviewPostId,first.conversation.activeTurn.review_post_id);
  assert.equal(sourceOwner.reviewNarrative,false);
  await daily.tick(); await pause();
  const saved=(await api(`/conversations/${old.id}`)).conversation;
  assert.ok(saved.messages.some(m=>m.text===report));
  assert.doesNotMatch(saved.messages.map(m=>m.text).join('\n'),/Daily reviews resume|Market closed on/);
  assert.deepEqual(narratives, [], 'the captured prediction report requires no second model pass');
  const again=await api('/daily/prediction-markets-review',{});
  assert.equal(again.conversation.id,old.id);
  assert.equal(runs,1);
 });
}

test('a holiday prediction review retains the provider block and never starts a recommendation narrative',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const report='# Predictive Markets Review\n\nBlocked\n\n**Native order book:** Unavailable\n\n- Provider offline; sizing withheld.';
 const external=async url=>{
  if(url==='/internal/reviews')return {runId:'offline-prediction'};
  if(url==='/internal/reviews/offline-prediction')return {state:'succeeded',outcome:'blocked',reportMarkdown:report};
  if(url.endsWith('/readiness'))return {};
  if(url.endsWith('/changes'))return {events:[]};
  throw new Error(url);
 };
 const {workspace,api}=await fixture(t,external);
 workspace.generate=()=>assert.fail('Unavailable evidence cannot start a recommendation narrative');
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-07T15:00:00Z')});
 const start=await api('/daily/prediction-markets-review',{});
 await daily.tick();
 const saved=(await api(`/conversations/${start.conversation.id}`)).conversation;
 assert.equal(saved.messages.at(-1).text,report);
 assert.equal(saved.lastTurn.state,'complete');
 assert.equal(saved.activeTurn,null);
});

test('automatic daily reviews remain paused on equity holidays without creating miscellaneous chats',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const {REQUIRED_PRODUCTS}=require('./analystPolicy.cjs');
 const date='2026-09-07';
 const external=async url=>{
  if(url.endsWith('/readiness'))return {
   products:REQUIRED_PRODUCTS.map(([product])=>({product,latestPublicationDate:date,stages:{received:true,parsed:true,validated:true,indexed:true}})),
   indexed:REQUIRED_PRODUCTS.map(([product])=>({product,publication_date:date,document_id:product,content_hash:'1'})),
  };
  if(url.endsWith('/changes'))return {events:[]};
  assert.fail('A holiday must not automatically start a review: '+url);
 };
 const {workspace,api}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date(`${date}T15:00:00Z`)});
 await daily.tick();
 const rows=(await api('/conversations')).conversations;
 assert.deepEqual(rows,[]);
 assert.equal((await workspace.call('setting',{key:'monitor-health'})).value.readiness.marketDay,false);
});

for (const timestamp of ['2026-09-04T22:00:00Z', '2026-09-05T15:00:00Z', '2026-09-06T15:00:00Z', '2026-09-07T15:00:00Z', '2026-09-08T12:00:00Z']) {
 test(`Portfolio Review opens the saved Friday after-close report at ${timestamp} without acquiring current inputs`, async t => {
  const {attachDailyWorkflow}=require('./analystDaily.cjs');
  let runs=[];
  const external=async url=>{
   if(url==='/internal/reviews?limit=500&view=portfolio-reference') return {runs};
   assert.fail('Historical review must not acquire research, broker data, or a new run: '+url);
  };
  const {workspace,api}=await fixture(t,external);
  workspace.generate=()=>assert.fail('Opening a saved review must not generate current commentary');
  const saved=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-04',title:'Portfolio Review'})).conversation;
  const report='# Portfolio Review\n\nNet liquidation: $100,000\nObserved: 2026-09-04T20:05:00Z';
  const citations=[{id:'cite_friday',publicationDate:'2026-09-04',sourceUri:'research://friday'}];
  await workspace.call('append',{conversationId:saved.id,sourceId:'midday',text:'Earlier intraday review',createdAt:'2026-09-04T17:00:00Z'});
  await workspace.call('append',{conversationId:saved.id,sourceId:'friday-report',text:report,citations,createdAt:'2026-09-04T20:06:00Z'});
  await workspace.call('setting',{key:`daily-run:${saved.id}`,value:{completedAt:'2026-09-04T20:06:00Z',fingerprint:'expired-current-inputs'}});
  await workspace.call('archive',{conversationId:saved.id,archived:true});
  runs=[{runId:'friday-close',conversationId:saved.id,reviewKind:'portfolio-review',state:'succeeded',outcome:'partial',reportMarkdown:report,citations,completedAt:'2026-09-04T20:06:00Z',dependencies:{portfolio:{status:'ready',asOf:'2026-09-04T20:05:00Z',detail:{liveVerified:true}}}}];
  attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date(timestamp)});
  const first=await api('/daily/portfolio-review',{});
  assert.equal(first.status,200);
  assert.equal(first.conversation.id,saved.id);
  assert.equal(first.conversation.archived,0);
  assert.deepEqual(first.conversation.referenceReview,{runId:'friday-close',messageId:first.conversation.messages[1].id,targetDate:'2026-09-04',tradingDate:'2026-09-04',asOf:'2026-09-04T20:05:00.000Z',afterClose:true});
  assert.equal(first.conversation.messages[1].text,report);
  assert.deepEqual(first.conversation.messages[1].citations,citations);
  assert.equal(first.conversation.activeTurn,null);
  const again=await api('/daily/portfolio-review',{});
  assert.deepEqual(again.conversation.messages,first.conversation.messages);
  const reloaded=(await api(`/conversations/${saved.id}`)).conversation;
  assert.deepEqual(reloaded.referenceReview,first.conversation.referenceReview);
  assert.equal((await api('/conversations')).conversations.length,1);
 });
}

test('Portfolio Review uses the latest verified saved observation and preserves its actual Eastern date when Friday is missing',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 let runs=[];
 const external=async url=>{
  if(url==='/internal/reviews?limit=500&view=portfolio-reference')return {runs};
  if(url.startsWith('/internal/reviews/') && runs.some(run=>url===`/internal/reviews/${run.runId}`))return {run:runs.find(run=>url===`/internal/reviews/${run.runId}`)};
  assert.fail('Unexpected live acquisition '+url);
 };
 const {workspace,api}=await fixture(t,external);
 const saved=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-03',title:'Portfolio Review'})).conversation;
 const valid={runId:'thursday',conversationId:saved.id,reviewKind:'portfolio-review',state:'succeeded',outcome:'partial',reportMarkdown:'# Portfolio Review\nThursday observation',completedAt:'2026-09-04T01:25:00Z',dependencies:{portfolio:{status:'ready',asOf:'2026-09-04T01:24:30Z',detail:{liveVerified:true}}}};
 const invalid=(id,changes)=>({...valid,runId:id,reportMarkdown:'Do not display '+id,completedAt:'2026-09-04T21:00:00Z',dependencies:{portfolio:{status:'ready',asOf:'2026-09-04T20:55:00Z',detail:{liveVerified:true}}},...changes});
 const deleted=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-04',title:'Portfolio Review'})).conversation;
 await workspace.call('delete',{conversationId:deleted.id});
 runs=[
  invalid('deleted',{conversationId:deleted.id}),
  invalid('failed',{state:'failed'}), invalid('cancelled',{state:'cancelled'}), invalid('running',{state:'running'}),
  invalid('blocked',{outcome:'blocked'}), invalid('offline',{dependencies:{portfolio:{status:'failed',asOf:'2026-09-04T20:55:00Z',detail:{liveVerified:false}}}}),
  ...['stale','cache-only','mock','seed'].map(status=>invalid(status,{dependencies:{portfolio:{status,asOf:'2026-09-04T20:55:00Z',detail:{liveVerified:false}}}})),
  invalid('unverified',{dependencies:{portfolio:{status:'ready',asOf:'2026-09-04T20:55:00Z',detail:{liveVerified:false}}}}),
  invalid('missing timestamp',{dependencies:{portfolio:{status:'ready',asOf:null,detail:{liveVerified:true}}}}),
  invalid('future',{completedAt:'2026-09-08T21:00:00Z',dependencies:{portfolio:{status:'ready',asOf:'2026-09-08T20:55:00Z',detail:{liveVerified:true}}}}),
  valid,
 ];
 attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-07T15:00:00Z')});
 const result=await api('/daily/portfolio-review',{});
 assert.equal(result.status,200);
 assert.equal(result.conversation.id,saved.id);
 assert.equal(result.conversation.referenceReview.tradingDate,'2026-09-03');
 assert.equal(result.conversation.referenceReview.targetDate,'2026-09-04');
 assert.deepEqual(result.conversation.messages.map(m=>m.text),[valid.reportMarkdown]);
});

test('Portfolio Review without saved evidence starts one real review on a holiday instead of creating an empty closing report',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const runs=[];
 const external=async(url,options={})=>{
  if(url==='/internal/reviews?limit=500&view=portfolio-reference')return {runs:[]};
  if(url.endsWith('/readiness'))return {};
  if(url==='/internal/reviews') { const run={runId:'first-holiday-review',...options.body}; runs.push(run); return run; }
  assert.fail('Unexpected provider request '+url);
 };
 const {workspace,api}=await fixture(t,external);
 attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-07T15:00:00Z')});
 const first=await api('/daily/portfolio-review',{});
 assert.equal(first.status,200);
 assert.equal(first.conversation.trading_date,'2026-09-07');
 assert.equal(first.conversation.referenceReview,null);
 assert.ok(first.conversation.activeTurn);
 assert.equal(first.conversation.messages.length,1);
 const placeholder=first.conversation.messages[0];
 assert.equal(placeholder.role,'assistant');
 assert.equal(placeholder.text,'');
 assert.equal(placeholder.state,'running');
 assert.equal(placeholder.turn_id,first.conversation.activeTurn.id);
 assert.equal(placeholder.reviewRunId,first.conversation.reviewRunId);
 assert.equal((await api('/daily/portfolio-review',{})).conversation.id,first.conversation.id);
 assert.equal(runs.length,1);
 assert.equal(runs[0].conversationId,first.conversation.id);
});

for (const [capturedAt,status] of [['2026-09-04T20:05:00Z','partial'],['2026-09-06T16:00:00Z','ready'],['2026-09-07T14:00:00Z','partial']]) {
 test(`Portfolio Review reopens verified ${status} holdings captured at ${capturedAt}`,async t=>{
  const {attachDailyWorkflow}=require('./analystDaily.cjs');
  let runs=[];
  const external=async url=>{
   if(url==='/internal/reviews?limit=500&view=portfolio-reference')return {runs};
  if(url.startsWith('/internal/reviews/') && runs.some(run=>url===`/internal/reviews/${run.runId}`))return {run:runs.find(run=>url===`/internal/reviews/${run.runId}`)};
   assert.fail('A usable saved review must not acquire new inputs: '+url);
  };
  const {workspace,api}=await fixture(t,external);
  const saved=(await workspace.call('daily',{kind:'portfolio-review',date:capturedAt.slice(0,10),title:'Portfolio Review'})).conversation;
  const valid={runId:'saved-partial',conversationId:saved.id,reviewKind:'portfolio-review',state:'succeeded',outcome:'partial',reportMarkdown:'# Portfolio Review\nDated holdings; unavailable marks stay unavailable.',completedAt:'2026-09-07T14:30:00Z',dependencies:{portfolio:{status,asOf:capturedAt,detail:{liveVerified:true}}}};
  runs=[{...valid,runId:'unverified',dependencies:{portfolio:{status:'partial',asOf:'2026-09-07T14:20:00Z',detail:{liveVerified:false}}}},valid];
  attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-07T15:00:00Z')});
  const first=await api('/daily/portfolio-review',{});
  assert.equal(first.status,200);
  assert.equal(first.conversation.id,saved.id);
  assert.equal(first.conversation.referenceReview.runId,valid.runId);
  assert.equal(first.conversation.referenceReview.tradingDate,capturedAt.slice(0,10));
  assert.equal(first.conversation.referenceReview.targetDate,'2026-09-04');
  assert.equal(first.conversation.referenceReview.afterClose,capturedAt.startsWith('2026-09-04'));
  assert.deepEqual(first.conversation.messages.map(m=>m.text),[valid.reportMarkdown]);
  assert.equal((await api('/daily/portfolio-review',{})).conversation.messages.length,1);
 });
}

test('an existing empty Portfolio Review starts in place and never restores a deleted review',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 let runs=[];
 let started=0;
 const external=async(url)=>{
  if(url==='/internal/reviews?limit=500&view=portfolio-reference')return {runs};
  if(url.startsWith('/internal/reviews/') && runs.some(run=>url===`/internal/reviews/${run.runId}`))return {run:runs.find(run=>url===`/internal/reviews/${run.runId}`)};
  if(url.endsWith('/readiness'))return {};
  if(url==='/internal/reviews'){ started+=1; return {runId:'replacement-review'}; }
  assert.fail('Unexpected request '+url);
 };
 const {workspace,api}=await fixture(t,external);
 const deleted=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-02',title:'Portfolio Review'})).conversation;
 await workspace.call('delete',{conversationId:deleted.id});
 runs=[{runId:'deleted-report',conversationId:deleted.id,reviewKind:'portfolio-review',state:'succeeded',outcome:'partial',reportMarkdown:'Deleted report',completedAt:'2026-09-02T21:01:00Z',dependencies:{portfolio:{status:'ready',asOf:'2026-09-02T21:00:00Z',detail:{liveVerified:true}}}}];
 const empty=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-04',title:'Portfolio Review'})).conversation;
 await workspace.call('setting',{key:`portfolio-reference:${empty.id}`,value:{targetDate:'2026-09-04',missing:true}});
 attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date('2026-09-07T15:00:00Z')});
 const opened=await api('/daily/portfolio-review',{conversationId:empty.id});
 assert.equal(opened.conversation.id,empty.id);
 assert.ok(opened.conversation.activeTurn);
 assert.equal(opened.conversation.referenceReview,null);
 assert.equal(started,1);
 assert.equal((await api('/conversations')).conversations.length,1);
 assert.equal((await workspace.call('deleted',{conversationId:deleted.id})).deleted,true);
});

test('market close and restarted workers keep scheduled captures out of conversation history',async t=>{
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 const {REQUIRED_PRODUCTS}=require('./analystPolicy.cjs');
 const date='2026-09-28';
 let observed=new Date(`${date}T19:55:00Z`);
 const external=async url=>{
  if(url.endsWith('/readiness'))return {products:REQUIRED_PRODUCTS.map(([product])=>({product,latestPublicationDate:date,stages:{received:true,parsed:true,validated:true,indexed:true}})),indexed:REQUIRED_PRODUCTS.map(([product])=>({product,publication_date:date,document_id:product,content_hash:'1'}))};
  if(url.endsWith('/changes'))return {events:[]};
  assert.fail('Market-close background work must not create a review: '+url);
 };
 const {workspace,api}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>observed});
 for(const time of ['19:55:00Z','20:05:00Z','20:29:59Z','20:30:00Z','21:00:00Z']){
  observed=new Date(`${date}T${time}`);
  await daily.tick();await daily.tick();
 }
 const restarted=attachDailyWorkflow({workspace:{...workspace,router:express.Router()},request:reviewTransport(external),now:()=>observed});
 await restarted.tick();await restarted.tick();
 assert.equal((await api('/conversations')).conversations.length,0);
 const capture=await api('/automation/portfolio-close');
 assert.equal(capture.status,'pending','only the Hermes POST starts the close capture');
 assert.equal(capture.reason,'not_started');
 assert.equal(capture.scheduledTime,'16:30');
 const baseline=await api('/automation/portfolio-close/baseline');
 assert.equal(baseline.sessionDate,'2026-09-25','the baseline is the preceding session');
 assert.equal(baseline.status,'pending');
});

test('Hermes close capture starts one headless portfolio review after the close, never before, without a chat', async t => {
 const {attachDailyWorkflow}=require('./analystDaily.cjs');
 let observed=new Date('2026-09-28T20:29:00Z');
 const starts=[];
 const run=()=>({runId:`close-run-${starts.length}`,conversationId:'review:portfolio-review',reviewKind:'portfolio-review',createdAt:observed.toISOString()});
 const external=async(url,options={})=>{
  if(url.endsWith('/readiness'))return {products:[],indexed:[]};
  if(url==='/internal/reviews'){starts.push(options.body);return {...run(),state:'queued'};}
  if(url.startsWith('/internal/reviews/'))return {run:{...run(),state:'running'}};
  throw new Error('Unexpected '+url);
 };
 const {workspace,api,base}=await fixture(t,external);
 const daily=attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>observed});
 const post=async()=>(await fetch(`${base}/automation/portfolio-close`,{method:'POST'})).json();
 const early=await post();
 assert.equal(early.status,'scheduled');
 assert.equal(early.reason,'before_capture_time');
 observed=new Date('2026-09-28T20:30:00Z');
 const started=await post();
 assert.equal(started.status,'running',JSON.stringify(started));
 assert.equal(started.runId,'close-run-1');
 assert.equal(starts.length,1);
 assert.equal(starts[0].reviewKind,'portfolio-review');
 assert.equal(starts[0].conversationId,undefined);
 await daily.tick();
 assert.equal((await api('/conversations')).conversations.length,0,'the close capture never creates a chat');
 assert.equal((await post()).runId,started.runId,'a repeated POST reuses the same capture');
 await daily.tick();
 assert.equal(starts.length,1);
});

for (const time of ['13:00:00Z', '20:15:00Z']) {
 test(`explicit Portfolio Update acquires fresh evidence at ${time} despite incomplete publications`,async t=>{
  const {attachDailyWorkflow}=require('./analystDaily.cjs');
  let started=0;
  const external=async(url,options={})=>{
   if(url.endsWith('/readiness'))return {products:[],indexed:[]};
   if(url==='/internal/reviews'){
    assert.equal(options.body.reviewKind,'portfolio-review');started++;
    return {runId:'updated-review',state:'queued'};
   }
   throw new Error('Unexpected '+url);
  };
  const {workspace,api}=await fixture(t,external);
  attachDailyWorkflow({workspace,request:reviewTransport(external),now:()=>new Date(`2026-09-08T${time}`)});
  const saved=(await workspace.call('daily',{kind:'portfolio-review',date:'2026-09-08',title:'Portfolio Review'})).conversation;
  const response=await api('/daily/portfolio-review',{refresh:true,conversationId:saved.id});
  assert.equal(response.status,200);
  assert.equal(response.conversation.id,saved.id);
  assert.equal(started,1);
  assert.ok(response.conversation.activeTurn);
 });
}

test('Stop durably interrupts a queued review before awaiting absent or slow worker cancellation', async t => {
 let release;
 const cancellation=new Promise(resolve=>{release=resolve;});
 const calls=[];
 const record={runId:'queued-run',turnId:'queued-turn',startPending:true,reviewPhase:'queued'};
 const request=async(url,{body}={})=>{
  calls.push({url,body});
  if(url.endsWith('/recover')||url.endsWith('/import'))return {};
  if(url.endsWith('/get'))return {conversation:{id:'queued-chat',activeTurn:{id:'queued-turn'}}};
  if(url.endsWith('/setting'))return Object.hasOwn(body,'value')?{value:body.value}:{value:record};
  if(url.endsWith('/frame'))return {};
  if(url.endsWith('/cancel-review')){await cancellation;throw new Error('Worker not yet created');}
  assert.fail(`Unexpected stop operation ${url}`);
 };
 const workspace=createAnalystWorkspace({request});
 const app=express();app.use(express.json());app.use(workspace.router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{release();server.closeAllConnections();server.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/conversations/queued-chat/turns/queued-turn/stop`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(1000),
 });
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{ok:true});
 const ownership=calls.find(call=>call.url.endsWith('/get'));
 assert.equal(ownership.body.includeBriefs,false);
 const frameIndex=calls.findIndex(call=>call.url.endsWith('/frame'));
 const cancelIndex=calls.findIndex(call=>call.url.endsWith('/cancel-review'));
 assert.ok(frameIndex>=0&&frameIndex<cancelIndex);
 const saved=calls.find(call=>call.url.endsWith('/setting')&&Object.hasOwn(call.body,'value')).body.value;
 assert.equal(saved.reviewPhase,'terminal');
 assert.equal(saved.reviewState,'cancelled');
 assert.equal(saved.startPending,false);
 assert.equal(saved.error,true);
});

// Fixtures for the Inbox findings projection. Rows mirror the sidecar's
// findings table: a row-level state column plus the stored payload.
const inboxNow=new Date('2026-09-22T16:00:00Z');
const attentionRow=(id,state,overrides={})=>({id,source_id:id,symbol:'AMZN',action:'verification issue',state,unread:1,
 updated_at:'2026-09-22T15:59:00Z',fingerprint:`${id}-fingerprint`,payload:{attentionVersion:1,id,state:'open',kind:'operational',priority:1,
  publicationTime:'2026-09-22T15:30:00Z',presentation:{subject:'IB Gateway',date:'2026-09-22',rows:[{label:'Issue',text:'Portfolio cannot refresh.'}]},...overrides}});
const signalRow=(id,date,value,state)=>({id,source_id:id,symbol:'AMZN',action:'signal change',state,unread:1,updated_at:`${date}T01:00:00Z`,
 fingerprint:`${id}-fingerprint`,payload:{quantity:15,holdingsVerified:true,holdingsVerifiedAt:'2026-09-14T19:00:00Z',
  citation:{title:'Risk Ranges',publicationDate:date,sourceUri:`https://app.hedgeye.com/feed_items/${id}`},
  event:{entityId:'AMZN',entityType:'ticker',productKey:'risk-ranges',productLabel:'Risk Ranges',eventType:'risk_range',fieldPath:'data.AMZN',
   signalValue:value,qualityStatus:'validated',publishedAt:`${date}T00:00:00Z`,marketDate:date,sourceMessageId:id,sourceUrl:`https://app.hedgeye.com/feed_items/${id}`}}});
const inboxHistory=()=>[
 attentionRow('open-operational','open'),
 attentionRow('open-portfolio','open',{kind:'portfolio',priority:0,quantity:5,holdingsVerified:true,holdingsVerifiedAt:'2026-09-22T15:59:30Z'}),
 attentionRow('stale-portfolio','open',{kind:'portfolio',quantity:5,holdingsVerified:true,holdingsVerifiedAt:'2026-09-22T15:00:00Z'}),
 attentionRow('acknowledged','open',{priority:2}),
 attentionRow('payload-state-only','',{publicationTime:'2026-09-22T15:45:00Z'}),
 attentionRow('superseded-column','superseded'),
 attentionRow('superseded-payload','superseded',{state:'superseded'}),
 attentionRow('resolved','resolved',{state:'resolved'}),
 attentionRow('resolved-column-only','resolved'),
 attentionRow('unavailable','unavailable',{state:'unavailable'}),
 {...attentionRow('review-source-warning','open',{managedBy:'review-sources'})},
 signalRow('legacy-baseline','2026-09-08','BULLISH','superseded'),
 signalRow('legacy-flip','2026-09-09','BEARISH','open'),
 signalRow('legacy-resolved','2026-09-10','NEUTRAL','resolved'),
].map((row,index)=>index===3?{...row,unread:0,acknowledged_at:'2026-09-22T15:40:00Z'}:row);
const projectedHistory=rows=>rows.filter(row=>!['superseded','resolved','unavailable'].includes(row.state));

test('the attention Inbox is identical with and without superseded, resolved and unavailable history', () => {
 const {buildAnalystInbox}=require('../../utils/analystInboxAlerts.cjs');
 const rows=inboxHistory();
 const full=buildAnalystInbox({attentionVersion:1,unread:rows.filter(row=>row.unread).length,findings:rows},inboxNow);
 const projected=projectedHistory(rows);
 assert.ok(projected.length<rows.length);
 const filtered=buildAnalystInbox({attentionVersion:1,unread:projected.filter(row=>row.unread).length,findings:projected},inboxNow);
 assert.deepEqual(filtered,full);
 assert.deepEqual(full.findings.map(row=>row.id),['open-portfolio','payload-state-only','open-operational','acknowledged']);
 assert.equal(full.unread,3);
 // The legacy projection still derives a transition from superseded history,
 // which is why the route never filters it.
 const legacy=buildAnalystInbox({findings:rows},inboxNow);
 assert.notDeepEqual(buildAnalystInbox({findings:projected},inboxNow).findings,legacy.findings);
});

async function inboxApp(t,findings){
 const calls=[];
 const workspace=createAnalystWorkspace({request:async(url,{body}={})=>{
  const operation=url.split('/').at(-1);
  if(operation==='recover'||operation==='import')return {};
  calls.push({operation,body});
  if(operation==='finding-read')return {ok:true,acknowledged:true};
  return findings(body);
 }});
 const app=express();app.use(express.json());app.use(workspace.router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const inbox=async()=>{const response=await fetch(`${base}/inbox`);return {status:response.status,...await response.json()};};
 return {calls,inbox,base};
}

test('concurrent Inbox reads share one projected findings read for two seconds and writes invalidate it', async t => {
 let current=Date.parse('2026-09-22T16:00:00Z');
 t.mock.method(Date,'now',()=>current);
 const rows=inboxHistory();
 const {calls,inbox,base}=await inboxApp(t,body=>({attentionVersion:1,
  findings:Array.isArray(body.excludeStates)?rows.filter(row=>!body.excludeStates.includes(row.state)):rows}));
 const [first,second]=await Promise.all([inbox(),inbox()]);
 assert.deepEqual(first,second);
 assert.equal(first.status,200);
 assert.deepEqual(calls,[{operation:'findings',body:{excludeStates:['superseded','resolved','unavailable']}}]);
 current+=1_999;
 await inbox();
 assert.equal(calls.length,1);
 current+=1;
 await inbox();
 assert.equal(calls.length,2);
 const acknowledged=await fetch(`${base}/inbox/open-operational/read`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({acknowledge:true})});
 assert.equal(acknowledged.status,200);
 await inbox();
 // Dismissing also looks up the alert's discussion thread; that read is not an Inbox read.
 assert.deepEqual(calls.filter(call=>call.body?.key!=='inbox-threads-v1').map(call=>call.operation),['findings','findings','finding-read','findings'],'an acknowledgment is never answered from an earlier read');
});

test('dismissing an alert deletes its Analyst discussion and unlinks it; other threads stay', async t => {
 let threads={'alert-a':'conv-a','alert-b':'conv-b'};
 const {calls,base}=await inboxApp(t,body=>{
  if(body.key==='inbox-threads-v1'){ if('value' in body)threads=body.value; return {value:threads}; }
  return {ok:true};
 });
 const response=await fetch(`${base}/inbox/alert-a/read`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acknowledge:true})});
 assert.equal(response.status,200);
 for(let i=0;i<50&&threads['alert-a'];i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(threads,{'alert-b':'conv-b'});
 assert.deepEqual(calls.filter(call=>call.operation==='delete').map(call=>call.body.conversationId),['conv-a']);
 const listed=await (await fetch(`${base}/inbox-threads`)).json();
 assert.deepEqual(listed.threads,{'alert-b':'conv-b'});
});

test('the legacy Inbox and a rejected projection read every finding', async t => {
 const rows=inboxHistory();
 const legacy=await inboxApp(t,()=>({findings:rows}));
 const {buildAnalystInbox}=require('../../utils/analystInboxAlerts.cjs');
 const result=await legacy.inbox();
 assert.deepEqual(result.findings.map(row=>row.id),buildAnalystInbox({findings:rows}).findings.map(row=>row.id));
 assert.deepEqual(legacy.calls.map(call=>call.body),[{excludeStates:['superseded','resolved','unavailable']},{}]);
 const rejected=await inboxApp(t,body=>{
  if(body.excludeStates)throw Object.assign(new Error('Unknown finding state'),{statusCode:409});
  return {attentionVersion:1,findings:rows};
 });
 assert.equal((await rejected.inbox()).status,200);
 const failing=await inboxApp(t,()=>{throw Object.assign(new Error('Sidecar unavailable'),{statusCode:503});});
 assert.equal((await failing.inbox()).status,503);
 assert.equal((await failing.inbox()).status,503,'a failed read is not cached');
 assert.equal(failing.calls.length,2);
 assert.deepEqual(rejected.calls.map(call=>call.body),[{excludeStates:['superseded','resolved','unavailable']},{}]);
});

test('DELETE forwards bounded requester headers for the deletion audit', async t => {
 const bodies=[];
 const workspace=createAnalystWorkspace({request:async(url,{body}={})=>{
  if(url.endsWith('/delete'))bodies.push(body);
  return {ok:true};
 }});
 const app=express();app.use(express.json());app.use(workspace.router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(`${base}/conversations/audited-chat`,{method:'DELETE',
  headers:{'User-Agent':`Mozilla/5.0 ${'x'.repeat(600)}`,Origin:'http://localhost:3000'}});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{ok:true});
 assert.equal(bodies[0].conversationId,'audited-chat');
 assert.equal(bodies[0].requestedBy.origin,'http://localhost:3000');
 assert.equal(bodies[0].requestedBy.userAgent.length,512);
 assert.match(bodies[0].requestedBy.userAgent,/^Mozilla\/5\.0 x+$/);
 await fetch(`${base}/conversations/anonymous-chat`,{method:'DELETE',headers:{'User-Agent':''}});
 assert.deepEqual(bodies[1].requestedBy,{userAgent:null,origin:null});
});

test('a generated response reports its settlement once to an optional timing listener', async t => {
 const {workspace}=await fixture(t);
 const accepted=await workspace.call('accept',{requestId:'listener-response',text:'Question'});
 const settled=[];
 workspace.generate({...accepted,onSettled:type=>settled.push(type)});
 await new Promise(resolve=>setImmediate(resolve));
 Socket.sockets.at(-1).frame({type:'message_complete',text:'Saved answer'});
 for(let index=0;index<50&&!settled.length;index+=1)await pause();
 assert.deepEqual(settled,['complete']);
 Socket.sockets.at(-1).close();
 await pause();
 assert.deepEqual(settled,['complete']);
});

test('a client that leaves during the tail handshake leaves no poller or write listener behind', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 let releaseCursor;
 let cursorStarted;
 const started=new Promise(resolve=>{cursorStarted=resolve;});
 const operations=[];
 const request=async url=>{
  const operation=url.split('/').at(-1);operations.push(operation);
  if(operation==='event-cursor'){cursorStarted();await new Promise(resolve=>{releaseCursor=resolve;});return {cursor:4};}
  return {events:[],ok:true};
 };
 const {workspace,base}=await fixture(t,null,{request});
 const controller=new AbortController();
 const connecting=fetch(base+'/events?after=latest',{signal:controller.signal}).catch(error=>error);
 await started;
 controller.abort();
 await connecting;
 // Let the server observe the disconnect before the handshake completes.
 for(let index=0;index<20;index+=1)await pause();
 releaseCursor();
 await pause();
 await workspace.call('frame',{turnId:'response',type:'delta_batch',entries:[]});
 t.mock.timers.tick(1_500);
 await pause();
 assert.deepEqual(operations,['event-cursor','frame']);
});
