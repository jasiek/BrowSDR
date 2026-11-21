import { afterEach, describe, expect, it, vi } from 'vitest';
import { TezukaDevice } from '@/devices/tezuka/device';
import { normalizeTezukaHost, tezukaEndpoints } from '@/devices/tezuka/endpoints';
import { mqttPacket, mqttParse } from '@/devices/tezuka/mqtt';
import { commandsTo, createTezuka } from './mock-tezuka.js';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function connected(options) {
	const tezuka = createTezuka(options);
	const device = new TezukaDevice('pluto.local', { openSocket: tezuka.openSocket, secure: false });
	await device.open();
	return { tezuka, device };
}

/** Start reception and send one frame once the proxy has accepted the client. */
async function receiving(device, tezuka, onData = () => {}) {
	const started = device.startRx(onData);
	await vi.waitFor(() => expect(tezuka.rxClient).toBeTruthy());
	tezuka.sendFrame(new Array(8).fill(0));
	await started;
}

describe('Tezuka endpoints', () => {
	it('uses the plain ports on http:// pages and the TLS ports on https:// pages', () => {
		expect(tezukaEndpoints('pluto.local', false)).toMatchObject({
			control: 'ws://pluto.local:9001/mqtt',
			iq: 'ws://pluto.local:8765',
		});
		expect(tezukaEndpoints('pluto.local', true)).toMatchObject({
			control: 'wss://pluto.local:9002/mqtt',
			iq: 'wss://pluto.local:8766',
			certificate: 'https://pluto.local/',
		});
	});

	it('accepts host names, addresses and pasted dashboard URLs only', () => {
		expect(normalizeTezukaHost(' Pluto.Local. ')).toBe('pluto.local');
		expect(normalizeTezukaHost('192.168.2.1')).toBe('192.168.2.1');
		expect(normalizeTezukaHost('https://pluto.local/#/iqtape')).toBe('pluto.local');
		expect(normalizeTezukaHost('[fe80::1]')).toBe('[fe80::1]');
		for (const bad of ['', 'pluto local', 'host:9001', 'pluto?x', '-pluto', 'javascript:alert(1)'])
			expect(() => normalizeTezukaHost(bad)).toThrow();
	});
});

describe('MQTT framing', () => {
	it('round-trips packets with multi-byte lengths split across WebSocket messages', () => {
		const body = new Uint8Array(300).map((_, i) => i & 255);
		const packet = mqttPacket(0x30, body);
		expect([...packet.subarray(0, 3)]).toEqual([0x30, 0xac, 0x02]);
		const seen = [];
		const tail = mqttParse(packet.subarray(0, 200), (header, data) => seen.push([header, data.slice()]));
		expect(seen).toHaveLength(0);
		const joined = new Uint8Array([...tail, ...packet.subarray(200), ...mqttPacket(0xd0, [])]);
		expect(mqttParse(joined, (header, data) => seen.push([header, data.slice()]))).toHaveLength(0);
		expect(seen.map(([header]) => header)).toEqual([0x30, 0xd0]);
		expect(seen[0][1]).toEqual(body);
	});
});

