# API Regression Runner

Run structured API checks, capture failures precisely, and separate regressions from environment noise.

## Use when
- A user asks to verify endpoints after a change.
- You need a repeatable test pass with clear pass/fail reporting.

## Workflow
1. Identify the exact endpoints, auth requirements, and expected status/body shape.
2. Run the smallest useful request set first before widening coverage.
3. Record request method, target, status code, latency, and key response fields.
4. Distinguish product bugs from setup issues such as missing keys, bad base URLs, or disabled services.
5. End with a short matrix: passing checks, failing checks, likely cause, next fix.

## Deliverable
- A compact report with endpoint, result, evidence, and recommended follow-up.
