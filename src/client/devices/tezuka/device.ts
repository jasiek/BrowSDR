import { errorMessage } from '@/platform/errors';
import { iqPrecisionControl, selectedIqBits } from '@/radio/iq/format';
import type { GainControl, SdrDevice, SdrDeviceInfo } from '@/radio/types';
import { parseIioRange } from '@/devices/plutosdr/device';
import { pageIsSecure, tezukaEndpoints } from './endpoints';
import { TezukaIqStream } from './iq-stream';
import { MqttWsClient } from './mqtt';
import type { TezukaDeviceOptions, TezukaEndpoints, WebSocketFactory } from './types';

/*
PlutoSDR-class boards running Tezuka firmware (https://github.com/F5OEO/tezuka_fw),
reached over the network instead of USB. Control goes through the firmware's MQTT
API: `cmd/<path>` writes an AD9361 attribute and the device answers on retained
`state/<path>` topics, with Hz and dB as plain decimal text and `state/caps/<path>`
holding IIO `[min step max]` ranges. Raw IQ comes from iio_ws_proxy, which the
`system/iqtape` command starts and stops.
*/

const GAIN_MODES = ['manual', 'slow_attack', 'fast_attack', 'hybrid'];
const RF_BANDWIDTH_RANGE: [number, number] = [200e3, 56e6];
const DEFAULT_LO_RANGE: [number, number] = [70e6, 6e9];
/** macOS waits 5 s for an mDNS IPv6 answer that Tezuka never sends before using its IPv4 address. */
const CONNECT_TIMEOUT_MS = 10000;
const STATE_TIMEOUT_MS = 2500;
const PROXY_START_TIMEOUT_MS = 3000;

function clamp(value: number, [min, max]: [number, number]): number {
	return Math.min(max, Math.max(min, value));
}

function formatMhz(hz: number): string {
	return String(+(hz / 1e6).toFixed(3));
}

/** AD936x synthesizers and rate dividers land a few Hz from the request. */
function near(target: number, tolerance: number) {
	return (value: string) => Math.abs(parseFloat(value) - target) <= tolerance;
}

export class TezukaDevice implements SdrDevice {
	readonly deviceType = 'tezuka';
	readonly nativeIqBits = 12;
	/** The proxy sends 4 bytes per sample: 100 Mbit/s Ethernet carries about 2.9 MSPS. */
	sampleRates = [2400000, 3000000, 4000000, 5000000, 6000000, 8000000, 10000000];
	readonly gainControls: GainControl[] = [
		iqPrecisionControl(12),
		{ name: 'Gain Mode', min: 0, max: 3, step: 1, default: 0, labels: ['Manual', 'Slow AGC', 'Fast AGC', 'Hybrid AGC'], type: 'select' },
		{ name: 'RF', min: 0, max: 73, step: 1, default: 40, type: 'slider' },
	];
	/** Transport in use; the first candidate that connects. */
	endpoints: TezukaEndpoints;
	private candidates: TezukaEndpoints[];
	private readonly openSocket: WebSocketFactory;
	private readonly mqtt: MqttWsClient;
	private loRange = DEFAULT_LO_RANGE;
	private gainRange: [number, number] = [0, 73];
	private bandwidthRange = RF_BANDWIDTH_RANGE;
	private iqBits: 8 | 12 | 16 = 12;
	/** Null until a Gain Mode is set: the firmware's own mode stays in effect until then. */
	private gainMode: number | null = null;
	private gain = 40;
	private sampleRate = this.sampleRates[0];
	private stream: TezukaIqStream | null = null;
	private callback: ((data: ArrayBufferView) => void) | null = null;
	/** Whether this receiver started iio_ws_proxy, and so should stop it again. */
	private startedProxy = false;
	private operations: Promise<unknown> = Promise.resolve();

	constructor(
		readonly host: string,
		options: TezukaDeviceOptions = {},
	) {
		this.openSocket = options.openSocket ?? ((url, protocols) => new WebSocket(url, protocols));
		// An https:// page may only use wss://, unless the browser exempts local network
		// hosts from mixed-content blocking. Blocked ws:// fails at once, so try it first:
		// it avoids the certificate step and TLS, which the Zynq CPU caps near 1.8 MSPS.
		const secure = options.secure ?? pageIsSecure();
		this.candidates =
			options.secure === undefined && secure ? [false, true].map((tls) => tezukaEndpoints(host, tls)) : [tezukaEndpoints(host, secure)];
		this.endpoints = this.candidates.at(-1)!;
		this.mqtt = new MqttWsClient(this.openSocket);
	}

