import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";

export interface Address { street: string; city: string; postalCode: string; country: string; }
export interface CanonicalCustomer { name: string; email: string; address: Address; }
export interface CanonicalItem {
  productId: string; productName: string; quantity: number;
  unitPrice: string; currency: string; taxRate: number;
}
export type OrderStatus = "new" | "processing" | "shipped" | "delivered";
export interface CanonicalOrder {
  orderId: string;
  orderType: "standard" | "express" | "b2b";
  source: "web" | "mobile" | "b2b";
  receivedAt: string;
  orderDate: string;
  customer: CanonicalCustomer;
  items: CanonicalItem[];
  currency: string;
  status: OrderStatus;
}
export type TransformWarningCode = "UNKNOWN_PRODUCT" | "PRICING_API_ERROR";
export interface TransformWarning { code: TransformWarningCode; productId: string; message: string; }
export interface TransformResult { order: CanonicalOrder | null; warnings: TransformWarning[]; }
export interface TranslateOptions { pricingBaseUrl: string; apiKey?: string; now?: () => Date; }
export type EnrichResult =
  | { status: "ok"; unitPrice: string; currency: string; taxRate: number; productName: string }
  | { status: "unknown_product" }
  | { status: "error"; httpStatus: number };

export const DEFAULT_PRICING_API_KEY = "pa4-pricing-key-2026";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_WEB_ORDER_PATH = path.join(ROOT, "data", "web-order.json");
export const DEFAULT_MOBILE_ORDER_PATH = path.join(ROOT, "data", "mobile-order.json");
export const DEFAULT_B2B_ORDER_PATH = path.join(ROOT, "data", "b2b-order.xml");
export const DEFAULT_PRICING_BASE_URL = "http://localhost:4100";
const OUT = path.join(ROOT, "out");
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const mobileCurrency: Record<number, string> = { 978: "EUR", 840: "USD", 826: "GBP" };
const mobileStatus: Record<number, OrderStatus> = {
  1: "new", 2: "processing", 3: "shipped", 4: "delivered",
};

export function normalizeProductId(source: "web" | "mobile" | "b2b", rawId: string): string {
  if (source === "mobile") return "PROD-" + rawId;
  if (source === "b2b") return rawId.replace(/^SKU-/, "");
  return rawId;
}

export function toDecimalAmount(price: number): string {
  return price.toFixed(2);
}

export async function enrichFromPricing(
  productId: string,
  options: TranslateOptions,
): Promise<EnrichResult> {
  const base = options.pricingBaseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(base + "/pricing/" + encodeURIComponent(productId), {
      headers: { "X-API-Key": options.apiKey ?? DEFAULT_PRICING_API_KEY },
    });
    if (response.status === 404) return { status: "unknown_product" };
    if (!response.ok) return { status: "error", httpStatus: response.status };

    const p = await response.json() as {
      unitPrice: number; currency: string; taxRate: number; productName: string;
    };
    return {
      status: "ok",
      unitPrice: toDecimalAmount(p.unitPrice),
      currency: p.currency,
      taxRate: p.taxRate,
      productName: p.productName,
    };
  } catch {
    return { status: "error", httpStatus: 0 };
  }
}

type Line = { productId: string; productName: string; quantity: number };

export async function enrichItems(
  lines: Line[],
  options: TranslateOptions,
): Promise<{ items: CanonicalItem[]; warnings: TransformWarning[] }> {
  const items: CanonicalItem[] = [];
  const warnings: TransformWarning[] = [];

  for (const line of lines) {
    const price = await enrichFromPricing(line.productId, options);
    if (price.status === "ok") {
      items.push({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: price.unitPrice,
        currency: price.currency,
        taxRate: price.taxRate,
      });
    } else if (price.status === "unknown_product") {
      warnings.push({
        code: "UNKNOWN_PRODUCT",
        productId: line.productId,
        message: `Unknown product ${line.productId}; item omitted from canonical order.`,
      });
    } else {
      warnings.push({
        code: "PRICING_API_ERROR",
        productId: line.productId,
        message: `Pricing lookup failed for ${line.productId} (HTTP ${price.httpStatus}); item omitted.`,
      });
    }
  }

  return { items, warnings };
}

export function epochSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function mapCurrencyCode(code: number): string {
  const mapped = mobileCurrency[code];
  if (!mapped) throw new Error("Unsupported currency code: " + code);
  return mapped;
}

export function mapMobileStatus(code: number): OrderStatus {
  const mapped = mobileStatus[code];
  if (!mapped) throw new Error("Unsupported mobile status: " + code);
  return mapped;
}

export function mapB2BStatus(raw: string): OrderStatus {
  const status = raw.toLowerCase() as OrderStatus;
  if (!["new", "processing", "shipped", "delivered"].includes(status)) {
    throw new Error("Unsupported B2B status: " + raw);
  }
  return status;
}

