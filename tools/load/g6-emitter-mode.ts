export const G6_EMITTER_MODES = [
	"per-player-batch",
	"native-mirror",
	"paced-mirror",
] as const;

export type G6EmitterMode = (typeof G6_EMITTER_MODES)[number];

export function resolveEmitterMode(
	raw: string | undefined,
	paced: boolean,
): G6EmitterMode {
	const mode = raw ?? (paced ? "paced-mirror" : "per-player-batch");
	if (!G6_EMITTER_MODES.includes(mode as G6EmitterMode)) {
		throw new Error(
			`G6_EMITTER_MODE must be one of ${G6_EMITTER_MODES.join(", ")}`,
		);
	}
	if ((mode === "paced-mirror") !== paced) {
		throw new Error(
			`G6_EMITTER_MODE=${mode} does not match --paced=${paced ? "1" : "0"}`,
		);
	}
	return mode as G6EmitterMode;
}
