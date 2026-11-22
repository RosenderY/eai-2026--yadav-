# Failure analysis

Excerpts below are projected from live local trace records. Each line shows time, operation, status and attempt. The run used the course provider mocks and a native RabbitMQ broker.

## Payment declined

The mock refused authorization with a 4xx. Inventory never ran.

Correlation ID `2970a596-5a0b-4c8e-95ed-116693150fe8`.

```text
2026-11-22T20:21:52.264Z  saga.consume  success  1
2026-11-22T20:21:52.264Z  saga.outcome  success  1
2026-11-22T20:21:52.268Z  payment  failed  1
2026-11-22T20:21:52.271Z  saga.outcome  success  1
2026-11-22T20:21:52.274Z  notify.consume  success  1
2026-11-22T20:21:52.276Z  notify.send  success  1
```

Failed with payment_declined. No operational alert is expected for a business refusal. Review the refusal before creating a new business order.

## Inventory unavailable

Authorization succeeded and reserve refused the order.

Correlation ID `b6ca7339-0cb6-4751-b88c-ccfc29cbbb09`.

```text
2026-11-22T20:21:52.951Z  saga.consume  success  1
2026-11-22T20:21:52.952Z  saga.outcome  success  1
2026-11-22T20:21:52.954Z  payment  success  1
2026-11-22T20:21:52.956Z  inventory  failed  1
2026-11-22T20:21:52.958Z  payment_refund  success  1
2026-11-22T20:21:52.959Z  saga.outcome  success  1
2026-11-22T20:21:52.961Z  notify.consume  success  1
2026-11-22T20:21:52.961Z  notify.send  success  1
```

Compensated with inventory_unavailable. No operational alert is expected after a successful refund. Verify the refund in provider effects.

## Shipping timeout

Shipping delayed its reply beyond 2.5 seconds.

Correlation ID `359478c8-4f91-422e-93f5-0865699974fe`.

```text
2026-11-22T20:21:53.133Z  saga.consume  success  1
2026-11-22T20:21:53.133Z  saga.outcome  success  1
2026-11-22T20:21:53.136Z  payment  success  1
2026-11-22T20:21:53.138Z  inventory  success  1
2026-11-22T20:21:53.139Z  shipping  timeout  1
2026-11-22T20:21:55.641Z  inventory_release  success  1
2026-11-22T20:21:55.644Z  payment_refund  success  1
2026-11-22T20:21:55.646Z  saga.outcome  success  1
2026-11-22T20:21:55.648Z  notify.consume  success  1
2026-11-22T20:21:55.648Z  notify.send  success  1
```

Compensated with timeout. No queue alert is expected. Check the shipping provider separately because a timed-out request may still create a shipment.

## Refund fails

Inventory refused the order and the first refund failed. The operator restored the mock and requested compensation.

Correlation ID `63b921a6-8d50-4754-ab86-4f74c453250e`.

```text
2026-11-22T20:24:56.402Z  saga.consume  success  1
2026-11-22T20:24:56.404Z  saga.outcome  success  1
2026-11-22T20:24:56.407Z  payment  success  1
2026-11-22T20:24:56.426Z  inventory  failed  1
2026-11-22T20:24:56.432Z  payment_refund  failed  1
2026-11-22T20:24:56.435Z  saga.outcome  success  1
2026-11-22T20:24:56.563Z  saga.operator_compensate  success  1
2026-11-22T20:24:56.564Z  payment_refund  success  1
2026-11-22T20:24:56.566Z  saga.outcome  success  1
2026-11-22T20:24:56.568Z  notify.consume  success  1
2026-11-22T20:24:56.570Z  notify.send  success  1
```

Compensation_failed triggered stuck_sagas; operator compensation finished as compensated with the original inventory error. Check the provider ledger before retrying.

## Payment outage before step one

Three temporary payment failures exhausted the retry path. After provider recovery the operator replayed this correlation ID.

Correlation ID `325fe81a-0050-46b1-a7c3-c61fcf68a62a`.

```text
2026-11-22T20:24:56.582Z  saga.consume  success  1
2026-11-22T20:24:56.582Z  saga.outcome  success  1
2026-11-22T20:24:56.585Z  payment  failed  1
2026-11-22T20:24:56.588Z  saga.retry  retried  1
2026-11-22T20:24:57.591Z  saga.consume  success  2
2026-11-22T20:24:57.591Z  saga.outcome  success  2
2026-11-22T20:24:57.593Z  payment  failed  2
2026-11-22T20:24:57.596Z  saga.retry  retried  2
2026-11-22T20:24:58.599Z  saga.consume  success  3
2026-11-22T20:24:58.600Z  saga.outcome  success  3
2026-11-22T20:24:58.601Z  payment  failed  3
2026-11-22T20:24:58.604Z  saga.dead_letter  dead_lettered  3
2026-11-22T20:24:58.606Z  saga.outcome  success  3
2026-11-22T20:24:58.711Z  dlq.replay  success  1
2026-11-22T20:24:58.713Z  saga.consume  success  1
2026-11-22T20:24:58.713Z  saga.outcome  success  1
2026-11-22T20:24:58.714Z  payment  success  1
2026-11-22T20:24:58.716Z  inventory  success  1
2026-11-22T20:24:58.718Z  shipping  success  1
2026-11-22T20:24:58.721Z  notification  success  1
2026-11-22T20:24:58.723Z  saga.outcome  success  1
```