export function parseMobileAddress(value: string): Address {
  const p = value.split(",").map((x) => x.trim());
  if (p.length !== 4) throw new Error("Expected four address parts");
  return { street: p[0]!, city: p[1]!, postalCode: p[2]!, country: p[3]! };
}

export function decodeB2BXmlBytes(bytes: Buffer): string {
  return new TextDecoder("windows-1257").decode(bytes);
}

function decodeNumericEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function nowIso(options: TranslateOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function asOrderType(v: string): CanonicalOrder["orderType"] {
  if (v === "standard" || v === "express" || v === "b2b") return v;
  throw new Error("Unsupported order type: " + v);
}

function asStatus(v: string): OrderStatus {
  const s = v.toLowerCase() as OrderStatus;
  if (!["new", "processing", "shipped", "delivered"].includes(s)) {
    throw new Error("Unsupported status: " + v);
  }
  return s;
}

async function assemble(
  base: Omit<CanonicalOrder, "items" | "receivedAt">,
  lines: Line[],
  options: TranslateOptions,
): Promise<TransformResult> {
  const enriched = await enrichItems(lines, options);
  if (enriched.items.length === 0) return { order: null, warnings: enriched.warnings };
  return {
    order: { ...base, receivedAt: nowIso(options), items: enriched.items },
    warnings: enriched.warnings,
  };
}

export async function translateWeb(file: string, options: TranslateOptions): Promise<TransformResult> {
  const x = JSON.parse(readFileSync(file, "utf8"));
  const lines: Line[] = x.items.map((i: any) => ({
    productId: normalizeProductId("web", i.productId),
    productName: i.productName,
    quantity: i.quantity,
  }));

  return assemble({
    orderId: x.orderId,
    orderType: asOrderType(x.orderType),
    source: "web",
    orderDate: new Date(x.orderDate).toISOString(),
    customer: {
      name: x.customer.name,
      email: x.customer.email,
      address: {
        street: x.customer.address.street,
        city: x.customer.address.city,
        postalCode: x.customer.address.postalCode,
        country: x.customer.address.country,
      },
    },
    currency: x.currency,
    status: asStatus(x.status),
  }, lines, options);
}

export async function translateMobile(file: string, options: TranslateOptions): Promise<TransformResult> {
  const x = JSON.parse(readFileSync(file, "utf8"));
  const lines: Line[] = x.items.map((i: any) => ({
    productId: normalizeProductId("mobile", i.pid),
    productName: i.pname,
    quantity: i.qty,
  }));

  return assemble({
    orderId: x.oid,
    orderType: asOrderType(x.ot),
    source: "mobile",
    orderDate: epochSecondsToIso(x.ts),
    customer: {
      name: x.cust_name,
      email: x.cust_email,
      address: parseMobileAddress(x.addr),
    },
    currency: mapCurrencyCode(x.cur),
    status: mapMobileStatus(x.st),
  }, lines, options);
}

export async function translateB2B(file: string, options: TranslateOptions): Promise<TransformResult> {
  const parsed = xmlParser.parse(decodeB2BXmlBytes(readFileSync(file))) as any;
  const x = parsed.PurchaseOrder;
  const buyer = x.BuyerParty;
  const ship = buyer.ShipToAddress;
  const rawLines = Array.isArray(x.LineItems.LineItem)
    ? x.LineItems.LineItem
    : [x.LineItems.LineItem];

  const lines: Line[] = rawLines.map((i: any) => ({
    productId: normalizeProductId("b2b", String(i["@_sku"])),
    productName: String(i.Description),
    quantity: Number(i["@_quantity"]),
  }));

  return assemble({
    orderId: x["@_orderId"],
    orderType: asOrderType(x["@_orderType"]),
    source: "b2b",
    orderDate: new Date(x["@_orderDate"]).toISOString(),
    customer: {
      name: decodeNumericEntities(String(buyer.Name)),
      email: String(buyer.ContactEmail),
      address: {
        street: decodeNumericEntities(String(ship.Street)),
        city: decodeNumericEntities(String(ship.City)),
        postalCode: String(ship.PostalCode),
        country: ship["@_country"],
      },
    },
    currency: x.LineItems["@_currency"],
    status: mapB2BStatus(x.Status),
  }, lines, options);
}

export async function main(): Promise<void> {
  const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };
  const results = {
    web: await translateWeb(DEFAULT_WEB_ORDER_PATH, options),
    mobile: await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options),
    b2b: await translateB2B(DEFAULT_B2B_ORDER_PATH, options),
  };
  mkdirSync(OUT, { recursive: true });
  for (const [name, result] of Object.entries(results)) {
    writeFileSync(path.join(OUT, name + ".json"), JSON.stringify(result, null, 2) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
