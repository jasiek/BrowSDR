/*
Tezuka network endpoints, as served by its firmware and used by its own dashboard:
Mosquitto WebSockets on 9001 (TLS 9002) at /mqtt, and iio_ws_proxy raw IQ on 8765
(TLS 8766). An https:// page may only open wss://, and all TLS ports present the
device's self-signed maia-httpd certificate, so the user accepts it once at https://<host>/.
*/

import type { TezukaEndpoints } from './types';

export const DEFAULT_TEZUKA_HOST = 'pluto.local';

/** Accept `pluto.local`, `192.168.2.1` or a pasted dashboard URL; reject anything else. */
export function normalizeTezukaHost(input: string): string {
	let host = input.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
		try {
			host = new URL(host).hostname;
		} catch {
			host = '';
		}
	}
	host = host.replace(/\/.*$/, '').replace(/\.$/, '').toLowerCase();
	const ipv6 = /^\[[0-9a-f:.]+\]$/.test(host);
	if (!ipv6 && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host))
		throw new Error('Enter a Tezuka host name or IP address, such as pluto.local or 192.168.2.1');
	return host;
}

export function tezukaEndpoints(host: string, secure: boolean): TezukaEndpoints {
	const scheme = secure ? 'wss' : 'ws';
	return {
		host,
		secure,
		control: `${scheme}://${host}:${secure ? 9002 : 9001}/mqtt`,
		iq: `${scheme}://${host}:${secure ? 8766 : 8765}`,
		certificate: `https://${host}/`,
	};
}

/** Pages served over https:// must use the TLS ports. Workers report their script's origin. */
export function pageIsSecure(): boolean {
	return globalThis.location?.protocol === 'https:';
}
