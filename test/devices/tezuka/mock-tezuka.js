import { mqttPacket, mqttParse } from '@/devices/tezuka/mqtt';

/*
In-memory Tezuka: a Mosquitto-like broker driven by api_controller.sh semantics
(cmd/<path> -> retained state/<path>) and an iio_ws_proxy that serves one iio-rx
client while system/iqtape is on. Values mirror a FISHBall PlutoSky on v0.3.24.
*/

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PLUTOSKY_STATE = {
	'state/main/hw_model': 'FISHBall-PlutoSky (Z7010-AD9361)',
	'state/main/fw_version': 'tezuka-v0.3.24',
	'state/main/serial': 'YJP4PHOSRYZFKBLR',
	'state/main/iio': '0.26',
	'state/caps/rx/frequency': '[46875001 1 6000000000]',
	'state/caps/rx/sampling': '[2083333 1 61440000]',
	'state/caps/rx/gain': '[-3 1 71]',
	'state/caps/rx/bandwidth': '[200000 1 56000000]',
	'state/rx/frequency': '2399999998',
	'state/rx/sampling': '61440000',
	'state/rx/gain': '71.000000 dB',
	'state/rx/gain_mode': 'slow_attack',
	'state/rx/bandwidth': '56000000',
	'state/rx/sweep/activate': '1',
	'state/system/iqtape': 'off',
	'state/system/env/hostname': 'pluto',
};

function utf8(text) {
	const bytes = encoder.encode(text);
	return [bytes.length >> 8, bytes.length & 255, ...bytes];
}

function matches(filter, topic) {
	if (filter.endsWith('/#')) return topic.startsWith(filter.slice(0, -1)) || topic === filter.slice(0, -2);
	return filter === topic;
}

class FakeSocket {
	binaryType = 'blob';
	readyState = 0;
	onopen = null;
	onmessage = null;
	onclose = null;
	onerror = null;
	constructor(url, protocols, server) {
		this.url = url;
		this.protocols = protocols;
		this.server = server;
	}
	send(data) {
		if (this.readyState !== 1) throw new Error('socket is not open');
		this.server.receive(this, data);
	}
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.server.closed(this);
		queueMicrotask(() => this.onclose?.({ code: 1005 }));
	}
	/** Server side: deliver binary data to the client. */
	deliver(bytes) {
		if (this.readyState !== 1) return;
		const copy = bytes.slice();
		this.onmessage?.({ data: copy.buffer });
	}
	accept() {
		this.readyState = 1;
		this.onopen?.({});
	}
	drop() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.server.closed(this);
		this.onerror?.({});
		this.onclose?.({ code: 1006 });
	}
}

export function createTezuka({ state = {}, rateOffset = -1, reachable = true } = {}) {
	const values = new Map(Object.entries({ ...PLUTOSKY_STATE, ...state }));
	const commands = [];
	const clients = new Set();
	const sockets = [];
	let rxClient = null;
	const server = {
		receive(socket, data) {
			if (socket.kind === 'iq') return;
			socket.pending = mqttParse(new Uint8Array([...(socket.pending ?? []), ...data]), (header, body) => {
				const type = header >> 4;
				if (type === 1) socket.deliver(mqttPacket(0x20, [0, 0]));
				if (type === 8) {
					const filters = [];
					for (let i = 2; i < body.length;) {
						const length = (body[i] << 8) | body[i + 1];
						filters.push(decoder.decode(body.subarray(i + 2, i + 2 + length)));
						i += 3 + length;
					}
					socket.filters = [...(socket.filters ?? []), ...filters];
					socket.deliver(mqttPacket(0x90, [body[0], body[1], ...filters.map(() => 0)]));
					for (const [topic, value] of values) if (filters.some((f) => matches(f, topic))) publishTo(socket, topic, value, true);
				}
				if (type === 3) {
					const length = (body[0] << 8) | body[1];
					const topic = decoder.decode(body.subarray(2, 2 + length));
					const value = decoder.decode(body.subarray(2 + length));
					commands.push([topic, value]);
					queueMicrotask(() => apply(topic.replace(/^cmd\//, ''), value));
				}
			});
		},
		closed(socket) {
			clients.delete(socket);
			if (rxClient === socket) rxClient = null;
		},
	};

	function publishTo(socket, topic, value, retained = false) {
		socket.deliver(mqttPacket(0x30 | (retained ? 1 : 0), [...utf8(topic), ...encoder.encode(value)]));
	}

	function set(path, value) {
		const topic = `state/${path}`;
		values.set(topic, value);
		for (const socket of clients) if (socket.filters?.some((f) => matches(f, topic))) publishTo(socket, topic, value);
	}

	function apply(path, value) {
		switch (path) {
			case 'rx/sampling':
				return set(path, String(Number(value) + rateOffset));
			case 'rx/frequency':
				return set(path, String(Number(value) - 2));
			case 'rx/gain':
				return set(path, `${Number(value).toFixed(6)} dB`);
			case 'system/iqtape':
				// Like api_controller.sh: "on" restarts the proxy, dropping its client.
				rxClient?.drop();
				return set(path, value);
			default:
				return set(path, value);
		}
	}

	const openSocket = (url, protocols) => {
		const socket = new FakeSocket(url, protocols, server);
		sockets.push(socket);
		const isIq = protocols === 'iio-rx';
		socket.kind = isIq ? 'iq' : 'mqtt';
		queueMicrotask(() => {
			if (!reachable) return socket.drop();
			if (!isIq) {
				clients.add(socket);
				return socket.accept();
			}
			if (values.get('state/system/iqtape') !== 'on') return socket.drop();
			socket.accept();
			// iio_ws_proxy rejects a second RX client after the handshake.
			if (rxClient) return socket.drop();
			rxClient = socket;
		});
		return socket;
	};

	return {
		openSocket,
		values,
		commands,
		sockets,
		get rxClient() {
			return rxClient;
		},
		set,
		/** Send one IIO buffer of interleaved 12-bit samples to the RX client. */
		sendFrame(iq) {
			const words = Int16Array.from(iq);
			rxClient?.deliver(new Uint8Array(words.buffer));
		},
	};
}

export const commandsTo = (tezuka, path) => tezuka.commands.filter(([topic]) => topic === `cmd/${path}`).map(([, value]) => value);
