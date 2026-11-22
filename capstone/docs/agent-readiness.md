# Agent access proposal

## Tools

Read-only: orderStatus({correlationId: UUID}), trace({correlationId: UUID}) and metrics({}). An operator-only write tool could expose replay({correlationId: UUID}); scope the request to one reviewed order.

## Injection paths

A buyer name, product description or provider error can contain prose resembling an instruction. Such values may surface in a trace or a diagnostic result.

## Controls

Parse structured fields and render returned strings as data. Keep write credentials outside the reader service. Require explicit operator authorization for a specific replay and record its correlation ID.

## Not exposed

Do not give an agent broker administrator access, arbitrary HTTP dispatch, shell execution or direct write access to the JSON stores. Compensation requires reconciliation with the provider ledger.