Parked triggered dlq_not_empty. Replay completed the order under the original provider key. Confirm only one authorization effect.

## Failure-notice delivery outage

The order was declined and the notification provider refused three notice attempts. After recovery the notice was replayed.

Correlation ID `bd79d3a9-0e35-4a97-9cbd-d6c1302065a1`.

```text
2026-11-22T20:22:07.181Z  saga.consume  success  1
2026-11-22T20:22:07.182Z  saga.outcome  success  1
2026-11-22T20:22:07.183Z  payment  failed  1
2026-11-22T20:22:07.185Z  saga.outcome  success  1
2026-11-22T20:22:07.187Z  notify.consume  success  1
2026-11-22T20:22:07.187Z  notify.send  failed  1
2026-11-22T20:22:07.189Z  notify.retry  retried  1
2026-11-22T20:22:08.191Z  notify.consume  success  2
2026-11-22T20:22:08.191Z  notify.send  failed  2
2026-11-22T20:22:08.194Z  notify.retry  retried  2
2026-11-22T20:22:09.196Z  notify.consume  success  3
2026-11-22T20:22:09.197Z  notify.send  failed  3
2026-11-22T20:22:09.199Z  notify.dead_letter  dead_lettered  3
2026-11-22T20:22:09.369Z  dlq.replay  success  1
2026-11-22T20:22:09.370Z  notify.consume  success  1
2026-11-22T20:22:09.371Z  notify.send  success  1
```

The order stayed failed. dlq_not_empty cleared after replay. Verify the notice effect before replaying another entry.

## Orchestrator crash mid-saga

The test killed the coordinator after the inventory success was durable and restarted it with the same store.

Correlation ID `450689d2-e332-4d4a-af20-ac4ab4558868`.

```text
2026-11-22T20:24:59.193Z  saga.consume  success  1
2026-11-22T20:24:59.193Z  saga.outcome  success  1
2026-11-22T20:24:59.194Z  payment  success  1
2026-11-22T20:24:59.197Z  inventory  success  1
2026-11-22T20:24:59.423Z  saga.stuck  success  1
2026-11-22T20:24:59.424Z  saga.outcome  success  1
2026-11-22T20:24:59.429Z  saga.consume  success  1
2026-11-22T20:24:59.429Z  saga.outcome  success  1
2026-11-22T20:24:59.558Z  saga.operator_compensate  success  1
2026-11-22T20:24:59.559Z  inventory_release  success  1
2026-11-22T20:24:59.575Z  payment_refund  success  1
2026-11-22T20:24:59.579Z  saga.outcome  success  1
2026-11-22T20:24:59.584Z  notify.consume  success  1
2026-11-22T20:24:59.584Z  notify.send  success  1
```

Needs_attention triggered stuck_sagas. Operator compensation released inventory and refunded payment; the final code was operator_compensated. Check whether shipping acted before the crash.

## Broker restart

The broker stopped, restarted with its existing store and accepted the next order after the four services recovered.

Correlation ID `3d98aec9-8813-4da2-93ef-c301b4c79da5`.

```text
2026-11-22T20:25:06.768Z  saga.consume  success  1
2026-11-22T20:25:06.768Z  saga.outcome  success  1
2026-11-22T20:25:06.770Z  payment  success  1
2026-11-22T20:25:06.774Z  inventory  success  1
2026-11-22T20:25:06.778Z  shipping  success  1
2026-11-22T20:25:06.781Z  notification  success  1
2026-11-22T20:25:06.786Z  saga.outcome  success  1
```

The probe order completed. Service health degraded during disconnect; the observer may itself be unavailable during a broker outage. Verify all four health endpoints after recovery.

## Duplicate with a fresh client key

Two accepted submissions shared one source and order ID but had distinct client keys.

Correlation ID `942ad8a7-c4ee-49cb-b357-dc550b958cd4`.

```text
2026-11-22T20:24:59.032Z  saga.consume  success  1
2026-11-22T20:24:59.032Z  saga.dedupe  duplicate  1
2026-11-22T20:24:59.032Z  saga.outcome  success  1
```

The second saga ended duplicate without provider calls. No operational alert is expected. Inspect duplicateOf to find the original.

## Malformed message

The public test published invalid JSON without a correlation header. The invalid queue kept the original bytes and there was no retry or DLQ delivery. Without a correlation ID there is no per-order trace or order state. The observed test result was:

```text
P4.1 passed: malformed input reached orders.invalid with original bytes.
```

The invalid_not_empty alert persists until the message is archived and removed. Correct the producing system and submit a new valid event.
