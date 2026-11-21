export type PairedDevices = Array<{ device: USBDevice; driverName: string; productName: string }>;

export type PairedSdr = { device: USBDevice; driverName: string; productName: string; deviceNumber: number };

/** A receiver reached over the local network rather than WebUSB. */
export type NetworkSdr = { kind: 'tezuka'; host: string };

export type ReceiverSource = USBDevice | 'mock' | NetworkSdr;

export function isNetworkSdr(source: ReceiverSource): source is NetworkSdr {
	return typeof source === 'object' && 'kind' in source && source.kind === 'tezuka';
}
