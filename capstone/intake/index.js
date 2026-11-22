import {createHash,randomUUID} from 'node:crypto';
import {serve,env,now,store,save,invalid} from '../shared/runtime.js';
import {validOrder} from '../shared/schema.js';
import {translateB2B,translateWeb,translateMobile} from './translate.js';
const keys=Object.assign(Object.create(null),store('idempotency-store.json',{}));
const orders=store('orders.json',{});
const persist=()=>save('idempotency-store.json',keys);
for(const [key,r] of Object.entries(keys)) if(r.state==='in_flight')delete keys[key];
persist();
const moves={
 accepted:['processing','parked','completed','failed','compensated','compensation_failed','needs_attention','duplicate'],
 processing:['parked','completed','failed','compensated','compensation_failed','needs_attention'],
 parked:['processing','completed','failed','compensated','compensation_failed','needs_attention'],
 needs_attention:['compensated','compensation_failed'],compensation_failed:['compensated','compensation_failed']
};
async function setup(api,consume) {
  const q='intake.lifecycle';
  await api.ch.assertQueue(q,{durable:true}); await api.ch.bindQueue(q,'orders.outcome','#');
  await consume(q,async(ch,msg)=>{
    let e;try{e=JSON.parse(msg.content);}catch{ch.ack(msg);return;}
    const view=orders[e.correlationId];
    if(view && moves[view.state]?.includes(e.state)) {
      Object.assign(view,{state:e.state,updatedAt:e.occurredAt,code:e.code,duplicateOf:e.duplicateOf});save('orders.json',orders);
    }
    ch.ack(msg);
  });
}
const validation=message=>invalid(400,'validation_error',{message});
function source(type,raw) {
  const media=(type||'').split(';')[0].trim().toLowerCase();
  if(['text/xml','application/xml'].includes(media)) {
    const enc=/charset=["']?([^;"' ]+)/i.exec(type)?.[1] || /encoding=["']([^"']+)/i.exec(raw.subarray(0,200).toString('latin1'))?.[1] || 'utf-8';
    return [translateB2B,new TextDecoder(enc).decode(raw)];
  }
  if(media!=='application/json')throw invalid(415,'unsupported_media_type');
  const body=JSON.parse(raw);
  if(body?.orderId && body.customer && typeof body.customer==='object')return [translateWeb,body];
  if(body?.oid)return [translateMobile,body];
  throw validation('Unrecognised order shape');
}
async function accept(api,headers,raw) {
  const key=headers['idempotency-key'];
  if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw validation('A valid Idempotency-Key is required');
  const hash=createHash('sha256').update(raw).digest('hex');
  const prev=keys[key];
  if(prev){
    if(prev.bodySha256!==hash)throw invalid(409,'idempotency_payload_mismatch');
    if(prev.state==='in_flight')throw invalid(409,'idempotency_conflict');
    return [prev.response.status,prev.response.body];
  }
  const ctx={cid:randomUUID(),parent:null};
  const entry=keys[key]={correlationId:ctx.cid,bodySha256:hash,state:'in_flight',createdAt:now()};
  persist();
  try {
    api.trace(ctx,'intake.receive');
    const [translate,data]=source(headers['content-type'],raw);
    api.trace(ctx,'intake.translate');
    const enrichId=randomUUID(),start=Date.now();
    const {order,warnings}=await translate(data,{pricingBaseUrl:env.PRICING_URL,apiKey:env.PRICING_API_KEY,
      headers:{'X-Correlation-Id':ctx.cid,'X-Causation-Id':enrichId}});
    api.trace(ctx,'intake.enrich',warnings.length?'failed':'success',start,enrichId);
    if(warnings.some(w=>w.code==='PRICING_API_ERROR'))throw invalid(503,'pricing_unavailable');
    let status=202,body={correlationId:ctx.cid,status:'accepted'};
    if(warnings.length){status=422;body={code:'unknown_product',productIds:[...new Set(warnings.map(w=>w.productId))]};}
    else {
      if(!validOrder(order)||order.items.length>Number(env.ORDER_ITEMS_MAX))throw validation('Canonical order failed validation');
      const {orderId,source,orderType}=order,businessKey=source+':'+orderId;
      orders[ctx.cid]={correlationId:ctx.cid,businessKey,orderId,source,orderType,state:'accepted',updatedAt:now()};
      save('orders.json',orders);api.trace(ctx,'intake.publish');
      try {await api.publish('orders.exchange','order.accepted',order,{correlationId:ctx.cid,causationId:ctx.parent,businessKey});}
      catch{delete orders[ctx.cid];save('orders.json',orders);throw invalid(503,'broker_unavailable');}
    }
    Object.assign(entry,{state:'done',response:{status,body}});persist();
    return [status,body];
  }catch(e){delete keys[key];persist();throw e.status?e:validation(e.message);}
}
let dlqWork=Promise.resolve();
async function dlq(api,replay,filter) {
  const ch=await api.connection.createChannel();
  const entries=[];let replayed=0;
  try {
    const {messageCount}=await ch.checkQueue('orders.dlq');
    for(let i=0;i<messageCount;i++) {
      const m=await ch.get('orders.dlq',{noAck:false});if(!m)break;
      const h={...m.properties.headers};
      entries.push({messageId:m.properties.messageId,correlationId:h.correlationId,originQueue:h.originQueue,
        attempts:h.attempts,lastError:h.lastError,deadLetteredAt:h.deadLetteredAt});
      if(!replay||(filter && filter!==h.correlationId))continue;
      const ctx={cid:h.correlationId,parent:h.causationId};
      const origin=h.originQueue;
      for(const k of Object.keys(h))if(k.startsWith('x-')||['attempts','originQueue','lastError','deadLetteredAt'].includes(k))delete h[k];
      api.trace(ctx,'dlq.replay');h.causationId=ctx.parent;
      await api.publish('orders.return.exchange',origin,m.content,h);ch.ack(m);replayed++;
    }
  }finally{await ch.close();}
  return [200,replay?{replayed,remaining:entries.length-replayed}:{count:entries.length,entries}];
}
serve('intake',setup,async(api,method,path,headers,raw)=>{
  if(method==='POST'&&path==='/orders')return accept(api,headers,raw);
  if(method==='GET'&&path.startsWith('/orders/')){const view=orders[path.slice(8)];return view?[200,view]:[404,{}];}
  if((method==='GET'&&path==='/dlq')||(method==='POST'&&path==='/dlq/replay')){
    const filter=raw.length?JSON.parse(raw).correlationId:undefined;
    const run=dlqWork.then(()=>dlq(api,method==='POST',filter));dlqWork=run.catch(()=>{});return run;
  }
  return [404,{}];
});
