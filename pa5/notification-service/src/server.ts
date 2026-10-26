import type { ConsumeMessage } from "amqplib";
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from "node:fs";
import {connectWithRetry,getRetryCount} from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";
const QUEUE="notifications.queue";
const MAX_RETRIES=Number(process.env.MAX_RETRIES ?? "3");
const DLQ_EXCHANGE=process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const STORE="/data/processed-ids.json";
const LOG="/data/notification.log";
async function declareChannels(channel: import("amqplib").Channel) {
  await channel.assertExchange("orders.dlq.exchange","fanout",{durable:true});
  await channel.assertQueue("orders.dlq",{durable:true});
  await channel.bindQueue("orders.dlq","orders.dlq.exchange","");
  await channel.assertExchange("orders.invalid.exchange","fanout",{durable:true});
  await channel.assertQueue("orders.invalid",{durable:true});
  await channel.bindQueue("orders.invalid","orders.invalid.exchange","");
}
async function main():Promise<void>{
 mkdirSync("/data",{recursive:true});
 if(!existsSync(STORE))writeFileSync(STORE,"[]");
 const {channel}=await connectWithRetry(process.env.RABBITMQ_URL!);
 await channel.prefetch(1);
 await declareChannels(channel);
 await channel.consume(QUEUE,async(msg:ConsumeMessage|null)=>{
  if(!msg)return;
  const correlationId=msg.properties.headers?.["correlationId"] as string|undefined;
  const retryCount=getRetryCount(msg);
  try{
   const order=JSON.parse(msg.content.toString()) as CanonicalOrder;
   if(!correlationId||!order||typeof order.orderId!=="string"||typeof order.customer?.email!=="string")throw new SyntaxError("Invalid order or correlationId");
   const processed=new Set<string>(JSON.parse(readFileSync(STORE,"utf8")) as string[]);
   if(processed.has(correlationId)){channel.ack(msg);console.log("duplicate skipped");return;}
   appendFileSync(LOG,JSON.stringify({correlationId,orderId:order.orderId,customerEmail:order.customer.email,timestamp:new Date().toISOString(),message:"Order received"})+"\n");
   processed.add(correlationId);
   writeFileSync(STORE,JSON.stringify([...processed]));
   channel.publish("results.notification","",Buffer.from(JSON.stringify({correlationId,source:"notification",status:"success",timestamp:new Date().toISOString(),details:{message:"Order received"}})),{headers:{correlationId},contentType:"application/json",persistent:true});
   channel.ack(msg);
  }catch(err){
   if(err instanceof SyntaxError){
    channel.publish("orders.invalid.exchange","",msg.content,{headers:msg.properties.headers,persistent:true});
    channel.ack(msg);return;
   }
   if(retryCount>=MAX_RETRIES-1){
    channel.publish(DLQ_EXCHANGE,"",msg.content,{headers:{...msg.properties.headers,originQueue:QUEUE},persistent:true});
    channel.ack(msg);
   }else{channel.nack(msg,false,false);}
   console.error(err);
  }
 });
 console.log("notification consumer ready");
}
main().catch(console.error);
