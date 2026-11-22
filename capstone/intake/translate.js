import { XMLParser } from "fast-xml-parser";
const DEFAULT_PRICING_API_KEY = "pa4-pricing-key-2026";
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const mobileCurrency = { 978: "EUR", 840: "USD", 826: "GBP" };
const mobileStatus = {
  1: "new",
  2: "processing",
  3: "shipped",
  4: "delivered"
};
function normalizeProductId(source, rawId) {
  if (source === "mobile") return "PROD-" + rawId;
  if (source === "b2b") return rawId.replace(/^SKU-/, "");
  return rawId;
}
function toDecimalAmount(price) {
  return price.toFixed(2);
}
async function enrichFromPricing(productId, options) {
  const base = options.pricingBaseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(base + "/pricing/" + encodeURIComponent(productId), {
      headers: { "X-API-Key": options.apiKey, ...options.headers },
      signal: AbortSignal.timeout(Number(process.env.REQUEST_TIMEOUT_MS))
    });
    if (response.status === 404) return { status: "unknown_product" };
    if (!response.ok) return { status: "error", httpStatus: response.status };
    const p = await response.json();
    return {
      status: "ok",
      unitPrice: toDecimalAmount(p.unitPrice),
      currency: p.currency,
      taxRate: p.taxRate,
      productName: p.productName
    };
  } catch {
    return { status: "error", httpStatus: 0 };
  }
}
async function enrichItems(lines, options) {
  const items = [];
  const warnings = [];
  for (const line of lines) {
    const price = await enrichFromPricing(line.productId, options);
    if (price.status === "ok") {
      items.push({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: price.unitPrice,
        currency: price.currency,
        taxRate: price.taxRate
      });
    } else if (price.status === "unknown_product") {
      warnings.push({
        code: "UNKNOWN_PRODUCT",
        productId: line.productId,
        message: `Unknown product ${line.productId}; item omitted from canonical order.`
      });
    } else {
      warnings.push({
        code: "PRICING_API_ERROR",
        productId: line.productId,
        message: `Pricing lookup failed for ${line.productId} (HTTP ${price.httpStatus}); item omitted.`
      });
    }
  }
  return { items, warnings };
}
function epochSecondsToIso(seconds) {
  return new Date(seconds * 1e3).toISOString();
}
function mapCurrencyCode(code) {
  const mapped = mobileCurrency[code];
  if (!mapped) throw new Error("Unsupported currency code: " + code);
  return mapped;
}
function mapMobileStatus(code) {
  const mapped = mobileStatus[code];
  if (!mapped) throw new Error("Unsupported mobile status: " + code);
  return mapped;
}
function mapB2BStatus(raw) {
  const status = raw.toLowerCase();
  if (!["new", "processing", "shipped", "delivered"].includes(status)) {
    throw new Error("Unsupported B2B status: " + raw);
  }
  return status;
}
function parseMobileAddress(value) {
  const p = value.split(",").map((x) => x.trim());
  if (p.length !== 4) throw new Error("Expected four address parts");
  return { street: p[0], city: p[1], postalCode: p[2], country: p[3] };
}
function decodeB2BXmlBytes(bytes) {
  return new TextDecoder("windows-1257").decode(bytes);
}
function decodeNumericEntities(value) {
  return value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}
function nowIso(options) {
  return (options.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
}
function asOrderType(v) {
  if (v === "standard" || v === "express" || v === "b2b") return v;
  throw new Error("Unsupported order type: " + v);
}
function asStatus(v) {
  const s = v.toLowerCase();
  if (!["new", "processing", "shipped", "delivered"].includes(s)) {
    throw new Error("Unsupported status: " + v);
  }
  return s;
}
async function assemble(base, lines, options) {
  const enriched = await enrichItems(lines, options);
  if (enriched.items.length === 0) return { order: null, warnings: enriched.warnings };
  return {
    order: { ...base, receivedAt: nowIso(options), items: enriched.items },
    warnings: enriched.warnings
  };
}
async function translateWeb(data, options) {
  const x = data;
  const lines = x.items.map((i) => ({
    productId: normalizeProductId("web", i.productId),
    productName: i.productName,
    quantity: i.quantity
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
        country: x.customer.address.country
      }
    },
    currency: x.currency,
    status: asStatus(x.status)
  }, lines, options);
}
async function translateMobile(data, options) {
  const x = data;
  const lines = x.items.map((i) => ({
    productId: normalizeProductId("mobile", i.pid),
    productName: i.pname,
    quantity: i.qty
  }));
  return assemble({
    orderId: x.oid,
    orderType: asOrderType(x.ot),
    source: "mobile",
    orderDate: epochSecondsToIso(x.ts),
    customer: {
      name: x.cust_name,
      email: x.cust_email,
      address: parseMobileAddress(x.addr)
    },
    currency: mapCurrencyCode(x.cur),
    status: mapMobileStatus(x.st)
  }, lines, options);
}
async function translateB2B(data, options) {
  const parsed = xmlParser.parse(data);
  const x = parsed.PurchaseOrder;
  const buyer = x.BuyerParty;
  const ship = buyer.ShipToAddress;
  const rawLines = Array.isArray(x.LineItems.LineItem) ? x.LineItems.LineItem : [x.LineItems.LineItem];
  const lines = rawLines.map((i) => ({
    productId: normalizeProductId("b2b", String(i["@_sku"])),
    productName: String(i.Description),
    quantity: Number(i["@_quantity"])
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
        country: ship["@_country"]
      }
    },
    currency: x.LineItems["@_currency"],
    status: mapB2BStatus(x.Status)
  }, lines, options);
}
export {
  DEFAULT_PRICING_API_KEY,
  decodeB2BXmlBytes,
  enrichFromPricing,
  enrichItems,
  epochSecondsToIso,
  mapB2BStatus,
  mapCurrencyCode,
  mapMobileStatus,
  normalizeProductId,
  parseMobileAddress,
  toDecimalAmount,
  translateB2B,
  translateMobile,
  translateWeb
};
