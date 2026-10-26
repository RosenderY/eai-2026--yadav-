import type { ConsumeMessage } from "amqplib";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";
const QUEUE="inventory.queue";
const MAX_RETRIES=Number(process.env.MAX_RETRIES ?? "3");
const DLQ_EXCHANGE=process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const FAIL_RATE=Number(process.env.INVENTORY_FAIL_RATE ?? "10");
async function declareChannels(channel: import("amqplib").Channel) {
  await channel.assertExchange("orders.dlq.exchange","fanout",{durable:true});
  await channel.assertQueue("orders.dlq",{durable:true});
  await channel.bindQueue("orders.dlq","orders.dlq.exchange","");
  await channel.assertExchange("orders.invalid.exchange","fanout",{durable:true});
  await channel.assertQueue("orders.invalid",{durable:true});
  await channel.bindQueue("orders.invalid","orders.invalid.exchange","");
}
async function main():Promise<void> {
 const {channel}=await connectWithRetry(process.env.RABBITMQ_URL!);
 await channel.prefetch(1);
 await declareChannels(channel);
 await channel.consume(QUEUE,async(msg:ConsumeMessage|null)=>{
  if(!msg)return;
  const correlationId=msg.properties.headers?.["correlationId"] as string|undefined;
  const retryCount=getRetryCount(msg);
  try{
   const order=JSON.parse(msg.content.toString()) as CanonicalOrder;
   if(!correlationId || !order || typeof order.orderId!=="string")throw new SyntaxError("Invalid order or correlationId");
   if(Math.random()*100<FAIL_RATE)throw new Error("Simulated inventory outage");
   channel.publish("results.inventory","",Buffer.from(JSON.stringify({correlationId,source:"inventory",status:"success",timestamp:new Date().toISOString(),details:{message:"inventory processed"}})),{headers:{correlationId},contentType:"application/json",persistent:true});
   channel.ack(msg);
  }catch(err){
   if(err instanceof SyntaxError){
    channel.publish("orders.invalid.exchange","",msg.content,{headers:msg.properties.headers,persistent:true});
    channel.ack(msg);
    return;
   }
   if(retryCount>=MAX_RETRIES-1){
    channel.publish(DLQ_EXCHANGE,"",msg.content,{headers:{...msg.properties.headers,originQueue:QUEUE},persistent:true});
    channel.ack(msg);
   }else{channel.nack(msg,false,false);}
  }
 });
 console.log("inventory consumer ready");
}
main().catch(console.error);
