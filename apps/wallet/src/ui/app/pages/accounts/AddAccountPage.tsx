// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from '_app/shared/ButtonUI';
import { Text } from '_app/shared/text';
import Overlay from '_components/overlay';
import {
	zkLoginProviderDataMap,
	type ZkLoginProvider,
} from '_src/background/accounts/zklogin/providers';
import { ampli } from '_src/shared/analytics/ampli';
import { CreateStepToSignAccount } from '_src/step-to-sign/CreateStsAccount';
import { LedgerLogo17 as LedgerLogo } from '@mysten/icons';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Browser from 'webextension-polyfill';

import { useAccountsFormContext } from '../../components/accounts/AccountsFormContext';
import { ZkLoginButtons } from '../../components/accounts/ZkLoginButtons';
import { ConnectLedgerModal } from '../../components/ledger/ConnectLedgerModal';
import { getLedgerConnectionErrorMessage } from '../../helpers/errorMessages';
import { useAppSelector } from '../../hooks';
import { useCountAccountsByType } from '../../hooks/useCountAccountByType';
import { useCreateAccountsMutation } from '../../hooks/useCreateAccountMutation';
import { AppType } from '../../redux/slices/app/AppType';
import { connectSts, getDataSts } from '../../step-to-sign/ble';

async function openTabWithSearchParam(searchParam: string, searchParamValue: string) {
	const currentURL = new URL(window.location.href);
	const [currentHash, currentHashSearch] = currentURL.hash.split('?');
	const urlSearchParams = new URLSearchParams(currentHashSearch);
	urlSearchParams.set(searchParam, searchParamValue);
	currentURL.hash = `${currentHash}?${urlSearchParams.toString()}`;
	currentURL.searchParams.delete('type');
	await Browser.tabs.create({
		url: currentURL.href,
	});
}

