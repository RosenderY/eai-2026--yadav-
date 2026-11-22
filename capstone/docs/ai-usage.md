# AI assistance

## Tools used

OpenAI Codex, using the instructor's public starter repository, the supplied lectures and the existing PA3–PA6 code.

## What for

Codex implemented the missing PA1, PA2, PA7 and hand-rolled capstone components, adapted the existing PA4 translation code, wrote design records and ran available checks.

## What I changed or rejected

The generated capstone selectively reuses PA4 mappings. Partial enrichment is inappropriate here: a pricing warning rejects the entire submission. The optional capstone Temporal port was left out.

## What I verified, and how

Automated checks and their results are distinguished from anticipated behavior in the failure analysis. The student must perform the personal workstation preflight and be prepared to explain the submitted code.

## Dependencies beyond the allow-list

None in the capstone application. The broker uses amqplib. AJV and ajv-formats validate the canonical schema, and fast-xml-parser handles supplier XML.
