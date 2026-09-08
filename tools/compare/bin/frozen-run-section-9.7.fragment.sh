test "$CAMPAIGN_ID" = fanout-attested-r1
test "$EXECUTION_PURPOSE" = canonical
cd "$REPO"
CELLS=ticker-fanout/rate-50,ticker-fanout/rate-100,ticker-fanout/rate-250,chat-fanout/subscribers-250,chat-fanout/subscribers-500,chat-fanout/subscribers-1000
REPS=5
PURPOSE=canonical
CAMPAIGN_TIMEOUT_MS=14400000
EXPECTED_PASS=60
EXPECTED_PROMOTABLE=60
EXPECTED_FLATS=12
EXPECTED_PAIRED_PROMOTIONS=6
EXPECTED_SEALED=60
EXPECT_CANONICAL_FANOUT_COMPLETE=1
RENDER_MODE=promoted
run_measured_campaign
