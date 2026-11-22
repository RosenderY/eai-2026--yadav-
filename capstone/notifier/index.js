import {serve,store,save,append,env,attempt,now} from '../shared/runtime.js';
const seen=new Set(store('processed-ids.json',[])),queue='notifications.queue';
serve('notifier',async(api,consume)=>{
  await api.ch.prefetch(1);
  await consume(queue,async(ch,msg)=>{
    let event;const h=msg.properties.headers||{};
    try {event=JSON.parse(msg.content);if(!event.orderId||!event.recipient||!h.correlationId||event.correlationId!==h.correlationId)throw Error();}
    catch{return api.quarantine(ch,msg);}
    const ctx={cid:h.correlationId,parent:h.causationId,attempt:attempt(msg,queue)};
    const root=api.trace(ctx,'notify.consume');
    if(seen.has(ctx.cid)){api.trace(ctx,'notify.duplicate','duplicate');ch.ack(msg);return;}
    const body={orderId:event.orderId,recipient:event.recipient,kind:'order_not_completed',reason:event.code};
    try {await api.request(ctx,'notify.send',env.NOTIFICATION_URL+'/notification/send',body);}
    catch(e){if(await api.retry(ch,msg,ctx,queue,e.code,root))ch.ack(msg);return;}
    append('notification.log',{...body,correlationId:ctx.cid,at:now()});seen.add(ctx.cid);
    save('processed-ids.json',[...seen]);ch.ack(msg);
  });
},async()=>[404,{}]);
