# Operating the checkout

Run these commands from capstone/. Use `curl localhost:8801/ops/metrics` after each repair. For one purchase, follow `/trace/$CID` on port 8801 and `/orders/$CID` on port 8800.

## dlq_not_empty

A consumer exhausted three attempts. Payment or notice delivery may be offline. Inspect `curl localhost:8800/dlq` for originQueue and lastError. Restore the named provider. Replay only the reviewed case using `curl -X POST localhost:8800/dlq/replay -H 'Content-Type: application/json' -d "{\"correlationId\":\"$CID\"}"`. Verify its outcome and the remaining depth.

## invalid_not_empty

A producer sent malformed JSON, an invalid canonical shape or missing headers. Inspect its logs and the invalid queue using RabbitMQ management with requeue enabled. Fix the producer and submit a corrected order with its own key. Quarantined payloads are retained; the alert remains until operations archives and removes them.

## saga_consumer_missing

The checkout consumer is disconnected. Check `docker compose ps orchestrator rabbitmq` and `docker compose logs --tail 50 orchestrator` for process exit or broker authentication failure. Restore the affected service or configuration. Verify a positive consumer count and an order completing.

## notifier_consumer_missing

A failed notifier process or a lost broker connection leaves failure notices waiting. Inspect `docker compose logs --tail 50 notifier rabbitmq`, restore connectivity or start the notifier, and verify its health and a positive notifications.queue consumer count.

## saga_consumer_lag

More than five ready orders exceed one batch at the configured concurrency of five. A burst of purchases or slow providers can cause this. Compare ready and unacked counts with provider durations in the trace. Restore a slow dependency or allow the burst to drain. Verify the backlog falls below the threshold while completed orders increase.

## notifier_consumer_lag

More than three ready notices warrant investigation because the single consumer sends one short request at a time. A failure burst or slow notification service can explain the queue. Inspect `docker compose logs notifier notification`, restore delivery, and verify ready falls to three or below. Inspect the DLQ separately for exhausted messages.

## stuck_sagas

A worker interruption or an unsuccessful refund/release needs reconciliation. Read `curl localhost:8802/sagas/stuck`, the trace and provider effects. Confirm what shipped and which reservations or charges succeeded. Restore providers before `curl -X POST localhost:8802/sagas/$CID/compensate`. Verify the order state and that the ID has left the stuck list.
