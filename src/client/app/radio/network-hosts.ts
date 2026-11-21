const TEZUKA_HOST_KEY = 'BrowSDR:tezukaHost';

/** The last Tezuka host this browser connected to, if any. */
export function savedTezukaHost(): string | null {
	try {
		return globalThis.localStorage?.getItem(TEZUKA_HOST_KEY) || null;
	} catch {
		return null;
	}
}

export function saveTezukaHost(host: string): void {
	try {
		globalThis.localStorage?.setItem(TEZUKA_HOST_KEY, host);
	} catch {
		/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
	}
}
