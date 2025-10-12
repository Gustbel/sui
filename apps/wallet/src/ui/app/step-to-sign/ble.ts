export async function connectAndGetData(getFrame: Uint8Array): Promise<{
	dataRaw: Uint8Array;
	sw: number | null;
}> {
	return new Promise(async (resolve, reject) => {
		try {
			// estado por tag (simple y local a la función)
			const state: Record<number, { need: number | null; buf: Uint8Array[]; next: number }> = {};

			const device = await navigator.bluetooth.requestDevice({
				filters: [{ namePrefix: 'Step-to-Sign' }],
				optionalServices: ['13d63400-2c97-0004-0000-4c6564676572'],
			});

			const server = await device.gatt!.connect();
			const service = await server.getPrimaryService('13d63400-2c97-0004-0000-4c6564676572');

			const writeChar = await service.getCharacteristic('13d63400-2c97-0004-0002-4c6564676572');
			const notifyChar = await service.getCharacteristic('13d63400-2c97-0004-0001-4c6564676572');

			const onNotify = (ev: Event) => {
				const v = (ev.target as BluetoothRemoteGATTCharacteristic).value!;
				const d = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
				if (d.length < 4) return;

				const tag = d[0];
				const seq = d[1];
				const total = (d[2] << 8) | d[3];
				const chunk = d.subarray(4);

				let st = state[tag];
				if (!st || seq === 0) {
					st = { need: total, buf: [], next: 0 };
					state[tag] = st;
				}

				if (seq !== st.next) {
					st.buf = [];
					st.next = seq;
				}

				st.buf.push(chunk);
				st.next++;

				const combinedLen = st.buf.reduce((a, x) => a + x.length, 0);

				if (st.need != null && combinedLen >= st.need) {
					const full = new Uint8Array(combinedLen);
					let offset = 0;
					for (const ch of st.buf) {
						full.set(ch, offset);
						offset += ch.length;
					}

					let data = full;
					let sw: number | null = null;
					if (full.length >= 2) {
						sw = (full[full.length - 2] << 8) | full[full.length - 1];
						data = full.subarray(0, full.length - 2);
					}

					if (sw !== null) console.log('SW:', '0x' + sw.toString(16).padStart(4, '0'));

					st.buf = [];
					st.need = null;
					st.next = 0;

					// limpiar y resolver
					notifyChar.removeEventListener('characteristicvaluechanged', onNotify);
					// (opcional) notifyChar.stopNotifications().catch(()=>{});
					// (opcional) server.disconnect();

					resolve({
						dataRaw: data,
						sw: sw,
					});
				}
			};

			await notifyChar.startNotifications();
			notifyChar.addEventListener('characteristicvaluechanged', onNotify);

			await writeChar.writeValue(getFrame);
		} catch (err) {
			reject(err);
		}
	});
}
