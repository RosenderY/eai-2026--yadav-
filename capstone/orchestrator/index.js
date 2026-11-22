import {randomUUID} from 'node:crypto';
import {serve,store,save,now,env,attempt} from '../shared/runtime.js';
import {validOrder} from '../shared/schema.js';
const db=store('saga-store.json',{sagas:{},businessKeys:{}});
const persist=()=>save('saga-store.json',db);
const owner=randomUUID(),busy=new Set();
const endpoints={
 payment:['PAYMENT_URL','/payment/authorize','authorize'],inventory:['INVENTORY_URL','/inventory/reserve','reserve'],
 shipping:['SHIPPING_URL','/shipping/create'],notification:['NOTIFICATION_URL','/notification/send'],
 payment_refund:['PAYMENT_URL','/payment/refund','refund'],inventory_release:['INVENTORY_URL','/inventory/release','release']
};
async function call(api,ctx,s,step) {
  const [service,path,key]=endpoints[step],o=s.order,body={orderId:o.orderId};
  if(step==='payment'){
    const cents=o.items.reduce((n,i)=>n+BigInt(i.unitPrice.replace('.',''))*BigInt(i.quantity),0n);
    body.amount=(cents/100n)+'.'+String(cents%100n).padStart(2,'0');
  }
  if(step==='inventory')body.items=o.items;
  if(step==='notification')body.recipient=o.customer.email;
  const records=step.includes('_')?s.compensations:s.steps;
  try {await api.request(ctx,step,env[service]+path,body,key&&key+':'+s.businessKey);records.push({step,status:'success',at:now()});}
  catch(e){records.push({step,status:e.code==='timeout'?'timeout':'failed',at:now()});throw e;}
  finally{s.updatedAt=now();s.parent=ctx.parent;persist();}
}
async function outcome(api,ctx,s,state,extra={}) {
  const {orderId,source,orderType,customer}=s.order;
  const envelope={correlationId:ctx.cid,businessKey:s.businessKey,orderId,source,orderType,recipient:customer.email,state,...extra,occurredAt:now()};
  s.state=state;s.updatedAt=now();s.outcome={routingKey:'order.'+state,envelope};persist();
  await emit(api,ctx,s);
}
async function emit(api,ctx,s){
  api.trace(ctx,'saga.outcome');
  await api.publish('orders.outcome',s.outcome.routingKey,s.outcome.envelope,{correlationId:ctx.cid,causationId:ctx.parent});
}
const successful=arr=>arr.filter(x=>x.status==='success').map(x=>x.step);
async function compensate(api,ctx,s,code) {
  const undo={inventory:'inventory_release',payment:'payment_refund'};
  for(const step of successful(s.steps).reverse()) {
    const action=undo[step];if(!action||successful(s.compensations).includes(action))continue;
    try {await call(api,ctx,s,action);}catch{await outcome(api,ctx,s,'compensation_failed',{code});return;}
  }
  await outcome(api,ctx,s,'compensated',{code});
}
async function consumeOrder(api,ch,msg) {
  const h=msg.properties.headers||{},cid=h.correlationId,queue='saga.queue';
  let o;try{o=JSON.parse(msg.content);if(!validOrder(o)||!cid)throw Error();}catch{return api.quarantine(ch,msg);}
  const key=o.source+':'+o.orderId,ctx={cid,parent:h.causationId,attempt:attempt(msg,queue)};
  const consumeId=api.trace(ctx,'saga.consume');
  let s=db.sagas[cid];
  if(s && !['parked','processing'].includes(s.state)){await emit(api,ctx,s);ch.ack(msg);return;}
  if(s?.state==='processing' && !s.waitingRetry){
    if(s.owner!==owner) {api.trace(ctx,'saga.stuck');await outcome(api,ctx,s,'needs_attention');}
    ch.ack(msg);return;
  }
  if(!s)s=db.sagas[cid]={businessKey:key,order:o,state:'processing',owner,steps:[],compensations:[],updatedAt:now()};
  const duplicate=db.businessKeys[key] && db.businessKeys[key]!==cid;
  api.trace(ctx,'saga.dedupe',duplicate?'duplicate':'success');
  if(duplicate){await outcome(api,ctx,s,'duplicate',{duplicateOf:db.businessKeys[key]});ch.ack(msg);return;}
  db.businessKeys[key]=cid;s.waitingRetry=false;s.owner=owner;
  await outcome(api,ctx,s,'processing');
  const steps=o.orderType==='b2b'?['inventory','shipping','notification']:['payment','inventory','shipping','notification'];
  for(const [i,step] of steps.entries()) {
    try {await call(api,ctx,s,step);}
    catch(e){
      if(!i && e.status>=500) {
        s.waitingRetry=true;persist();
        if(!await api.retry(ch,msg,ctx,queue,e.code,consumeId))return;
        await outcome(api,ctx,s,'parked');
      }else if(!i)await outcome(api,ctx,s,'failed',{code:e.code});
      else await compensate(api,ctx,s,e.code);
      ch.ack(msg);return;
    }
  }
  await outcome(api,ctx,s,'completed');ch.ack(msg);
}
serve('orchestrator',async(api,consume)=>{
  for(const [cid,s] of Object.entries(db.sagas))if(s.state==='processing'&&s.owner!==owner&&!s.waitingRetry){
    const ctx={cid,parent:s.parent||cid};api.trace(ctx,'saga.stuck');await outcome(api,ctx,s,'needs_attention');
  }
  await api.ch.prefetch(Number(env.SAGA_CONCURRENCY));
  await consume('saga.queue',(ch,msg)=>consumeOrder(api,ch,msg));
},async(api,method,path)=>{
  if(method==='GET'&&path==='/sagas/stuck')return [200,{sagas:Object.entries(db.sagas)
    .filter(([,s])=>['needs_attention','compensation_failed'].includes(s.state))
    .map(([correlationId,s])=>({correlationId,businessKey:s.businessKey,state:s.state,
      completedSteps:successful(s.steps),compensatedSteps:successful(s.compensations),since:s.updatedAt}))}];
  const m=/^\/sagas\/([^/]+)\/compensate$/.exec(path);
  if(method!=='POST'||!m)return [404,{}];
  const cid=m[1],s=db.sagas[cid];if(!s)return [404,{}];
  if(busy.has(cid))return [409,{code:'compensation_in_progress'}];
  if(s.state==='compensated'&&s.operatorCompensation)return [200,{correlationId:cid,state:s.state}];
  if(!['needs_attention','compensation_failed'].includes(s.state))return [409,{code:'saga_not_stuck'}];
  busy.add(cid);
  try{
    const ctx={cid,parent:s.parent||cid};api.trace(ctx,'saga.operator_compensate');
    s.operatorCompensation={at:now()};persist();
    await compensate(api,ctx,s,s.outcome.envelope.code||'operator_compensated');
    return [200,{correlationId:cid,state:s.state}];
  }finally{busy.delete(cid);}
});
