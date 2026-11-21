import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('Add SDR without available paired hardware', () => {
	const sdr = { vendorId: 0x04b4, productId: 0x00f1, productName: 'LimeSDR' };
	it.each([{ paired: [] }, { paired: [{ vendorId: 1, productId: 2 }] }])(
		'opens the native USB picker directly in production for %o',
		async ({ paired }) => {
			vi.stubEnv('DEV', false);
			vi.stubGlobal('isSecureContext', true);
			const requestDevice = vi.fn().mockResolvedValue(sdr),
				connectDevice = vi.fn();
			vi.stubGlobal('navigator', {
				usb: { getDevices: vi.fn().mockResolvedValue(paired), requestDevice },
				userActivation: { isActive: true },
			});
			const wrapper = mount(ReceiverView);
			await wrapper.setData({ backend: {}, workspace: { isDeviceConnected: () => false, connectDevice } });
			vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
			await wrapper.vm.connect();
			expect(requestDevice).toHaveBeenCalledWith({ filters: expect.any(Array) });
			expect(connectDevice).toHaveBeenCalledWith(wrapper.vm, sdr);
			expect(wrapper.vm.devicePicker.show).toBe(false);
			wrapper.unmount();
		},
	);
	it.each([true, false])('shows the paired-device picker with active gesture %s when an SDR is available', async (active) => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn();
		vi.stubGlobal('navigator', {
			usb: { getDevices: vi.fn().mockResolvedValue([sdr]), requestDevice },
			userActivation: { isActive: active },
		});
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		expect(wrapper.vm.devicePicker.devices).toHaveLength(1);
		expect(wrapper.vm.devicePicker.show).toBe(true);
		wrapper.unmount();
	});
	it('keeps development test receivers reachable without a USB prompt', async () => {
		vi.stubEnv('DEV', true);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn();
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([]), requestDevice } });
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		expect(wrapper.get('[role=dialog]').text()).toContain('Mock SDR');
		expect(wrapper.get('[role=dialog]').text()).toContain('IQ File Replay');
		wrapper.unmount();
	});
	it('falls back to the explicit pairing button if the user gesture has expired', async () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { name: 'NotFoundError' }));
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([]), requestDevice }, userActivation: { isActive: false } });
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		const showMsg = vi.spyOn(wrapper.vm, 'showMsg').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Pair New Device')!
			.trigger('click');
		expect(requestDevice).toHaveBeenCalledOnce();
		expect(showMsg).not.toHaveBeenCalled();
		wrapper.unmount();
	});
});

describe('Add SDR with a Tezuka receiver on the network', () => {
	const tezukaHostKey = 'BrowSDR:tezukaHost';
	let stored: Map<string, string>;
	beforeEach(() => {
		stored = new Map();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value),
			removeItem: (key: string) => stored.delete(key),
		});
	});

	it('reopens the picker, which offers network receivers, when the automatic USB prompt is cancelled', async () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { name: 'NotFoundError' }));
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([]), requestDevice }, userActivation: { isActive: true } });
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).toHaveBeenCalledOnce();
		expect(wrapper.vm.devicePicker.show).toBe(true);
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[role=dialog]').text()).toContain('Tezuka PlutoSDR on the network');
		expect((wrapper.get('[role=dialog] input').element as HTMLInputElement).value).toBe('pluto.local');
		wrapper.unmount();
	});

	it('shows the picker instead of the USB prompt once a Tezuka host was used, and connects to it', async () => {
		localStorage.setItem(tezukaHostKey, '192.168.2.1');
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn(),
			connectDevice = vi.fn();
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([]), requestDevice }, userActivation: { isActive: true } });
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {}, workspace: { isDeviceConnected: () => false, connectDevice } });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		expect(wrapper.vm.devicePicker.tezukaHost).toBe('192.168.2.1');
		await wrapper.vm.$nextTick();
		await wrapper.get('[role=dialog] input').setValue('https://Pluto.local/');
		await wrapper.get('[role=dialog] form').trigger('submit');
		expect(connectDevice).toHaveBeenCalledWith(wrapper.vm, { kind: 'tezuka', host: 'pluto.local' });
		expect(localStorage.getItem(tezukaHostKey)).toBe('pluto.local');
		wrapper.unmount();
	});

	it('offers the network receiver when this browser has no WebUSB', async () => {
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {});
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		await wrapper.vm.connect();
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[role=dialog]').text()).toContain('WebUSB is unavailable');
		expect(wrapper.get('[role=dialog]').text()).toContain('Tezuka PlutoSDR on the network');
		wrapper.unmount();
	});
});