describe('Tezuka device', () => {
	it('reads ranges from the retained capabilities and stops the spectrum sweep', async () => {
		const { tezuka, device } = await connected();
		expect(device.frequencyRange).toEqual([46875001, 6000000000]);
		expect(device.gainControls.find((control) => control.name === 'RF')).toMatchObject({ min: -3, max: 71, default: 40 });
		expect(device.sampleRates[0]).toBe(2400000);
		await vi.waitFor(() => expect(commandsTo(tezuka, 'rx/sweep/activate')).toEqual(['0']));
		expect(await device.getInfo()).toMatchObject({
			name: 'FISHBall-PlutoSky (Tezuka)',
			firmware: 'tezuka-v0.3.24',
			serial: 'YJP4PHOSRYZFKBLR',
			tuner: 'AD9361',
			product: 'pluto.local',
		});
	});

	it('leaves the sweep alone when it is off', async () => {
		const { tezuka } = await connected({ state: { 'state/rx/sweep/activate': '0' } });
		expect(commandsTo(tezuka, 'rx/sweep/activate')).toEqual([]);
	});

	it('explains how to reach the broker when it cannot connect', async () => {
		const tezuka = createTezuka({ reachable: false });
		const plain = new TezukaDevice('pluto.local', { openSocket: tezuka.openSocket, secure: false });
		await expect(plain.open()).rejects.toThrow(/ws:\/\/pluto\.local:9001\/mqtt .*runs Tezuka firmware/);
		const secure = new TezukaDevice('pluto.local', { openSocket: tezuka.openSocket, secure: true });
		await expect(secure.open()).rejects.toThrow(/wss:\/\/pluto\.local:9002\/mqtt .*accept its certificate/);
	});

	it('on https:// pages, falls back to the TLS ports when the browser blocks ws:// as mixed content', async () => {
		vi.stubGlobal('location', { protocol: 'https:' });
		const tezuka = createTezuka({ state: { 'state/system/iqtape': 'on' } });
		const openSocket = (url, protocols) => {
			if (url.startsWith('ws:')) throw new DOMException('An insecure WebSocket connection may not be initiated', 'SecurityError');
			return tezuka.openSocket(url, protocols);
		};
		const device = new TezukaDevice('pluto.local', { openSocket });
		await device.open();
		expect(device.endpoints.control).toBe('wss://pluto.local:9002/mqtt');
		await receiving(device, tezuka);
		expect(tezuka.rxClient.url).toBe('wss://pluto.local:8766');
		vi.unstubAllGlobals();
	});

	it('on https:// pages, keeps ws:// when the browser allows it for local network hosts', async () => {
		vi.stubGlobal('location', { protocol: 'https:' });
		const tezuka = createTezuka();
		const device = new TezukaDevice('pluto.local', { openSocket: tezuka.openSocket });
		await device.open();
		expect(device.endpoints.iq).toBe('ws://pluto.local:8765');
		vi.unstubAllGlobals();
	});

	it('rejects an MQTT broker that reports no Tezuka receiver', async () => {
		const tezuka = createTezuka({ state: { 'state/caps/rx/frequency': undefined } });
		tezuka.values.delete('state/caps/rx/frequency');
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		const device = new TezukaDevice('pluto.local', { openSocket: tezuka.openSocket, secure: false });
		const opened = device.open().catch((error) => error);
		await vi.advanceTimersByTimeAsync(3000);
		expect((await opened).message).toMatch(/no receiver state/);
	});

	it('tunes, sets the rate with a matching RF bandwidth, and confirms both', async () => {
		const { tezuka, device } = await connected();
		await device.setSampleRate(3000000);
		expect(commandsTo(tezuka, 'rx/sampling')).toEqual(['3000000']);
		expect(commandsTo(tezuka, 'rx/bandwidth')).toEqual(['3000000']);
		await device.setFrequency(99e6);
		expect(commandsTo(tezuka, 'rx/frequency')).toEqual(['99000000']);
		await expect(device.setFrequency(30e6)).rejects.toThrow('46.875-6000 MHz');
	});

	it('applies manual gain within the reported range and again after each retune', async () => {
		const { tezuka, device } = await connected();
		await device.setGain('RF', 30);
		expect(commandsTo(tezuka, 'rx/gain')).toEqual([]); // The firmware's AGC mode stays until a mode is chosen.
		await device.setGains({ 'Gain Mode': 0, RF: 90 });
		expect(commandsTo(tezuka, 'rx/gain_mode')).toEqual(['manual']);
		expect(commandsTo(tezuka, 'rx/gain')).toEqual(['71']);
		await device.setFrequency(433.92e6);
		expect(commandsTo(tezuka, 'rx/gain')).toEqual(['71', '71']);
		await device.setGain('Gain Mode', 2);
		expect(commandsTo(tezuka, 'rx/gain_mode').at(-1)).toBe('fast_attack');
	});

	it('starts the IQ proxy, receives 12-bit samples as left-aligned IQ, and stops the proxy it started', async () => {
		const { tezuka, device } = await connected();
		const received = [];
		const started = device.startRx((data) => received.push(data));
		await vi.waitFor(() => expect(tezuka.rxClient).toBeTruthy());
		expect(commandsTo(tezuka, 'system/iqtape')).toEqual(['on']);
		expect(tezuka.rxClient.url).toBe('ws://pluto.local:8765');
		tezuka.sendFrame([2047, -2048, 1, -1]);
		await started;
		expect(received[0]).toBeInstanceOf(Int16Array);
		expect([...received[0]]).toEqual([2047 << 4, -2048 << 4, 16, -16]);
		await device.stopRx();
		expect(tezuka.rxClient).toBeNull();
		await device.close();
		expect(commandsTo(tezuka, 'system/iqtape')).toEqual(['on', 'off']);
	});

	it('delivers 8-bit IQ when selected', async () => {
		const { tezuka, device } = await connected();
		await device.setGain('IQ Precision', 1);
		expect(device.sampleFormat).toBe('int8');
		const received = [];
		const started = device.startRx((data) => received.push(data));
		await vi.waitFor(() => expect(tezuka.rxClient).toBeTruthy());
		tezuka.sendFrame([2047, -2048, 16, -16]);
		await started;
		expect([...received[0]]).toEqual([127, -128, 1, -1]);
		await expect(device.setGain('IQ Precision', 0)).rejects.toThrow('Stop reception');
	});

	it('joins a running proxy without restarting it, and leaves it running', async () => {
		const { tezuka, device } = await connected({ state: { 'state/system/iqtape': 'on' } });
		await receiving(device, tezuka);
		await device.close();
		expect(commandsTo(tezuka, 'system/iqtape')).toEqual([]);
	});

	it('reports a busy proxy when another client holds the RX stream', async () => {
		const { tezuka, device } = await connected({ state: { 'state/system/iqtape': 'on' } });
		const other = tezuka.openSocket('ws://pluto.local:8765', 'iio-rx');
		await vi.waitFor(() => expect(tezuka.rxClient).toBe(other));
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const started = device.startRx(() => {}).catch((error) => error);
		await vi.advanceTimersByTimeAsync(11000);
		expect((await started).message).toMatch(/busy: it serves one receiver at a time/);
	});

	it('paces each network frame over its duration in about 8 ms chunks', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
		const { tezuka, device } = await connected({ state: { 'state/system/iqtape': 'on' } });
		await device.setSampleRate(2400000);
		const received = [];
		const started = device.startRx((data) => received.push(data));
		await vi.advanceTimersByTimeAsync(0);
		// One default proxy buffer: 262144 samples, about 109 ms at 2.4 MSPS.
		tezuka.sendFrame(new Int16Array(262144 * 2));
		await started;
		const samples = () => received.reduce((total, chunk) => total + chunk.length / 2, 0);
		expect(received[0].length / 2).toBe(19200);
		expect(samples()).toBeLessThan(40000);
		await vi.advanceTimersByTimeAsync(50);
		expect(samples()).toBeGreaterThan(110000);
		expect(samples()).toBeLessThan(150000);
		await vi.advanceTimersByTimeAsync(70);
		expect(samples()).toBe(262144);
		await device.stopRx();
	});

	it('reconnects the IQ stream after it drops mid-reception', async () => {
		const { tezuka, device } = await connected({ state: { 'state/system/iqtape': 'on' } });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await receiving(device, tezuka);
		const first = tezuka.rxClient;
		first.drop();
		await vi.waitFor(() => expect(tezuka.rxClient && tezuka.rxClient !== first).toBe(true), { timeout: 3000 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconnecting'));
		await device.stopRx();
	});
});