export function AddAccountPage() {
	// Step-to-Sign account creation state
	const state: Record<number, { need: number | null; buf: Uint8Array[]; next: number }> = {};
	const [searchParams, setSearchParams] = useSearchParams();

	const navigate = useNavigate();
	const sourceFlow = searchParams.get('sourceFlow') || 'Unknown';
	const showSocialSignInOptions = sourceFlow !== 'Onboarding';
	const forceShowLedger =
		searchParams.has('showLedger') && searchParams.get('showLedger') !== 'false';
	const [, setAccountsFormValues] = useAccountsFormContext();
	const isPopup = useAppSelector((state) => state.app.appType === AppType.popup);
	const [isConnectLedgerModalOpen, setConnectLedgerModalOpen] = useState(forceShowLedger);
	const createAccountsMutation = useCreateAccountsMutation();
	const createZkLoginAccount = useCallback(
		async (provider: ZkLoginProvider) => {
			await setAccountsFormValues({ type: 'zkLogin', provider });
			await createAccountsMutation.mutateAsync(
				{
					type: 'zkLogin',
				},
				{
					onSuccess: () => {
						navigate('/tokens');
					},
					onError: (error) => {
						toast.error((error as Error)?.message || 'Failed to create account. (Unknown error)');
					},
				},
			);
		},
		[setAccountsFormValues, createAccountsMutation, navigate],
	);
	const [forcedZkLoginProvider, setForcedZkLoginProvider] = useState<ZkLoginProvider | null>(null);
	const forceZkLoginWithProviderRef = useRef(searchParams.get('forceZkLoginProvider'));
	const forcedLoginHandledRef = useRef(false);
	const { data: accountsTotalByType, isPending: isAccountsCountLoading } = useCountAccountsByType();
	useEffect(() => {
		if (isAccountsCountLoading) {
			return;
		}
		const zkLoginProvider = forceZkLoginWithProviderRef.current as ZkLoginProvider;
		if (
			zkLoginProvider &&
			zkLoginProviderDataMap[zkLoginProvider] &&
			!forcedLoginHandledRef.current
		) {
			const totalProviderAccounts = accountsTotalByType?.zkLogin?.extra?.[zkLoginProvider] || 0;
			if (totalProviderAccounts === 0) {
				setForcedZkLoginProvider(zkLoginProvider);
				createZkLoginAccount(zkLoginProvider).finally(() => setForcedZkLoginProvider(null));
			}
			const newURLSearchParams = new URLSearchParams(searchParams.toString());
			newURLSearchParams.delete('forceZkLoginProvider');
			setSearchParams(newURLSearchParams.toString());
			forcedLoginHandledRef.current = true;
		}
	}, [
		setSearchParams,
		accountsTotalByType,
		searchParams,
		createZkLoginAccount,
		isAccountsCountLoading,
	]);
	return (
		<Overlay showModal title="Add Account" closeOverlay={() => navigate('/')}>
			<div className="w-full flex flex-col gap-8">
				<div className="flex flex-col gap-3">
					{showSocialSignInOptions && (
						<ZkLoginButtons
							layout="column"
							showLabel
							sourceFlow={sourceFlow}
							forcedZkLoginProvider={forcedZkLoginProvider}
							onButtonClick={async (provider) => {
								if (isPopup) {
									await openTabWithSearchParam('forceZkLoginProvider', provider);
									window.close();
									return;
								} else {
									return createZkLoginAccount(provider);
								}
							}}
						/>
					)}
					<Button
						variant="outline"
						size="tall"
						text="Set up Ledger"
						before={<LedgerLogo className="text-gray-90 w-4 h-4" />}
						onClick={async () => {
							ampli.openedConnectStepToSignFlow({ sourceFlow });
							if (isPopup) {
								await openTabWithSearchParam('showLedger', 'true');
								window.close();
							} else {
								setConnectLedgerModalOpen(true);
							}
						}}
						disabled={createAccountsMutation.isPending}
					/>
					<Button
						variant="outline"
						size="tall"
						text="Set up Step-to-Sign"
						before={<LedgerLogo className="text-gray-90 w-4 h-4" />}
						onClick={async () => {
							await connectSts();

							const apduPubKey = new Uint8Array([0xe0, 0x04, 0x00, 0x00, 0x00]);

							const res = await getDataSts(apduPubKey);

							console.log('Public Key Raw:', res.dataRaw);
							// Accondicionamos data
							// extraemos publicKey y obtenemos address
							const publicKey_raw = res.dataRaw;

							const pubKey = new Ed25519PublicKey(publicKey_raw);
							const sts_pubKey_base64 = Buffer.from(pubKey.toBase64()).toString();
							const sts_address = pubKey.toSuiAddress();

							console.log(`Public Key (base64): ${sts_pubKey_base64.toString()}`);
							console.log(`Address: ${sts_address}`);

							// Con los datos creamos la cuenta
							const hardcodedAccount = {
								address: sts_address,
								derivationPath: "m/44'/784'/0'/0'/0'",
								publicKey: sts_pubKey_base64,
							};
							setAccountsFormValues({
								type: 'ledger',
								accounts: [hardcodedAccount],
							});
							navigate(
								`/accounts/protect-account?${new URLSearchParams({
									accountType: 'ledger',
								}).toString()}`,
							);
						}}
						disabled={createAccountsMutation.isPending}
					/>
				</div>
				<Section title="Create New">
					<Button
						variant="outline"
						size="tall"
						text="Create a new Passphrase Account"
						to="/accounts/protect-account?accountType=new-mnemonic"
						onClick={() => {
							setAccountsFormValues({ type: 'new-mnemonic' });
							ampli.clickedCreateNewAccount({ sourceFlow });
						}}
						disabled={createAccountsMutation.isPending}
					/>
				</Section>
				<Section title="Import Existing Accounts">
					<Button
						variant="outline"
						size="tall"
						text="Import Passphrase"
						to="/accounts/import-passphrase"
						onClick={() => {
							ampli.clickedImportPassphrase({ sourceFlow });
						}}
						disabled={createAccountsMutation.isPending}
					/>
					<Button
						variant="outline"
						size="tall"
						text="Import Private Key"
						to="/accounts/import-private-key"
						onClick={() => {
							ampli.clickedImportPrivateKey({ sourceFlow });
						}}
						disabled={createAccountsMutation.isPending}
					/>
				</Section>
			</div>
			{isConnectLedgerModalOpen && (
				<ConnectLedgerModal
					onClose={() => {
						setConnectLedgerModalOpen(false);
					}}
					onError={(error) => {
						setConnectLedgerModalOpen(false);
						toast.error(getLedgerConnectionErrorMessage(error) || 'Something went wrong.');
					}}
					onConfirm={() => {
						ampli.connectedHardwareWallet({ hardwareWalletType: 'Ledger' });
						navigate('/accounts/import-ledger-accounts');
					}}
				/>
			)}
		</Overlay>
	);
}

type SectionProps = {
	title: string;
	children: ReactNode;
};

function Section({ title, children }: SectionProps) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<div className="grow border-0 border-t border-solid border-gray-40"></div>
				<Text variant="caption" weight="semibold" color="steel">
					{title}
				</Text>
				<div className="grow border-0 border-t border-solid border-gray-40"></div>
			</div>
			{children}
		</section>
	);
}

function tryExtractDataFromNotify(d: Uint8Array): Uint8Array | null {
	if (d.length < 4) return null;

	// Frame: [tag, seq, lenHi, lenLo, ...payload]
	const total = (d[2] << 8) | d[3];
	if (4 + total > d.length) return null;
	let full = d.subarray(4, 4 + total);

	// Quitar SW (0x9000 / 0x6xxx)
	if (full.length >= 2) {
		const sw = (full[full.length - 2] << 8) | full[full.length - 1];
		if (sw === 0x9000 || (sw & 0xf000) === 0x6000) {
			full = full.subarray(0, full.length - 2);
		}
	}

	// Layout Ledger-like: [nameLen][name][stringLen][string][flagsLen?][flags?]
	let i = 0;
	if (i >= full.length) return null;
	const nameLen = full[i++];
	if (i + nameLen > full.length) return null;
	i += nameLen; // skip name

	if (i >= full.length) return null;
	const dataLen = full[i++];
	if (dataLen <= 0 || i + dataLen > full.length) return null;
	const dataBytes = full.subarray(i, i + dataLen);

	return dataBytes || null;
}