	get sampleFormat() {
		return this.iqBits === 8 ? ('int8' as const) : ('int16' as const);
	}

	get frequencyRange(): [number, number] {
		return this.loRange;
	}

	private get unreachableHint(): string {
		const { secure, certificate, host } = this.endpoints;
		return secure
			? `Open ${certificate} in this browser once and accept its certificate, then connect again. Allow local network access if the browser asks.`
			: `Check that ${host} is on this network and runs Tezuka firmware.`;
	}

	/** Device commands span several messages and waits; run them one at a time. */
	private serialized<T>(task: () => Promise<T>): Promise<T> {
		const run = this.operations.then(task);
		this.operations = run.catch(() => {});
		return run;
	}

	async open(): Promise<void> {
		await this.connectControl();
		const caps = await this.mqtt.waitFor('state/caps/rx/frequency', () => true, STATE_TIMEOUT_MS);
		if (caps === null) {
			this.mqtt.close();
			throw new Error(`${this.host} answered MQTT but reported no receiver state. Update it to a current Tezuka firmware.`);
		}
		this.loRange = parseIioRange(caps) ?? DEFAULT_LO_RANGE;
		const value = (topic: string) => this.mqtt.values.get(topic) ?? '';
		const gain = parseIioRange(value('state/caps/rx/gain'));
		if (gain) {
			this.gainRange = gain;
			const rf = this.gainControls.find((control) => control.name === 'RF')!;
			Object.assign(rf, { min: gain[0], max: gain[1], default: clamp(rf.default, gain) });
		}
		this.bandwidthRange = parseIioRange(value('state/caps/rx/bandwidth')) ?? RF_BANDWIDTH_RANGE;
		const rates = parseIioRange(value('state/caps/rx/sampling'));
		if (rates) this.sampleRates = this.sampleRates.filter((rate) => rate >= rates[0] && rate <= rates[1]);
		// Tezuka's spectrum sweep hops the LO through fast-lock profiles and resets the sample rate.
		if (value('state/rx/sweep/activate') === '1') this.mqtt.publish('cmd/rx/sweep/activate', 0);
	}

	private async connectControl(): Promise<void> {
		let failure: unknown;
		for (const endpoints of this.candidates) {
			try {
				await this.mqtt.connect(endpoints.control, `browsdr_${Math.random().toString(16).slice(2, 10)}`, CONNECT_TIMEOUT_MS);
				await this.mqtt.subscribe(['state/rx/#', 'state/caps/rx/#', 'state/main/#', 'state/system/iqtape']);
				this.endpoints = endpoints;
				this.candidates = [endpoints];
				return;
			} catch (error) {
				this.mqtt.close();
				failure = error;
			}
		}
		const { control } = this.endpoints;
		throw new Error(`Could not reach Tezuka's control broker at ${control} (${errorMessage(failure)}). ${this.unreachableHint}`, {
			cause: failure,
		});
	}

	/** Publish a command, reconnecting first if the broker connection dropped. */
	private async command(path: string, value: string | number): Promise<void> {
		if (!this.mqtt.connected) await this.connectControl();
		this.mqtt.publish(`cmd/${path}`, value);
	}

	/** Wait for the device's `state/` answer; a slow answer is logged, not fatal. */
	private async confirm(path: string, accept: (value: string) => boolean): Promise<void> {
		const answer = await this.mqtt.waitFor(`state/${path}`, accept, STATE_TIMEOUT_MS);
		if (answer === null) console.warn(`Tezuka: ${path} was not confirmed within ${STATE_TIMEOUT_MS} ms`);
	}

	close(): Promise<void> {
		return this.serialized(() => {
			this.stopStream();
			if (this.startedProxy && this.mqtt.connected) this.mqtt.publish('cmd/system/iqtape', 'off');
			this.startedProxy = false;
			this.mqtt.close();
			return Promise.resolve();
		});
	}

