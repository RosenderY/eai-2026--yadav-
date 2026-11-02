import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import axios from "axios";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { CanonicalOrder } from "./canonical-order.js";

type StepName = "payment" | "inventory" | "shipping" | "notification" | "inventory_release" | "payment_refund";
type Outcome = "success" | "failed" | "timeout";
type FinalState = "completed" | "failed" | "compensated";
type TraceEntry = { step: StepName; status: Outcome; startedAt: string; finishedAt: string; durationMs: number };
type IdempotencyRecord = { requestHash: string; state: "in_progress" | FinalState; httpStatus: number; response: any; updatedAt: string };
type IdempotencyStore = { records: Record<string, IdempotencyRecord> };
type SagaStore = { sagas: Record<string, { idempotencyKey: string; state: FinalState; steps: TraceEntry[]; updatedAt: string }> };
type ForwardStep = { step: "payment" | "inventory" | "shipping" | "notification"; url: string; body: unknown };

const app = express();
app.use(express.json({ limit: "1mb" }));

const env = {
  port: Number(process.env.ORCHESTRATOR_PORT || 3000),
  payment: process.env.PAYMENT_URL || "http://payment:4001",
  inventory: process.env.INVENTORY_URL || "http://inventory:4002",
  shipping: process.env.SHIPPING_URL || "http://shipping:4003",
  notification: process.env.NOTIFICATION_URL || "http://notification:4004",
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500)
};
const DATA_DIR = "/data";
const IDEMPOTENCY_FILE = path.join(DATA_DIR, "idempotency-store.json");
const SAGA_FILE = path.join(DATA_DIR, "saga-store.json");
const EMPTY_IDEMPOTENCY: IdempotencyStore = { records: {} };
const EMPTY_SAGA: SagaStore = { sagas: {} };

function initialise(file: string, initial: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
}
function load<T>(file: string, fallback: T): T {
  initialise(file, fallback);
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { return fallback; }
}
function save(file: string, value: unknown): void {
  const temporary = file + ".next";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
function timestamp(): string { return new Date().toISOString(); }
function digest(order: CanonicalOrder): string {
  return crypto.createHash("sha256").update(JSON.stringify(order)).digest("hex");
}
function saveIdempotency(key: string, record: IdempotencyRecord): void {
  const store = load(IDEMPOTENCY_FILE, EMPTY_IDEMPOTENCY);
  store.records[key] = record;
  save(IDEMPOTENCY_FILE, store);
}
function saveSaga(orderId: string, key: string, state: FinalState, trace: TraceEntry[]): void {
  const store = load(SAGA_FILE, EMPTY_SAGA);
  store.sagas[orderId] = { idempotencyKey: key, state, steps: trace, updatedAt: timestamp() };
  save(SAGA_FILE, store);
}
function isTimeout(error: unknown): boolean {
  return axios.isAxiosError(error) && ["ECONNABORTED", "ETIMEDOUT"].includes(error.code || "");
}
function errorCode(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { code?: string } | undefined;
    return body?.code || "downstream_failure";
  }
  return "downstream_failure";
}
function calculateAmount(order: CanonicalOrder): string {
  const cents = order.items.reduce((total, item) => {
    const parts = /^(-?)(\d+)\.(\d{2})$/.exec(item.unitPrice);
    if (!parts) throw new Error("Invalid unitPrice in canonical order");
    const line = (Number(parts[2]) * 100 + Number(parts[3])) * item.quantity;
    return total + (parts[1] ? -line : line);
  }, 0);
  return (cents / 100).toFixed(2);
}

async function invoke(trace: TraceEntry[], step: StepName, url: string, body: unknown, orderId: string): Promise<void> {
  const started = Date.now();
  const startedAt = timestamp();
  try {
    await axios.post(url, body, {
      timeout: env.timeoutMs,
      headers: { "x-order-id": orderId, "x-correlation-id": crypto.randomUUID() }
    });
    trace.push({ step, status: "success", startedAt, finishedAt: timestamp(), durationMs: Date.now() - started });
  } catch (error) {
    trace.push({
      step,
      status: isTimeout(error) ? "timeout" : "failed",
      startedAt,
      finishedAt: timestamp(),
      durationMs: Date.now() - started
    });
    throw error;
  }
}

app.get("/health", (_req: Request, res: Response) => res.status(200).json({ status: "ok" }));

