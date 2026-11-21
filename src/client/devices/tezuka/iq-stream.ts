import { receiveTransferSize } from '@/radio/receive-transfer';
import { convertIq } from '@/devices/plutosdr/samples';
import { PlutoThroughput } from '@/devices/plutosdr/throughput';
import type { IioSampleFormat } from '@/devices/plutosdr/types';
import type { QueuedFrame, TezukaIqStreamOptions } from './types';

/*
Receive side of Tezuka's iio_ws_proxy ("iio-rx" subprotocol). Each binary frame is
one IIO buffer refill: 262144 RX1 samples by default, as interleaved little-endian
I/Q words holding sign-extended 12-bit values, with no header or sample counter.
The proxy serves one RX client and drops whole buffers when the network falls behind.
*/

/** cf-ad9361-lpc's scan element format, `le:S12/16>>0`. */
const AD9361_FORMAT: IioSampleFormat = { littleEndian: true, signed: true, bits: 12, storageBits: 16, shift: 0 };
const WIRE_BYTES_PER_SAMPLE = 4;
/** Covers the proxy starting and a slow first `.local` lookup (see CONNECT_TIMEOUT_MS in device.ts). */
const FIRST_FRAME_TIMEOUT_MS = 10000;
const RETRY_MS = 400;
const RECONNECT_MS = 1000;
/** Queued audio beyond this many ms is delivered at once, so clock drift cannot build latency. */
const MAX_BACKLOG_MS = 400;

export class TezukaIqStream {
	private socket?: WebSocket;
	private stopped = false;
	private everOpened = false;
	private receiving = false;
	private queue: QueuedFrame[] = [];
	private queuedBytes = 0;
	private epoch = 0;
	private deliveredSamples = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private readonly chunkBytes: number;
	private readonly throughput: PlutoThroughput;
	private lastFrameAt = 0;

	constructor(private readonly options: TezukaIqStreamOptions) {
		// About 8 ms per delivery, like USB receivers' transfers.
		this.chunkBytes = receiveTransferSize(options.sampleRate, 1 << 20, WIRE_BYTES_PER_SAMPLE, WIRE_BYTES_PER_SAMPLE);
		this.throughput = new PlutoThroughput(
			options.sampleRate,
			(summary, shortfall) => {
				if (shortfall) console.warn(`${summary}. The network dropped IQ buffers; try a lower sample rate or a wired link.`);
				else if (import.meta.env.DEV) console.info(summary);
			},
			undefined,
			{ source: 'Tezuka', link: 'network' },
		);
	}

	/** Resolve once samples flow; retry while the proxy starts listening. */
	async start(): Promise<void> {
		const deadline = performance.now() + FIRST_FRAME_TIMEOUT_MS;
		for (;;) {
			const outcome = await this.connectOnce(deadline);
			if (outcome === 'receiving') return;
			if (this.stopped) throw new Error('Tezuka reception was stopped');
			if (performance.now() + RETRY_MS >= deadline) {
				this.stop();
				throw new Error(
					this.everOpened
						? 'Tezuka IQ stream is busy: it serves one receiver at a time. Stop IQ Tape or the Radio page in the Tezuka dashboard, or close another BrowSDR receiver using it.'
						: `Could not reach Tezuka's IQ stream at ${this.options.url}. ${this.options.unreachableHint}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
		}
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		clearTimeout(this.reconnectTimer);
		this.queue = [];
		this.queuedBytes = 0;
		this.closeSocket();
	}

	/** One connection attempt: 'receiving' after the first frame, 'closed' if it ends before one. */
	private connectOnce(deadline: number): Promise<'receiving' | 'closed'> {
		return new Promise((resolve) => {
			const socket = this.options.openSocket(this.options.url, 'iio-rx');
			socket.binaryType = 'arraybuffer';
			this.socket = socket;
			let settled = false;
			const settle = (outcome: 'receiving' | 'closed') => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(outcome);
			};
			const timer = setTimeout(
				() => {
					this.closeSocket();
					settle('closed');
				},
				Math.max(0, deadline - performance.now()),
			);
			socket.onopen = () => (this.everOpened = true);
			socket.onerror = () => {};
			socket.onclose = () => {
				if (this.socket === socket) this.socket = undefined;
				if (!settled) return settle('closed');
				this.lost();
			};
			socket.onmessage = (event: MessageEvent) => {
				if (!(event.data instanceof ArrayBuffer) || this.stopped) return;
				this.frame(new Uint8Array(event.data));
				settle('receiving');
			};
		});
	}

	/** After samples have flowed, a dropped connection reconnects until stopped. */
	private lost(): void {
		if (this.stopped) return;
		console.warn('Tezuka: IQ stream disconnected; reconnecting');
		this.reconnectTimer = setTimeout(() => {
			if (this.stopped) return;
			void this.connectOnce(performance.now() + FIRST_FRAME_TIMEOUT_MS).then((outcome) => {
				if (outcome === 'closed') this.lost();
			});
		}, RECONNECT_MS);
	}

	private frame(bytes: Uint8Array): void {
		const usable = bytes.subarray(0, bytes.byteLength - (bytes.byteLength % WIRE_BYTES_PER_SAMPLE));
		const now = performance.now();
		this.throughput.block(usable.byteLength / WIRE_BYTES_PER_SAMPLE, this.lastFrameAt ? now - this.lastFrameAt : 0, 0, now);
		this.lastFrameAt = now;
		if (!usable.byteLength) return;
		this.queue.push({ bytes: usable, offset: 0 });
		this.queuedBytes += usable.byteLength;
		if (!this.receiving) {
			this.receiving = true;
			this.epoch = now;
			this.deliveredSamples = 0;
			this.pace();
		}
	}

	/**
	 * Deliver queued samples on the sample clock, so the spectrum and decoders see a steady
	 * stream instead of one burst per network frame. An empty queue stretches the clock;
	 * a backlog beyond MAX_BACKLOG_MS (a throttled tab) is delivered immediately.
	 */
	private pace(): void {
		if (this.stopped) return;
		const rate = this.options.sampleRate / 1000;
		const now = performance.now();
		const backlogMs = this.queuedBytes / WIRE_BYTES_PER_SAMPLE / rate;
		if (backlogMs > MAX_BACKLOG_MS) this.epoch -= backlogMs - MAX_BACKLOG_MS;
		while (this.queue.length && this.deliveredSamples <= (now - this.epoch) * rate) this.deliver();
		const chunkMs = this.chunkBytes / WIRE_BYTES_PER_SAMPLE / rate;
		let delay = chunkMs;
		if (!this.queue.length) this.epoch = Math.max(this.epoch, now - this.deliveredSamples / rate);
		else delay = Math.min(this.epoch + this.deliveredSamples / rate - now, chunkMs);
		this.timer = setTimeout(() => this.pace(), Math.max(1, delay));
	}

	private deliver(): void {
		const head = this.queue[0];
		const end = Math.min(head.bytes.byteLength, head.offset + this.chunkBytes);
		const chunk = head.bytes.subarray(head.offset, end);
		const IqArray = this.options.iqBits === 8 ? Int8Array : Int16Array;
		const iq = new IqArray(chunk.byteLength / 2);
		convertIq(chunk, AD9361_FORMAT, iq, 0);
		head.offset = end;
		this.queuedBytes -= chunk.byteLength;
		if (head.offset === head.bytes.byteLength) this.queue.shift();
		this.deliveredSamples += chunk.byteLength / WIRE_BYTES_PER_SAMPLE;
		this.options.onData(iq);
	}

	private closeSocket(): void {
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
}
