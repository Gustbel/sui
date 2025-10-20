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
import { LedgerLogo17 as LedgerLogo } from '@mysten/icons';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { MultiSigPublicKey } from '@mysten/sui/multisig/publickey';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Browser from 'webextension-polyfill';

import { useAccountsFormContext } from '../../components/accounts/AccountsFormContext';
import { ZkLoginButtons } from '../../components/accounts/ZkLoginButtons';
import { ConnectLedgerModal } from '../../components/ledger/ConnectLedgerModal';
import { SummaryCard } from '../../components/SummaryCard';
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
	const [obtainedNewAddress, setObtainedNewAddress] = useState(false);

	// Addresses
	const [stsAddress, setStsAddress] = useState<string | null>(null);
	const [localAddress, setLocalAddress] = useState<string | null>(null);
	const [localSecretKey, setLocalSecretKey] = useState<string | null>(null);
	const [multisigAddress, setMultisigAddress] = useState<string | null>(null);

	const confirmResolverRef = useRef<null | (() => void)>(null);
	const waitForConfirm = useCallback(() => {
		// Si ya existiera un resolver pendiente, lo reemplazamos (último gana).
		return new Promise<void>((resolve) => {
			confirmResolverRef.current = resolve;
		});
	}, []);
	// ---------------------------------------------------------------

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
		<Overlay showModal title="Add Step-to-Sign Multisig Account" closeOverlay={() => navigate('/')}>
			{!obtainedNewAddress && (
				<>
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
									// Local account address
									const secretKey = 'suiprivkey1...';
									const keypair = Ed25519Keypair.fromSecretKey(secretKey);
									// get publickey of local account (first multisig participant)
									const pubKeyLocal = keypair.getPublicKey();
									setLocalAddress(pubKeyLocal.toSuiAddress());
									setLocalSecretKey(secretKey);

									//Obtaining public key from Step-to-Sign device (second multisig participant)
									await connectSts();

									const apduPubKey = new Uint8Array([0xe0, 0x04, 0x00, 0x00, 0x00]);

									const res = await getDataSts(apduPubKey);

									console.log('Public Key Raw:', res.dataRaw);
									// Accondicionamos data
									// extraemos publicKey y obtenemos address
									const publicKey_raw = res.dataRaw;

									const pubKeySts = new Ed25519PublicKey(publicKey_raw);
									setStsAddress(pubKeySts.toSuiAddress());

									// Creating the multisig public key
									const multisigPubKeySts = MultiSigPublicKey.fromPublicKeys({
										threshold: 2,
										publicKeys: [
											{ publicKey: pubKeyLocal, weight: 1 },
											{ publicKey: pubKeySts, weight: 1 },
										],
									});

									setMultisigAddress(multisigPubKeySts.toSuiAddress());

									const multisig_pubKey_base64 = Buffer.from(
										multisigPubKeySts.toBase64(),
									).toString();
									const multisig_address = multisigPubKeySts.toSuiAddress();

									console.log(`Public Key (base64): ${multisig_pubKey_base64.toString()}`);
									console.log(`Address: ${multisig_address}`);

									// Mostramos UI de confirmación
									setObtainedNewAddress(true);

									// Esperamos la confirmación del usuario
									await waitForConfirm();

									// Con los datos creamos la cuenta
									const hardcodedAccount = {
										address: multisig_address,
										derivationPath: "m/44'/784'/0'/0'/0'",
										publicKey: multisig_pubKey_base64,
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
				</>
			)}
			{obtainedNewAddress && (
				<>
					<SummaryCard
						header="First Multisig Participant 👟"
						body={
							<>
								<div className="text-center text-green-600 font-semibold text-sm">
									👟 Step-to-Sign Device Address:
								</div>
								<div className="text-center text-green-600 text-[12px]">{stsAddress}</div>
							</>
						}
					></SummaryCard>
					<SummaryCard
						header="Second Multisig Participant 📀"
						body={
							<>
								<div className="text-center text-green-600 font-semibold text-sm">
									📀 Local Account Address:
								</div>
								<div className="text-center text-green-600 text-[12px]">{localAddress}</div>
								<div className="text-center text-green-600 font-semibold text-sm mt-4">
									Local Account PrivateKey/SecretKey:
								</div>
								<div className="text-center text-green-600 text-[12px]">{localSecretKey}</div>
							</>
						}
					></SummaryCard>
					<SummaryCard
						header="New Multisig Account 🔑🔑"
						body={
							<>
								<div className="text-center text-green-600 font-semibold text-sm">
									🔑🔑 New Multisig Account Address:
								</div>
								<div className="text-center text-green-600 text-[12px]">{multisigAddress}</div>
							</>
						}
					></SummaryCard>

					<div style={{ marginTop: '16px' }}>
						<Button
							variant="outline"
							size="tall"
							text="Create Multisig Account"
							onClick={() => {
								// Dispara la resolución de la espera y limpia el resolver
								confirmResolverRef.current?.();
								confirmResolverRef.current = null;
							}}
						/>
					</div>
				</>
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
