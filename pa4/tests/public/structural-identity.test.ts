import { describe, expect, it } from "vitest";
import {
  DEFAULT_B2B_ORDER_PATH,
  DEFAULT_MOBILE_ORDER_PATH,
  DEFAULT_PRICING_BASE_URL,
  DEFAULT_WEB_ORDER_PATH,
  translateB2B,
  translateMobile,
  translateWeb,
  type CanonicalOrder,
} from "../../starter/src/transform";

const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

function core(order: CanonicalOrder): Omit<CanonicalOrder, "orderId" | "orderType" | "source" | "receivedAt"> {
  const { orderId, orderType, source, receivedAt, ...rest } = order;
  return rest;
}

describe("same logical order from all three sources", () => {
  it("produces equivalent canonical content", async () => {
    const web = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const mobile = await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options);
    const b2b = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);
    expect(web.order).not.toBeNull();
    expect(mobile.order).not.toBeNull();
    expect(b2b.order).not.toBeNull();
    expect(core(mobile.order!)).toEqual(core(web.order!));
    expect(core(b2b.order!)).toEqual(core(web.order!));
  });

  it("uses the same business instant", async () => {
    const web = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const mobile = await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options);
    expect(new Date(mobile.order!.orderDate).getTime())
      .toBe(new Date(web.order!.orderDate).getTime());
  });

  it("preserves Latvian characters", async () => {
    const web = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const b2b = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);
    expect(b2b.order!.customer.name).toBe(web.order!.customer.name);
    expect(b2b.order!.customer.name).toBe("Anna Bērziņa");
    expect(b2b.order!.customer.address.city).toBe("Rīga");
  });
});
