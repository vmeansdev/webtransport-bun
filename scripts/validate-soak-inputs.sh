#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_COMMIT:?CANDIDATE_COMMIT is required}"
: "${CAMPAIGN_SEED:?CAMPAIGN_SEED is required}"
: "${CONTINUITY_TOKEN:?CONTINUITY_TOKEN is required}"
: "${DURATION_HOURS:?DURATION_HOURS is required}"
: "${RUNNER_TYPE:?RUNNER_TYPE is required}"
: "${RUNNER_MODE:?RUNNER_MODE is required}"
: "${SEGMENT_INDEX:?SEGMENT_INDEX is required}"
: "${SEGMENT_COUNT:?SEGMENT_COUNT is required}"
: "${DATAGRAM_BATCH:?DATAGRAM_BATCH is required}"
: "${RSS_CEILING_MB:?RSS_CEILING_MB is required}"
CANDIDATE_REF="${CANDIDATE_REF:-}"
COMMITTED_ABORT_MB="${COMMITTED_ABORT_MB:-1500}"
WORKFLOW_REF="${WORKFLOW_REF:-}"
WORKFLOW_SHA="${WORKFLOW_SHA:-}"

if [[ ! "$CANDIDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
	echo "::error::candidate_commit must be an exact lowercase 40-character commit SHA"
	exit 1
fi
if [[ ! "$CANDIDATE_REF" =~ ^[-A-Za-z0-9._/@:]{0,200}$ ]]; then
	echo "::error::candidate_ref contains unsupported characters or is too long"
	exit 1
fi
if [[ ! "$CAMPAIGN_SEED" =~ ^[-A-Za-z0-9._:/+=]{1,128}$ ]]; then
	echo "::error::campaign_seed must be 1-128 shell-safe characters"
	exit 1
fi
if [[ ! "$CONTINUITY_TOKEN" =~ ^[-A-Za-z0-9._:/+=]+$ ]] || [ "${#CONTINUITY_TOKEN}" -gt 256 ]; then
	echo "::error::continuity_token must be 1-256 shell-safe characters"
	exit 1
fi
if [[ ! "$SEGMENT_INDEX" =~ ^[0-9]+$ ]] || [[ ! "$SEGMENT_COUNT" =~ ^[0-9]+$ ]]; then
	echo "::error::segment_index and segment_count must be positive integers"
	exit 1
fi
case "$RUNNER_TYPE:$RUNNER_MODE:$DURATION_HOURS:$SEGMENT_COUNT" in
	"github-hosted:shared:1:1"|"github-hosted:dedicated:1:1"|\
	"self-hosted:shared:1:1"|"self-hosted:dedicated:1:1"|\
	"github-hosted:shared:2:1"|"github-hosted:dedicated:2:1"|\
	"self-hosted:shared:2:1"|"self-hosted:dedicated:2:1"|\
	"github-hosted:shared:24:5"|"github-hosted:dedicated:24:5"|\
	"github-hosted:shared:72:15"|"github-hosted:dedicated:72:15"|\
	"self-hosted:shared:24:1"|"self-hosted:dedicated:24:1"|\
	"self-hosted:shared:72:1"|"self-hosted:dedicated:72:1") ;;
	*)
		echo "::error::invalid runner, mode, duration, or segment-count combination"
		exit 1
		;;
esac
if [ "$SEGMENT_INDEX" -lt 1 ] || [ "$SEGMENT_INDEX" -gt "$SEGMENT_COUNT" ]; then
	echo "::error::segment_index must be between 1 and segment_count"
	exit 1
fi
if [[ ! "$DATAGRAM_BATCH" =~ ^[0-9]+$ ]] || [ "$DATAGRAM_BATCH" -gt 256 ]; then
	echo "::error::datagram_batch must be a decimal integer between 0 and 256"
	exit 1
fi
if [[ ! "$RSS_CEILING_MB" =~ ^[0-9]+$ ]] || [ "$RSS_CEILING_MB" -lt 1 ]; then
	echo "::error::rss_ceiling_mb must be a positive decimal integer"
	exit 1
fi
if [[ ! "$COMMITTED_ABORT_MB" =~ ^[0-9]+$ ]]; then
	echo "::error::committed_abort_mb must be a non-negative decimal integer"
	exit 1
fi

# The hosted H7 batch-delivery campaign runs from one immutable tag whose
# suffix is the candidate commit. Everything about that lane is preregistered,
# so any drift must fail here — before the runner spends minutes on setup and
# hours on the run — rather than being discovered in the evidence afterwards.
if [[ "$CANDIDATE_REF" =~ ^refs/tags/h7-batch-delivery-([0-9a-f]{40})$ ]]; then
	H7_TAG_SUFFIX="${BASH_REMATCH[1]}"
	# Computed here, never passed in: the workflow must not be able to assert
	# its own checkout. ACTUAL_HEAD exists only so the policy suites can drive
	# this branch without rewriting the repository they run inside.
	ACTUAL_HEAD="${ACTUAL_HEAD:-$(git rev-parse HEAD 2>/dev/null || echo "")}"
	if [ "$H7_TAG_SUFFIX" != "$CANDIDATE_COMMIT" ]; then
		echo "::error::h7 candidate_ref tag suffix does not match candidate_commit"
		exit 1
	fi
	if [ "$WORKFLOW_REF" != "$CANDIDATE_REF" ]; then
		echo "::error::h7 runs must be dispatched from the candidate tag itself"
		exit 1
	fi
	if [ "$WORKFLOW_SHA" != "$CANDIDATE_COMMIT" ]; then
		echo "::error::h7 workflow sha does not match candidate_commit"
		exit 1
	fi
	if [ "$ACTUAL_HEAD" != "$CANDIDATE_COMMIT" ]; then
		echo "::error::h7 checked-out HEAD does not match candidate_commit"
		exit 1
	fi
	H7_TUPLE="$DURATION_HOURS:$RUNNER_TYPE:$RUNNER_MODE:$SEGMENT_INDEX:$SEGMENT_COUNT:$DATAGRAM_BATCH:$RSS_CEILING_MB:$COMMITTED_ABORT_MB"
	if [ "$H7_TUPLE" != "2:self-hosted:dedicated:1:1:64:1750:2200" ]; then
		echo "::error::h7 runs are pinned to duration_hours=2 runner_type=self-hosted runner_mode=dedicated segment 1/1 datagram_batch=64 rss_ceiling_mb=1750 committed_abort_mb=2200 (got $H7_TUPLE)"
		exit 1
	fi
fi
