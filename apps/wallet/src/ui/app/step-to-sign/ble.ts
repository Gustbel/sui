// ---- cache simple a nivel de módulo ----
let bleDevice: BluetoothDevice | null = null;
let bleServer: BluetoothRemoteGATTServer | null = null;
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;

// Conecta una sola vez y descubre characteristics (sin crear listener)
export async function connectSts() {
	// si ya está todo y sigue conectado, no hacemos nada
	if (writeChar && notifyChar && bleServer?.connected) return;

	if (!bleDevice) {
		bleDevice = await navigator.bluetooth.requestDevice({
			filters: [{ namePrefix: 'Step-to-Sign' }],
			optionalServices: ['13d63400-2c97-0004-0000-4c6564676572'],
		});

		// si se desconecta, limpiamos cache
		bleDevice.addEventListener('gattserverdisconnected', () => {
			bleServer = null;
			writeChar = null;
			notifyChar = null;
		});
	}

	if (!bleServer || !bleServer.connected) {
		bleServer = await bleDevice.gatt!.connect();
	}

	const service = await bleServer.getPrimaryService('13d63400-2c97-0004-0000-4c6564676572');
	writeChar = await service.getCharacteristic('13d63400-2c97-0004-0002-4c6564676572');
	notifyChar = await service.getCharacteristic('13d63400-2c97-0004-0001-4c6564676572');
}

async function writeChunked(
	chr: BluetoothRemoteGATTCharacteristic,
	payload: Uint8Array,
	tag = 0x05,
	maxBytesPerWrite = 180, // seguro para MTU ~185
	interChunkDelayMs = 8,
) {
	const header = 4;
	const total = payload.length;
	const maxChunk = Math.max(1, maxBytesPerWrite - header);

	let seq = 0;
	for (let off = 0; off < total; ) {
		const n = Math.min(maxChunk, total - off);
		const frame = new Uint8Array(header + n);
		frame[0] = tag;
		frame[1] = seq & 0xff;
		if (seq === 0) {
			frame[2] = (total >> 8) & 0xff;
			frame[3] = total & 0xff;
		} else {
			frame[2] = 0;
			frame[3] = 0; // tu ESP32 solo usa len en seq=0
		}
		frame.set(payload.subarray(off, off + n), 4);

		await chr.writeValue(frame);
		off += n;
		seq++;
		if (interChunkDelayMs) await new Promise((r) => setTimeout(r, interChunkDelayMs));
	}
}

// Envia un frame (posiblemente chunked) y espera la respuesta
export async function getDataSts(
	getFrame: Uint8Array,
): Promise<{ dataRaw: Uint8Array; sw: number | null }> {
	await connectSts(); // asegura conexión/handles

	// estado por tag (local a la llamada)
	const state: Record<number, { need: number | null; buf: Uint8Array[]; next: number }> = {};

	return new Promise(async (resolve, reject) => {
		try {
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

					// limpiar estado y listener SOLO para esta llamada
					st.buf = [];
					st.need = null;
					st.next = 0;

					notifyChar!.removeEventListener('characteristicvaluechanged', onNotify);

					resolve({ dataRaw: data, sw });
				}
			};

			// arrancamos notificaciones y listener en cada getData()
			await notifyChar!.startNotifications();
			notifyChar!.addEventListener('characteristicvaluechanged', onNotify);

			// Enviamos mensajes en chunks de 180 bytes (MTU ~185)
			await writeChunked(writeChar!, getFrame, /*tag=*/ 0x05, /*max=*/ 180, /*delay=*/ 8);
		} catch (err) {
			reject(err);
		}
	});
}
