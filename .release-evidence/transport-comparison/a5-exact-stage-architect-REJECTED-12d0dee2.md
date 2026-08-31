REJECTED

The bound receipt, plan, approval-record, and command hashes match; receipt fields and command mode `0444` also match. However, the frozen command is not the approved section 9.5 command:

- It uses `phase-a-busyMs-attested` instead of fixed `bulk-one-way/physical`.
- It uses controller timeout `4200000`, not `3600000`.
- It directly invokes the controller, omitting `run_measured_campaign`, recursive campaign verification, expected-count gates, diagnostic rendering, terminal parsing, and integrity-only failure handling.

It could therefore exit successfully without proving the required two non-promotable PASS artifacts. The exact staged bytes cannot be approved.

