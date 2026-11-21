import { errorMessage } from '@/platform/errors';
import { usbSettingsKey } from '@/radio/usb-device-selection';
import { isNetworkSdr, type ReceiverSource } from '@/app/radio/types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { ReceiverEntry, WorkspaceClaims, WorkspaceInstance } from './types';

/** The workspace claim for a source, or null for the mock receiver, which any receiver may use. */
function claimKey(device: ReceiverSource): USBDevice | string | null {
	if (device === 'mock') return null;
	return isNetworkSdr(device) ? `tezuka:${device.host}` : device;
}

export async function connectDevice(this: WorkspaceInstance, runtime: WorkspaceClaims, source: AppInstance, device: ReceiverSource) {
	if (this.mode === 'client') return;
	if ([source._connectingDevice, source._removing].some(Boolean)) return;
	const claim = claimKey(device);
	if (claim !== null && runtime.claims.has(claim)) {
		source.showMsg('This SDR is already connected.');
		return;
	}
	const release = () => claim !== null && runtime.claims.delete(claim);
	source._connectingDevice = true;
	if (claim !== null) runtime.claims.set(claim, source.receiverId);
	const app = source.connected ? await this.newReceiver() : source;
	if (!app) {
		release();
		source._connectingDevice = false;
		return;
	}
	app._connectingDevice = true;
	const entry = this.receivers.find((item: ReceiverEntry) => item.id === app.receiverId);
	if (!entry) return;
	if (claim !== null) runtime.claims.set(claim, app.receiverId); // Reserve before any USB awaits.
	const settings = { useLegacy: false };
	try {
		await openSource.call(this, runtime, app, entry, device, settings);
		if (!app.connected) {
			if (settings.useLegacy) runtime.legacyMigrationClaimed = false;
			release();
			return;
		}
		app._initAudioCtx();
		if (this.mode === 'host') await this.attachHostReceiver(app);
		await this.$nextTick();
		this.broadcastReceivers();
	} catch (error) {
		if (settings.useLegacy && !app.connected) runtime.legacyMigrationClaimed = false;
		release();
		this.error = errorMessage(error);
	} finally {
		source._connectingDevice = false;
		app._connectingDevice = false;
	}
}

/** Load the source's saved settings into `app`, then open it. Records whether legacy settings were claimed. */
async function openSource(
	this: WorkspaceInstance,
	runtime: WorkspaceClaims,
	app: AppInstance,
	entry: ReceiverEntry,
	device: ReceiverSource,
	settings: { useLegacy: boolean },
): Promise<void> {
	if (device === 'mock') return app._connectMock();
	if (isNetworkSdr(device)) {
		settings.useLegacy = await prepareReceiverSettings.call(
			this,
			`SDRSetting:tezuka:${device.host}`,
			`Tezuka · ${device.host}`,
			entry,
			runtime,
			app,
		);
		return app._connectToTezuka(device.host);
	}
	const paired = await navigator.usb.getDevices();
	const index = paired.indexOf(device);
	if (index < 0) throw new Error('SDR is no longer connected');
	const label = `SDR ${index + 1} · ${device.productName || 'USB SDR'}`;
	settings.useLegacy = await prepareReceiverSettings.call(this, usbSettingsKey(device, paired), label, entry, runtime, app);
	return app._connectToDevice(device, index);
}

async function prepareReceiverSettings(
	this: WorkspaceInstance,
	settingsKey: string,
	label: string,
	entry: ReceiverEntry,
	runtime: WorkspaceClaims,
	app: AppInstance,
) {
	const startupSettings = entry.settingsKey === 'SDRSetting';
	entry.settingsKey = settingsKey;
	entry.deviceLabel = label;
	entry.label = entry.deviceLabel;
	await this.$nextTick();
	const useLegacy = !runtime.legacyMigrationClaimed;
	runtime.legacyMigrationClaimed = true;
	// The first local receiver already displays the user's startup configuration.
	// Transfer that configuration to its device key rather than replacing it with
	// an older device save. Additional receivers still restore their own settings.
	if (useLegacy && startupSettings) app.saveSetting();
	else app.loadSetting(useLegacy);
	return useLegacy;
}
