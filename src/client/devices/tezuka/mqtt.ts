/*
Minimal MQTT 3.1.1 client over WebSocket for Tezuka's control broker.

Only what BrowSDR needs: a clean session, QoS 0 publish and subscribe, and a
keepalive. Retained `state/...` messages arrive right after SUBSCRIBE, so the
latest value of every topic is kept in `values`.
Protocol reference: MQTT Version 3.1.1, OASIS Standard (2014), sections 2-3.
*/

import type { WebSocketFactory } from './types';

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const KEEPALIVE_S = 30;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(text: string): number[] {
	const bytes = encoder.encode(text);
	return [bytes.length >> 8, bytes.length & 255, ...bytes];
}

function remainingLength(length: number): number[] {
	const out: number[] = [];
	do {
		let digit = length % 128;
		length = Math.floor(length / 128);
		if (length) digit |= 128;
		out.push(digit);
	} while (length);
	return out;
}

export function mqttPacket(header: number, body: number[] | Uint8Array): Uint8Array {
	const length = remainingLength(body.length);
	const packet = new Uint8Array(1 + length.length + body.length);
	packet[0] = header;
	packet.set(length, 1);
	packet.set(body, 1 + length.length);
	return packet;
}

/** Split complete packets off the front of `buffer`; returns the unconsumed tail. */
export function mqttParse(buffer: Uint8Array, onPacket: (header: number, body: Uint8Array) => void): Uint8Array {
	let offset = 0;
	while (buffer.length - offset >= 2) {
		let length = 0;
		let multiplier = 1;
		let index = offset + 1;
		let digit: number;
		do {
			if (index >= buffer.length) return buffer.subarray(offset);
			digit = buffer[index++];
			length += (digit & 127) * multiplier;
			multiplier *= 128;
		} while (digit & 128);
		if (buffer.length < index + length) break;
		onPacket(buffer[offset], buffer.subarray(index, index + length));
		offset = index + length;
	}
	return buffer.subarray(offset);
}

export class MqttWsClient {
	/** Latest payload per topic, including retained messages. */
	readonly values = new Map<string, string>();
	private socket?: WebSocket;
	private pending = new Uint8Array(0);
	private packetId = 0;
	private keepalive?: ReturnType<typeof setInterval>;
	private watchers = new Set<(topic: string, value: string) => void>();
	private acks = new Map<number, () => void>();

	constructor(private readonly openSocket: WebSocketFactory) {}

	get connected(): boolean {
		return this.socket?.readyState === 1;
	}

	/** Open the socket and complete CONNECT/CONNACK, or reject within `timeoutMs`. */
	async connect(url: string, clientId: string, timeoutMs: number): Promise<void> {
		this.close();
		const socket = this.openSocket(url, ['mqtt']);
		socket.binaryType = 'arraybuffer';
		this.socket = socket;
		this.pending = new Uint8Array(0);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);
			const fail = (error: Error) => {
				clearTimeout(timer);
				if (this.socket === socket) this.close();
				reject(error);
			};
			socket.onopen = () => {
				// Protocol level 4 (3.1.1), clean session, keepalive in seconds.
				socket.send(mqttPacket(CONNECT << 4, [...utf8('MQTT'), 4, 2, 0, KEEPALIVE_S, ...utf8(clientId)]));
			};
			socket.onerror = () => fail(new Error('connection failed'));
			socket.onclose = () => fail(new Error('connection closed'));
			socket.onmessage = (event: MessageEvent) =>
				this.receive(event, (header, body) => {
					if (header >> 4 !== CONNACK) return;
					if (body[1] !== 0) return fail(new Error(`broker refused the connection (code ${body[1]})`));
					clearTimeout(timer);
					socket.onclose = socket.onerror = () => this.dropped(socket);
					this.keepalive = setInterval(() => this.send(mqttPacket(PINGREQ << 4, [])), (KEEPALIVE_S * 1000) / 2);
					resolve();
				});
		});
	}

	/** Subscribe and wait for SUBACK; retained messages for the filter follow it. */
	subscribe(filters: string[], timeoutMs = 3000): Promise<void> {
		const id = (this.packetId = (this.packetId % 0xffff) + 1);
		const body = [id >> 8, id & 255, ...filters.flatMap((filter) => [...utf8(filter), 0])];
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.acks.delete(id);
				reject(new Error('subscription timed out'));
			}, timeoutMs);
			this.acks.set(id, () => {
				clearTimeout(timer);
				resolve();
			});
			// SUBSCRIBE carries fixed-header flags 0b0010.
			this.send(mqttPacket((SUBSCRIBE << 4) | 2, body));
		});
	}

	publish(topic: string, value: string | number): void {
		this.send(mqttPacket(PUBLISH << 4, [...utf8(topic), ...encoder.encode(String(value))]));
	}

	/** Resolve with the first value of `topic` that satisfies `accept`, the current one included. */
	waitFor(topic: string, accept: (value: string) => boolean, timeoutMs: number): Promise<string | null> {
		const current = this.values.get(topic);
		if (current !== undefined && accept(current)) return Promise.resolve(current);
		return new Promise((resolve) => {
			const done = (value: string | null) => {
				clearTimeout(timer);
				this.watchers.delete(watcher);
				resolve(value);
			};
			const watcher = (changed: string, value: string) => {
				if (changed === topic && accept(value)) done(value);
			};
			const timer = setTimeout(() => done(null), timeoutMs);
			this.watchers.add(watcher);
		});
	}

	close(): void {
		clearInterval(this.keepalive);
		this.keepalive = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
		try {
			socket.close();
		} catch {
			/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
		}
	}

	private send(packet: Uint8Array): void {
		if (!this.connected) throw new Error('Tezuka control connection is closed');
		this.socket!.send(packet);
	}

	private dropped(socket: WebSocket): void {
		if (this.socket === socket) this.close();
	}

	private receive(event: MessageEvent, onPacket: (header: number, body: Uint8Array) => void): void {
		if (!(event.data instanceof ArrayBuffer)) return;
		const data = new Uint8Array(event.data);
		const joined = new Uint8Array(this.pending.length + data.length);
		joined.set(this.pending);
		joined.set(data, this.pending.length);
		this.pending = mqttParse(joined, (header, body) => {
			onPacket(header, body);
			this.handle(header, body);
		}).slice();
	}

	private handle(header: number, body: Uint8Array): void {
		const type = header >> 4;
		if (type === SUBACK) this.acks.get((body[0] << 8) | body[1])?.();
		if (type !== PUBLISH) return;
		const topicLength = (body[0] << 8) | body[1];
		const topic = decoder.decode(body.subarray(2, 2 + topicLength));
		// QoS 1 and 2 messages carry a packet identifier before the payload.
		const payloadStart = 2 + topicLength + ((header >> 1) & 3 ? 2 : 0);
		const value = decoder.decode(body.subarray(payloadStart));
		this.values.set(topic, value);
		for (const watcher of [...this.watchers]) watcher(topic, value);
	}
}
