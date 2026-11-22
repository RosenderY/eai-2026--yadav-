import {serve,append,rows,env,now} from '../shared/runtime.js';
async function metrics(api){
  const queues={},broker=new URL(env.RABBITMQ_URL);
  const auth=Buffer.from(decodeURIComponent(broker.username)+':'+decodeURIComponent(broker.password)).toString('base64');
  const res=await fetch(env.MANAGEMENT_URL+'/api/queues/%2F',{headers:{Authorization:'Basic '+auth}});
  if(!res.ok)throw Error('RabbitMQ management unavailable');
  const samples=await res.json();
  for(const name of ['saga.queue','notifications.queue','orders.dlq','orders.invalid','trace.store']){
    const live=await api.ch.checkQueue(name);
    queues[name]={ready:live.messageCount,unacked:samples.find(q=>q.name===name)?.messages_unacknowledged||0,consumers:live.consumerCount};
  }
  const stuckSagas=(await (await fetch(env.ORCHESTRATOR_URL+'/sagas/stuck')).json()).sagas.length;
  const depth=name=>queues[name].ready+queues[name].unacked;
  const dlqDepth=depth('orders.dlq'),invalidDepth=depth('orders.invalid');
  const alerts=[];
  function add(key,value,firing,threshold=null){alerts.push({key,value,firing,threshold});}
  add('dlq_not_empty',dlqDepth,dlqDepth>0);add('invalid_not_empty',invalidDepth,invalidDepth>0);
  add('stuck_sagas',stuckSagas,stuckSagas>0);
  for(const [role,name,threshold] of [['saga','saga.queue',5],['notifier','notifications.queue',3]]){
    const q=queues[name];add(role+'_consumer_missing',q.consumers,q.consumers===0);
    add(role+'_consumer_lag',q.ready,q.ready>threshold,threshold);
  }
  return {generatedAt:now(),queues,dlqDepth,invalidDepth,stuckSagas,alerts};
}
serve('observer',async(_api,consume)=>{
  await consume('trace.store',async(ch,msg)=>{
    try{const hop=JSON.parse(msg.content);if(hop.hopId)append('trace-store.jsonl',hop);}catch(e){console.error(e.message);}
    ch.ack(msg);
  });
},async(api,method,path)=>{
  if(method!=='GET')return [404,{}];
  if(path==='/ops/metrics')return [200,await metrics(api)];
  if(path.startsWith('/trace/')){
    const cid=path.slice(7),hops=rows('trace-store.jsonl').filter(h=>h.correlationId===cid).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
    return hops.length?[200,{correlationId:cid,hops}]:[404,{}];
  }
  return [404,{}];
});
