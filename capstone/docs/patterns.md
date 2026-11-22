# Integration patterns

| Pattern | Problem | Where | Why |
|---|---|---|---|
| Normalizer | Three order formats | [intake/index.js:29](../intake/index.js#L29) | XML uses the media type; JSON uses orderId and customer or oid. |
| Message Translator | Legacy fields differ | [intake/translate.js:154](../intake/translate.js#L154) | Maps mobile fields into the canonical structure. |
| Content Enricher | Prices belong to a separate service | [intake/translate.js:19](../intake/translate.js#L19) | Fetches authoritative product pricing. |
| Content-Based Router | Invoiced B2B orders skip payment | [orchestrator/index.js:62](../orchestrator/index.js#L62) | Routes by order type. |
| Process Manager | Several local effects form checkout | [orchestrator/index.js:45](../orchestrator/index.js#L45) | Persists progress and coordinates undo. |
| Idempotent Receiver | A business order can arrive twice | [orchestrator/index.js:57](../orchestrator/index.js#L57) | Prevents a second saga for that purchase. |
| Dead Letter Channel | A temporary error outlives retry limits | [shared/runtime.js:72](../shared/runtime.js#L72) | Preserves payload and origin for controlled replay. |
| Invalid Message Channel | Malformed orders will never succeed | [shared/runtime.js:57](../shared/runtime.js#L57) | Keeps original bytes available for inspection. |
| Wire Tap | Cross-service diagnosis | [shared/runtime.js:39](../shared/runtime.js#L39) | Publishes hops independently of checkout. |
