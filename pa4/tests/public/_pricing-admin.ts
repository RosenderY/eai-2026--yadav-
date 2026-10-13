import {
  DEFAULT_PRICING_API_KEY,
  DEFAULT_PRICING_BASE_URL,
} from "../../starter/src/transform";

const BASE = process.env.PA4_PRICING_BASE_URL ?? DEFAULT_PRICING_BASE_URL;
const KEY = process.env.PA4_PRICING_API_KEY ?? DEFAULT_PRICING_API_KEY;

async function call(method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      "X-API-Key": KEY,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error("pricing admin request failed");
  return response.json();
}

export function overridePrice(productId: string, unitPrice: number): Promise<unknown> {
  return call("PUT", "/admin/pricing/" + productId, { unitPrice });
}

export function forceStatus(productId: string, httpStatus: number): Promise<unknown> {
  return call("PUT", "/admin/pricing/" + productId, { forceStatus: httpStatus });
}

export function resetPricingCatalog(): Promise<unknown> {
  return call("POST", "/admin/reset");
}