app.get("/debug/trace/:orderId", (req: Request, res: Response) => {
  const saga = load(SAGA_FILE, EMPTY_SAGA).sagas[req.params.orderId];
  if (!saga) return res.status(404).json({ code: "not_found", message: "No workflow exists for that orderId" });
  return res.status(200).json(saga);
});

const canonicalPath = "/canonical/order.schema.json";
if (!fs.existsSync(canonicalPath)) throw new Error("The course canonical schema is not mounted at /canonical/order.schema.json");
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateOrder = ajv.compile(JSON.parse(fs.readFileSync(canonicalPath, "utf8")));

app.post("/checkout", async (req: Request, res: Response) => {
  const key = req.header("Idempotency-Key");
  if (!key || key.length > 180) {
    return res.status(400).json({ code: "validation_error", message: "A valid Idempotency-Key header is required" });
  }
  if (!validateOrder(req.body)) {
    return res.status(400).json({ code: "validation_error", message: ajv.errorsText(validateOrder.errors) });
  }
  const order = req.body as CanonicalOrder;
  if (order.items.length > 50) {
    return res.status(400).json({ code: "validation_error", message: "Checkout accepts no more than 50 items" });
  }

  const requestHash = digest(order);
  const store = load(IDEMPOTENCY_FILE, EMPTY_IDEMPOTENCY);
  const previous = store.records[key];
  if (previous) {
    if (previous.requestHash !== requestHash) {
      return res.status(409).json({ code: "idempotency_payload_mismatch", message: "The key belongs to a different request body" });
    }
    if (previous.state === "in_progress") {
      return res.status(409).json({ code: "idempotency_conflict", message: "The original checkout is still running" });
    }
    return res.status(previous.httpStatus).json(previous.response);
  }

  saveIdempotency(key, {
    requestHash, state: "in_progress", httpStatus: 202,
    response: { orderId: order.orderId, status: "in_progress", trace: [] }, updatedAt: timestamp()
  });

  const forward: ForwardStep[] = [
    { step: "payment", url: env.payment + "/payment/authorize", body: { orderId: order.orderId, amount: calculateAmount(order) } },
    { step: "inventory", url: env.inventory + "/inventory/reserve", body: { orderId: order.orderId, items: order.items } },
    { step: "shipping", url: env.shipping + "/shipping/create", body: { orderId: order.orderId } },
    { step: "notification", url: env.notification + "/notification/send", body: { orderId: order.orderId, recipient: order.customer.email } }
  ];
  const trace: TraceEntry[] = [];
  const finished: ForwardStep[] = [];
  let finalState: FinalState = "completed";
  let httpStatus = 200;
  let code: string | undefined;

  try {
    for (const action of forward) {
      await invoke(trace, action.step, action.url, action.body, order.orderId);
      finished.push(action);
    }
  } catch (failure) {
    const timedOut = isTimeout(failure);
    code = timedOut ? "timeout" : errorCode(failure);
    httpStatus = timedOut ? 504 : 422;
    let compensationProblem = false;

    for (const action of [...finished].reverse()) {
      if (action.step === "inventory") {
        try {
          await invoke(trace, "inventory_release", env.inventory + "/inventory/release", { orderId: order.orderId }, order.orderId);
        } catch { compensationProblem = true; }
      }
      if (action.step === "payment") {
        try {
          await invoke(trace, "payment_refund", env.payment + "/payment/refund", { orderId: order.orderId }, order.orderId);
        } catch { compensationProblem = true; }
      }
    }
    finalState = compensationProblem ? "failed" : (finished.length ? "compensated" : "failed");
    if (compensationProblem) { code = "compensation_failed"; httpStatus = 422; }
  }

  const response: { orderId: string; status: FinalState; trace: TraceEntry[]; code?: string } = {
    orderId: order.orderId, status: finalState, trace
  };
  if (code) response.code = code;
  saveSaga(order.orderId, key, finalState, trace);
  saveIdempotency(key, { requestHash, state: finalState, httpStatus, response, updatedAt: timestamp() });
  return res.status(httpStatus).json(response);
});

initialise(IDEMPOTENCY_FILE, EMPTY_IDEMPOTENCY);
initialise(SAGA_FILE, EMPTY_SAGA);
app.listen(env.port, () => console.log("[fulfilment-coordinator] listening on " + env.port));