	getInfo(): Promise<SdrDeviceInfo> {
		const value = (topic: string) => this.mqtt.values.get(`state/main/${topic}`) || undefined;
		const model = value('hw_model');
		const board = model?.replace(/\s*\(.*$/, '');
		return Promise.resolve({
			name: `${board && !/plutosdr/i.test(board) ? board : 'PlutoSDR'} (Tezuka)`,
			hardware: model,
			firmware: value('fw_version'),
			serial: value('serial'),
			tuner: /\b(AD936\d\w*)\b/i.exec(model ?? '')?.[1]?.toUpperCase(),
			protocol: `Tezuka MQTT and IQ WebSocket${value('iio') ? `, libiio ${value('iio')}` : ''}`,
			product: this.host,
		});
	}

	setSampleRate(rate: number): Promise<void> {
		return this.serialized(async () => {
			const hz = Math.round(rate);
			await this.command('rx/sampling', hz);
			await this.command('rx/bandwidth', Math.round(clamp(hz, this.bandwidthRange)));
			await this.confirm('rx/sampling', near(hz, 10));
			this.sampleRate = hz;
			// The pacing clock follows the rate, so a running stream restarts with it.
			if (this.stream && this.callback) await this.restartStream(this.callback);
		});
	}

	setFrequency(freqHz: number): Promise<void> {
		return this.serialized(async () => {
			const hz = Math.round(freqHz);
			const [min, max] = this.loRange;
			if (hz < min || hz > max)
				throw new Error(`Tezuka tunes ${formatMhz(min)}-${formatMhz(max)} MHz; ${formatMhz(hz)} MHz is out of range`);
			await this.command('rx/frequency', hz);
			await this.confirm('rx/frequency', near(hz, 10));
			// The AD936x clamps manual gain to the new band's gain table; reapply the requested gain.
			if (this.gainMode === 0) await this.applyManualGain();
		});
	}

	setGain(name: string, value: number): Promise<void> {
		return this.serialized(() => this.applyGain(name, value));
	}

	setGains(gains: Record<string, number>): Promise<void> {
		return this.serialized(async () => {
			if (gains['IQ Precision'] !== undefined) this.setIqPrecision(gains['IQ Precision']);
			if (gains.RF !== undefined) this.gain = gains.RF;
			if (gains['Gain Mode'] !== undefined) await this.applyGain('Gain Mode', gains['Gain Mode']);
			else if (this.gainMode === 0) await this.applyManualGain();
		});
	}

	private async applyGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'IQ Precision':
				this.setIqPrecision(value);
				break;
			case 'Gain Mode': {
				const mode = Math.round(clamp(value, [0, GAIN_MODES.length - 1]));
				await this.command('rx/gain_mode', GAIN_MODES[mode]);
				this.gainMode = mode;
				if (mode === 0) await this.applyManualGain();
				break;
			}
			case 'RF':
				this.gain = value;
				if (this.gainMode === 0) await this.applyManualGain();
				break;
			default:
				console.warn(`Tezuka: unknown gain "${name}"`);
		}
	}

	/** Host-side only: the proxy always sends 16-bit words. */
	private setIqPrecision(selection: number): void {
		const bits = selectedIqBits(12, selection);
		if (this.stream && bits !== this.iqBits) throw new Error('Stop reception before changing IQ precision');
		this.iqBits = bits;
	}

	private applyManualGain(): Promise<void> {
		return this.command('rx/gain', Math.round(clamp(this.gain, this.gainRange)));
	}

	startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		return this.serialized(() => this.restartStream(callback));
	}

	stopRx(): Promise<void> {
		return this.serialized(() => {
			this.stopStream();
			return Promise.resolve();
		});
	}

	private async restartStream(callback: (data: ArrayBufferView) => void): Promise<void> {
		this.stopStream();
		await this.ensureProxy();
		const stream = new TezukaIqStream({
			openSocket: this.openSocket,
			url: this.endpoints.iq,
			sampleRate: this.sampleRate,
			iqBits: this.iqBits,
			onData: callback,
			unreachableHint: this.unreachableHint,
		});
		this.stream = stream;
		this.callback = callback;
		try {
			await stream.start();
		} catch (error) {
			if (this.stream === stream) this.stopStream();
			throw error;
		}
	}

	/**
	 * `system/iqtape on` restarts iio_ws_proxy even when it is running, which would drop
	 * whoever is connected, so it is sent only while the proxy is reported off.
	 */
	private async ensureProxy(): Promise<void> {
		if (this.mqtt.values.get('state/system/iqtape') === 'on') return;
		await this.command('system/iqtape', 'on');
		this.startedProxy = true;
		await this.mqtt.waitFor('state/system/iqtape', (value) => value === 'on', PROXY_START_TIMEOUT_MS);
	}

	private stopStream(): void {
		this.stream?.stop();
		this.stream = null;
		this.callback = null;
	}
}
