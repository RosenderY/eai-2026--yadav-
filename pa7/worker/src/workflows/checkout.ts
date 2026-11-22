import { ApplicationFailure, TimeoutFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { CanonicalOrder, CheckoutResult, TraceItem } from "../types";

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2500 ms",
  retry: { maximumAttempts: 3, initialInterval: "200 ms", backoffCoefficient: 2 },
});

export async function checkout(order: CanonicalOrder): Promise<CheckoutResult> {
  const { orderId } = order;
  const trace: TraceItem[] = [];
  const undo: Array<[string, () => Promise<void>]> = [];
  async function step(name: string, call: () => Promise<void>) {
    const start = Date.now();
    let status = "success";
    try { await call(); }
    catch (err) {
      const cause = (err as Error).cause;
      const code = cause instanceof TimeoutFailure ? "timeout" :
        cause instanceof ApplicationFailure ? cause.type ?? "unreachable" : "unreachable";
      status = code === "timeout" ? "timeout" : "failed";
      throw new Error(code);
    } finally {
      const end = Date.now();
      trace.push({step: name, status, startedAt: new Date(start).toISOString(),
        finishedAt: new Date(end).toISOString(), durationMs: end - start});
    }
  }
  try {
    const cents = order.items.reduce((sum, item) =>
      sum + BigInt(item.unitPrice.replace(".", "")) * BigInt(item.quantity), 0n);
    const amount = (cents / 100n) + "." + String(cents % 100n).padStart(2, "0");
    await step("payment", () => act.authorizePayment(orderId, amount));
    undo.push(["payment_refund", () => act.refundPayment(orderId)]);
    await step("inventory", () => act.reserveInventory(orderId, order.items));
    undo.push(["inventory_release", () => act.releaseInventory(orderId)]);
    await step("shipping", () => act.createShipment(orderId));
    await step("notification", () => act.sendNotification(orderId, order.customer.email));
    return { orderId, status: "completed", trace };
  } catch (error) {
    try { for (const [name, call] of undo.reverse()) await step(name, call); }
    catch { return { orderId, status: "failed", code: "compensation_failed", trace }; }
    return { orderId, status: undo.length ? "compensated" : "failed", code: (error as Error).message, trace };
  }
}
