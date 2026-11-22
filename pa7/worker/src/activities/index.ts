import { ApplicationFailure, Context } from "@temporalio/activity";
import type { CanonicalItem } from "../types";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// docker-compose.yml sets these. Never hardcode a downstream URL.
const PAYMENT_URL = requiredEnv("PAYMENT_URL");
const INVENTORY_URL = requiredEnv("INVENTORY_URL");
const SHIPPING_URL = requiredEnv("SHIPPING_URL");
const NOTIFICATION_URL = requiredEnv("NOTIFICATION_URL");

async function post(url: string, body: object) {
  const res = await fetch(url, { method: "POST", signal: Context.current().cancellationSignal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return;
  const { code = "http_" + res.status } = (await res.json().catch(() => ({}))) as {code?: string};
  if (res.status >= 400 && res.status < 500) throw ApplicationFailure.nonRetryable(code, code);
  throw ApplicationFailure.retryable(code, code);
}

/** POST {PAYMENT_URL}/payment/authorize with { orderId, amount }. */
export async function authorizePayment(orderId: string, amount: string): Promise<void> {
  return post(PAYMENT_URL + "/payment/authorize", { orderId, amount });
}

/** POST {INVENTORY_URL}/inventory/reserve with { orderId, items }. */
export async function reserveInventory(orderId: string, items: CanonicalItem[]): Promise<void> {
  return post(INVENTORY_URL + "/inventory/reserve", { orderId, items });
}

/** POST {SHIPPING_URL}/shipping/create with { orderId }. */
export async function createShipment(orderId: string): Promise<void> {
  return post(SHIPPING_URL + "/shipping/create", { orderId });
}

/** POST {NOTIFICATION_URL}/notification/send with { orderId, recipient }. */
export async function sendNotification(orderId: string, recipient: string): Promise<void> {
  return post(NOTIFICATION_URL + "/notification/send", { orderId, recipient });
}

/** Compensates authorizePayment: POST {PAYMENT_URL}/payment/refund with { orderId }. */
export async function refundPayment(orderId: string): Promise<void> {
  return post(PAYMENT_URL + "/payment/refund", { orderId });
}

/** Compensates reserveInventory: POST {INVENTORY_URL}/inventory/release with { orderId }. */
export async function releaseInventory(orderId: string): Promise<void> {
  return post(INVENTORY_URL + "/inventory/release", { orderId });
}
