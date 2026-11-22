/**
 * PA1 — legacy file ingestion.
 *
 * You are reading two files that a system you do not control exports for you:
 *
 *   data/orders-20260901.txt   fixed-width, CP1257 ("windows-1257")
 *   data/customers.csv         semicolon-separated, UTF-8
 *
 * Yes, two different encodings in one integration. That is not a trick I
 * invented; it is Tuesday.
 *
 * Everything you need is in the Node standard library. Do not add a parsing,
 * CSV or encoding dependency — feeling where these files fight back is the
 * entire point of the assignment, and a public test checks for it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- contract --
// The grader calls ingest() directly, with its own input files. Do not change
// its name, its parameters or the shape of what it returns. Everything else in
// this file is yours to restructure.

export interface Order {
  orderId: string;
  customerId: string;
  /** Correctly decoded and trimmed. "Bērziņš", never "B?rzi??". */
  customerName: string;
  /** ISO-8601 calendar date: "2026-09-01". */
  orderDate: string;
  /** Decimal STRING, never a number: "1234.56", "-250.00", "0.00". */
  amount: string;
  currency: string;
}

export interface RejectedRecord {
  /** 1-based line number in the orders file. */
  line: number;
  /** The offending line, as you decoded it. */
  raw: string;
  /** Why you rejected it, in plain language. */
  reason: string;
}

export interface Report {
  orders: Order[];
  rejected: RejectedRecord[];
  /** Customer ids that appear in the CSV but on no accepted order. */
  unmatchedCustomers: string[];
}

export interface IngestOptions {
  ordersPath: string;
  customersPath: string;
}

// ------------------------------------------------------------------ layout --
// The order file is fixed-width. Every field is LEFT-aligned and padded with
// trailing spaces. Slice by position — you cannot split on whitespace, because
// the names contain spaces.
//
//   field         columns (0-indexed, end exclusive)   width
//   orderId        0 .. 10                               10
//   customerId    10 .. 20                               10
//   customerName  20 .. 52                               32
//   orderDate     52 .. 62                               10   DD.MM.YYYY
//   amount        62 .. 74                               12   comma decimal
//   currency      74 .. 77                                3
//
// A well-formed line is exactly 77 characters.

export const ORDER_LAYOUT = {
  orderId: [0, 10],
  customerId: [10, 20],
  customerName: [20, 52],
  orderDate: [52, 62],
  amount: [62, 74],
  currency: [74, 77],
} as const;

export const ORDER_LINE_LENGTH = 77;

// ------------------------------------------------------------------- paths --
// Resolved from this file's own location, so the program behaves the same
// whichever directory you run it from.

const PA1_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_ORDERS_PATH = path.join(PA1_ROOT, "data", "orders-20260901.txt");
export const DEFAULT_CUSTOMERS_PATH = path.join(PA1_ROOT, "data", "customers.csv");
export const OUTPUT_PATH = path.join(PA1_ROOT, "out", "report.json");

// ------------------------------------------------------------------- steps --
// Suggested decomposition. Only ingest() is contractual — if you would rather
// structure this differently, do, and say why in your ADR.

export function ingest(options: IngestOptions): Report {
  const customerRows = readFileSync(options.customersPath, "utf8").trimEnd().split(/\r?\n/).slice(1);
  const unmatched = new Set(customerRows.map(row => row.split(";")[0]!.trim()));
  const text = new TextDecoder("windows-1257").decode(readFileSync(options.ordersPath));
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const orders: Order[] = [];
  const rejected: RejectedRecord[] = [];
  lines.forEach((raw, index) => {
    try {
      if (raw.length !== ORDER_LINE_LENGTH) throw new Error(`expected 77 characters, got ${raw.length}`);
      const field = (name: keyof typeof ORDER_LAYOUT) => raw.slice(...ORDER_LAYOUT[name]).trim();
      const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(field("orderDate"));
      if (!date) throw new Error("expected DD.MM.YYYY");
      const amount = field("amount");
      if (!/^-?\d+,\d{2}$/.test(amount)) throw new Error("expected a comma decimal with two digits");
      const customerId = field("customerId");
      orders.push({orderId: field("orderId"), customerId, customerName: field("customerName"),
        orderDate: `${date[3]}-${date[2]}-${date[1]}`, amount: amount.replace(",", "."), currency: field("currency")});
      unmatched.delete(customerId);
    } catch (error) {
      rejected.push({line: index + 1, raw, reason: (error as Error).message});
    }
  });
  return { orders, rejected, unmatchedCustomers: [...unmatched] };
}

// -------------------------------------------------------------------- main --

/** Writes the report to pa1/out/report.json. Run with: npm start */
export function main(): void {
  const report = ingest({
    ordersPath: DEFAULT_ORDERS_PATH,
    customersPath: DEFAULT_CUSTOMERS_PATH,
  });

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(
    `wrote ${OUTPUT_PATH}\n` +
      `  ${report.orders.length} orders\n` +
      `  ${report.rejected.length} rejected\n` +
      `  ${report.unmatchedCustomers.length} customers with no order`,
  );
}

// Only run main() when this file is executed directly, not when it is imported
// by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
