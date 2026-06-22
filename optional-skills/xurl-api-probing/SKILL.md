# XURL API Probing

Probe APIs directly and methodically before assuming the client or app layer is at fault.

## Use when
- An endpoint is failing and the transport details matter.
- The task needs a minimal repro using HTTP requests.
- You need to compare raw API behavior against app behavior.

## Workflow
1. Start with the smallest request that proves reachability and auth.
2. Capture method, URL, headers, body, and the exact status code.
3. Reduce payloads until the failure shape is obvious.
4. Compare a passing and failing request whenever possible.
5. Feed the findings back into the app fix or setup guidance.

## Deliverable
- Minimal request examples.
- Exact response status and body shape.
- Root cause or likely boundary.
- Recommended app-side change or config fix.
