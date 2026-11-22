import amqp from 'amqplib';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const env = process.env;
export const now = () => new Date().toISOString();
const filename = name => path.join(env.DATA_DIR, name);
fs.mkdirSync(env.DATA_DIR, {recursive:true});
export function save(name, value) {
  fs.writeFileSync(filename(name + '.tmp'), JSON.stringify(value));
  fs.renameSync(filename(name + '.tmp'), filename(name));
}
export function store(name, initial) {
  if (!fs.existsSync(filename(name))) save(name, initial);
  return JSON.parse(fs.readFileSync(filename(name), 'utf8'));
}
export function append(name, row) { fs.appendFileSync(filename(name), JSON.stringify(row) + '\n'); }
export function rows(name) {
  if (!fs.existsSync(filename(name))) return [];
  return fs.readFileSync(filename(name),'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export const invalid = (status,code,extra={}) => Object.assign(new Error(code),{status,code,extra});
export const attempt = (msg, queue) => 1 + Number(msg.properties.headers?.['x-death']?.find(d=>d.queue===queue && d.reason==='rejected')?.count ?? 0);

export async function serve(role, setup, handler) {
  let channel, connectionModel;
  let consumers = [];
  function publish(exchange, key, body, headers = {}) {
    if (!channel) return Promise.reject(invalid(503,'broker_unavailable'));
    return new Promise((resolve,reject) => channel.publish(exchange,key,Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),
      {headers,messageId:randomUUID(),persistent:true,contentType:'application/json'},err=>err?reject(err):resolve()));
  }
  function trace(ctx, operation, status='success', start=Date.now(), id=randomUUID()) {
    const finish=Date.now();
    const hop={hopId:id,correlationId:ctx.cid,causationId:ctx.parent,service:role,operation,status,attempt:ctx.attempt??1,
      startedAt:new Date(start).toISOString(),finishedAt:new Date(finish).toISOString(),durationMs:finish-start};
    publish('trace.events','',hop).catch(e=>console.error('trace',e.message));
    ctx.parent=id;
    return id;
  }
  async function request(ctx,operation,url,body,key) {
    const id=randomUUID(), start=Date.now();
    const headers={'content-type':'application/json','X-Correlation-Id':ctx.cid,'X-Causation-Id':id};
    if(key) headers['Idempotency-Key']=key;
    try {
      const r=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(Number(env.REQUEST_TIMEOUT_MS))});
      if(!r.ok) throw invalid(r.status,(await r.json().catch(()=>({}))).code || 'http_'+r.status);
      trace(ctx,operation,'success',start,id);
    } catch(e) {
      const code=e.code && e.status ? e.code : e.name==='TimeoutError'?'timeout':'unreachable';
      trace(ctx,operation,code==='timeout'?'timeout':'failed',start,id);
      throw invalid(e.status||503,code);
    }
  }
  async function quarantine(ch,msg) {
    const h=msg.properties.headers||{};
    if(h.correlationId) trace({cid:h.correlationId,parent:h.causationId},'invalid.quarantine','quarantined');
    await publish('orders.invalid.exchange','',msg.content,h);
    ch.ack(msg);
  }
  async function retry(ch,msg,ctx,queue,reason,consumeId) {
    const prefix=role==='notifier'?'notify':'saga';
    if(ctx.attempt<Number(env.MAX_RETRIES)) {
      ctx.parent=consumeId;
      trace(ctx,prefix+'.retry','retried');
      ch.nack(msg,false,false);
      return false;
    }
    trace(ctx,prefix+'.dead_letter','dead_lettered');
    await publish('orders.dlq.exchange','',msg.content,{...msg.properties.headers,causationId:ctx.parent,
      originQueue:queue,attempts:ctx.attempt,lastError:reason,deadLetteredAt:now()});
    return true;
  }
  const api={publish,trace,request,quarantine,retry,get ch(){return channel;},get connection(){return connectionModel;}};
  async function connect() {
    for (;;) {
      let conn;
      try {
        conn=await amqp.connect(env.RABBITMQ_URL);
        conn.on('error',console.error);
        const closed=new Promise(resolve=>conn.once('close',resolve));
        const ch=await conn.createConfirmChannel();
        ch.on('error',console.error);
        ch.on('close',()=>conn.close().catch(()=>{}));
        channel=ch;connectionModel=conn;
        consumers=[];
        await setup(api,async(queue,fn)=>{
          await ch.consume(queue,msg=>{
            if(msg) Promise.resolve(fn(ch,msg)).catch(e=>{console.error(role,e.message); try{ch.nack(msg,false,true);}catch{}});
          });
          consumers.push(queue);
        });
        await closed;
      } catch(e) {console.error(role,e.message);}
      channel=undefined;
      if(conn) await conn.close().catch(()=>{});
      await new Promise(r=>setTimeout(r,500));
    }
  }
  void connect();
  http.createServer(async(req,res)=>{
    let status,body;
    try {
      const url=new URL(req.url,'http://local');
      if(url.pathname==='/health') {
        const checks={broker:channel?'up':'down',consumers:{}};
        for(const q of consumers) checks.consumers[q]=(await channel.checkQueue(q)).consumerCount;
        status=channel && consumers.length && Object.values(checks.consumers).every(Boolean)?200:503;
        body={status:status===200?'ok':'degraded',checks};
      } else {
        const chunks=[];for await(const part of req)chunks.push(part);
        [status,body]=await handler(api,req.method,url.pathname,req.headers,Buffer.concat(chunks));
      }
    } catch(e) {status=e.status||503;body={code:e.code||'service_unavailable',...e.extra}; console.error(role,e.message);}
    if(status===503)res.setHeader('Retry-After','1');
    res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));
  }).listen(Number(env.PORT));
}
