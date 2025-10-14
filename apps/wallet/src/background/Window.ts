// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { filter, fromEventPattern, share, take, takeWhile } from 'rxjs';
import Browser from 'webextension-polyfill';

const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 680;

const tabRemovedStream = fromEventPattern<number>(
	(handler) => Browser.tabs.onRemoved.addListener(handler),
	(handler) => Browser.tabs.onRemoved.removeListener(handler),
).pipe(share());

// This is arbitrary across different operating systems, and unfortunately
// there isn't a great way to tell how much extra height we need to tack on
const windowHeightWithFrame = POPUP_HEIGHT + 28;

export class Window {
	private _id: number | null = null;
	private _url: string;

	constructor(url: string) {
		this._url = url;
	}

	public async show() {
		const w = await Browser.tabs.create({
			url: this._url,
			active: true,
		});
		this._id = typeof w.id === 'undefined' ? null : w.id;
		return tabRemovedStream.pipe(
			takeWhile(() => this._id !== null),
			filter((aTabID) => aTabID === this._id),
			take(1),
		);
	}

	public async close() {
		if (this._id !== null) {
			await Browser.tabs.remove(this._id);
		}
	}

	/**
	 * The id of the window.
	 * {@link Window.show} has to be called first. Otherwise this will be null
	 * */
	public get id(): number | null {
		return this._id;
	}
}
