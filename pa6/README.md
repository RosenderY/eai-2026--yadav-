# PA6 — Order Fulfilment Coordinator

This assignment folder contains a contract-first HTTP API and a TypeScript process that coordinates four mock services. The solution is intentionally organised around an **order fulfilment coordinator**, rather than sharing the exact project wording and documentation structure of another repository.

## Components

| Component | Responsibility | Local port |
|---|---|---:|
| Coordinator | Validates orders, executes the saga and stores outcomes | 3000 |
| Payment mock | Authorization and refund | 4001 |
| Inventory mock | Reservation and release | 4002 |
| Shipping mock | Shipment creation | 4003 |
| Notification mock | Customer notification | 4004 |

## Start and check

Run commands from this directory:

```sh
docker compose run --rm spectral
docker compose up -d --build --wait
npm --prefix tests/public install
npm test
docker compose exec orchestrator npx tsc --noEmit
```

The Spectral service is a one-shot tool and is not part of the long-running application stack.

## Checkout sequence

The coordinator performs these operations one at a time:

1. Authorize the payment using a total calculated from item prices in integer cents.
2. Reserve the requested inventory.
3. Create the shipment.
4. Notify the customer at `customer.email`.

A failed operation stops the forward sequence. Available compensations are attempted in reverse order: inventory release, followed by payment refund. The mock services expose no compensation endpoint for shipment creation or notification delivery.

## Request example

Use a canonical order body from the course schema and include a unique key:

```sh
curl -i http://localhost:3000/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-demo-001' \
  --data @tests/public/fixtures/order.json
```

Inspect the recorded saga at `GET /debug/trace/{orderId}`. The mock services also expose `/admin/logs`, `/admin/config` and `/admin/reset` for test observation and controlled failure scenarios.

## Persistence

The coordinator writes the idempotency map to `orchestrator/data/idempotency-store.json` and saga history to `orchestrator/data/saga-store.json`. These files are mounted into the container from the repository, so completed outcomes remain available after a container restart.

## Design record

See [docs/adr-005.md](docs/adr-005.md) for the reasoning behind orchestration, sequencing, compensation boundaries, idempotency and persistence.
