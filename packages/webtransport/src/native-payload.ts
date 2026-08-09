type NativePayload = Uint8Array | null;

type OwnedRead = (() => Promise<NativePayload>) | undefined;
type LegacyRead = (() => Promise<Buffer | Uint8Array | null>) | undefined;

const CAPABILITY_ERROR =
	"E_INTERNAL: native addon payload ownership capability mismatch";

export async function readNativePayload(
	ownedRead: OwnedRead,
	legacyRead: LegacyRead,
	allowLegacyTestDouble: boolean,
): Promise<NativePayload> {
	if (ownedRead) {
		const payload = await ownedRead();
		if (payload === null || payload instanceof Uint8Array) return payload;
		throw new Error(
			`${CAPABILITY_ERROR}: owned read returned an invalid value`,
		);
	}

	if (allowLegacyTestDouble && legacyRead) {
		const payload = await legacyRead();
		return payload === null ? null : new Uint8Array(payload);
	}

	throw new Error(CAPABILITY_ERROR);
}
