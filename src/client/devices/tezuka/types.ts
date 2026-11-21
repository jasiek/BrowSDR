export type WebSocketFactory = (url: string, protocols: string | string[]) => WebSocket;

export interface TezukaEndpoints {
	host: string;
	secure: boolean;
	control: string;
	iq: string;
	/** Page that lets the user accept the device certificate before wss:// connections succeed. */
	certificate: string;
}

export interface QueuedFrame {
	bytes: Uint8Array;
	offset: number;
}

export interface TezukaIqStreamOptions {
	openSocket: WebSocketFactory;
	url: string;
	sampleRate: number;
	iqBits: 8 | 12 | 16;
	onData: (data: ArrayBufferView) => void;
	/** Explains a failure to reach the proxy, e.g. an untrusted certificate. */
	unreachableHint: string;
}

export interface TezukaDeviceOptions {
	openSocket?: WebSocketFactory;
	/** Use the TLS ports; defaults to whether this page was served over https://. */
	secure?: boolean;
}
