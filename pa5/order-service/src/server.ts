import express from "express";
import {randomUUID} from "node:crypto";
import {connectWithRetry,withoutRetryHistory} from "../../shared/rabbit";
import type {CanonicalOrder} from "../../shared/canonical-order";
async function main():Promise<void>{
 const {channel}=await connectWithRetry(process.env.RABBITMQ_URL!);
 await channel.assertExchange("orders.dlq.exchange","fanout",{durable:true});
 await channel.assertQueue("orders.dlq",{durable:true});
 await channel.bindQueue("orders.dlq","orders.dlq.exchange","");
 const orders=new Map<string,CanonicalOrder>();
 const app=express();app.use(express.json());
 app.get("/health",(_req,res)=>{res.status(200).json({status:"ok"});});
 app.post("/orders",(req,res)=>{
  const item=req.body as CanonicalOrder;
  if(!item||typeof item.orderId!=="string"||!item.customer||!Array.isArray(item.items)){res.status(400).json({error:"Invalid canonical order"});return;}
  const correlationId=randomUUID();
  channel.publish("orders.exchange","",Buffer.from(JSON.stringify(item)),{headers:{correlationId},contentType:"application/json",persistent:true});
  orders.set(correlationId,item);
  res.status(201).json({correlationId,status:"accepted"});
 });
 app.get("/orders/:correlationId",(req,res)=>{
  const order=orders.get(req.params.correlationId);
  if(!order){res.status(404).json({error:"Not found"});return;}
  res.status(200).json({correlationId:req.params.correlationId,order});
 });
 app.post("/dlq/replay",async(_req,res)=>{
  let replayed=0;
  try{
   for(;;){
    const msg=await channel.get("orders.dlq",{noAck:false});
    if(!msg)break;
    const origin=msg.properties.headers?.["originQueue"];
    if(typeof origin!=="string"||!["payments.queue","inventory.queue","notifications.queue"].includes(origin)){channel.nack(msg,false,true);throw new Error("Unknown originQueue");}
    const headers=withoutRetryHistory(msg.properties.headers);
    delete headers.originQueue;
    channel.publish("orders.return.exchange",origin,msg.content,{headers,persistent:true,contentType:msg.properties.contentType||"application/json"});
    channel.ack(msg);replayed++;
   }
   res.status(200).json({replayed});
  }catch(err){res.status(500).json({error:String(err),replayed});}
 });
 app.listen(Number(process.env.PORT??"3000"),"0.0.0.0");
}
main().catch(console.error);
