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
CANDIDATE_REF="${CANDIDATE_REF:-}"

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
