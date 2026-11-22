# Order integration capstone

Intake accepts a web or mobile JSON order or a Baltic-encoded XML purchase order. It checks the client key, asks pricing for each product, and publishes the canonical order to RabbitMQ. Four services handle submission, checkout, failed-order notices and operational traces.

## Run

From this directory, use Node 20 and Docker Compose 2.20 or later. Allow Docker at least 4 GB of memory.
Run `sh ../prepare-course-fixtures.sh` once to restore the local test inputs.

```sh
docker compose up -d --build --wait
npm --prefix tests ci
npm --prefix tests run test:stage -- 6
curl http://localhost:8801/ops/metrics
```

Submit a sample with a fresh key, then look up the returned correlation ID on intake and observer.

```sh
curl -i http://localhost:8800/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-01' --data-binary @../pa4/data/web-order.json
curl http://localhost:8800/orders/$CID
curl http://localhost:8801/trace/$CID
```

Stop the stack with `docker compose down`. Adding `-v` deletes the order, saga and broker history.

## Operating limits

Use the default `SAGA_ENGINE=handrolled`. The JSON files support one writer per service and grow with traffic. A provider may deliver a notice and disconnect before the notifier can record success. A crash between accepting an event and committing the intake key can lead to a second submission; business-key and provider deduplication protect the charge. Traces are best effort. See [the runbook](docs/runbook.md) and [failure analysis](docs/failure-analysis.md).

## Advanced component

Not implemented.

PA7 contains a standalone Temporal checkout. The capstone uses the required hand-rolled saga.
