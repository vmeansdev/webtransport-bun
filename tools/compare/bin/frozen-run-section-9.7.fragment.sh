test "$CAMPAIGN_ID" = fanout-attested-r1
test "$EXECUTION_PURPOSE" = canonical
cd "$REPO"
CELLS=ticker-fanout/rate-10000,ticker-fanout/rate-50000,ticker-fanout/rate-100000,chat-fanout/subscribers-1000,chat-fanout/subscribers-5000,chat-fanout/subscribers-10000
REPS=5
PURPOSE=canonical
CAMPAIGN_TIMEOUT_MS=43200000
EXPECTED_PASS=60
EXPECTED_PROMOTABLE=60
EXPECTED_FLATS=12
EXPECTED_PAIRED_PROMOTIONS=6
RENDER_MODE=promoted
run_measured_campaign
