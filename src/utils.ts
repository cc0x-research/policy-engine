import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import {
  AddressLike,
  BaseContract,
  BigNumberish,
  BytesLike,
  ethers,
  Signer,
  TransactionResponse,
  ZeroAddress
} from 'ethers'

import { GUARD_STORAGE_SLOT } from '../lib/constants'
import { sameHexString } from '../test/deploy/util/strings'
import { Safe, SafePolicyGuard, SafeProxyFactory } from '../typechain-types'
import { ISafe } from '../typechain-types/contracts/interfaces/ISafe'

const { solidityPacked } = ethers

export enum SafeOperation {
  Call = 0,
  DelegateCall = 1
}

export type SafeCreationOptions = {
  owner: HardhatEthersSigner
  guard?: AddressLike
  saltNonce?: BigNumberish
  safeModule?: AddressLike
  fallbackHandler?: AddressLike
  safeProxyFactory: SafeProxyFactory
  singleton: Safe
}

export type MetaTransaction = {
  to?: AddressLike
  value?: BigNumberish
  data?: BytesLike
  operation?: SafeOperation
}

export type GasParametersAndRefund = {
  safeTxGas?: BigNumberish
  baseGas?: BigNumberish
  gasPrice?: BigNumberish
  gasToken?: AddressLike
  refundReceiver?: AddressLike
}

export type TransactionParameters = MetaTransaction & GasParametersAndRefund

export type TransactionParametersWithNonce = TransactionParameters & {
  nonce: BigNumberish
}

export type TransactionParametersWithSafe = TransactionParameters & {
  safe: ISafe
}

export type ExecTransactionParameters = TransactionParametersWithSafe & {
  owners: Signer[]
  additionalData?: BytesLike
  signingMethod?: 'signMessage' | 'preApprovedSignature'
}

export interface SafeSignature {
  signer: string
  data: string
}

export const EIP712_SAFE_MESSAGE_TYPE = {
  // "SafeMessage(bytes message)"
  SafeMessage: [{ type: 'bytes', name: 'message' }]
}

export const EIP712_SAFE_TX_TYPE = {
  // "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
  SafeTx: [
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'value' },
    { type: 'bytes', name: 'data' },
    { type: 'uint8', name: 'operation' },
    { type: 'uint256', name: 'safeTxGas' },
    { type: 'uint256', name: 'baseGas' },
    { type: 'uint256', name: 'gasPrice' },
    { type: 'address', name: 'gasToken' },
    { type: 'address', name: 'refundReceiver' },
    { type: 'uint256', name: 'nonce' }
  ]
}

/**
 * Function to calculate the address of a proxy contract.
 * @param factory The SafeProxyFactory contract.
 * @param singletonAddress The address of the singleton contract.
 * @param initializer The initializer data for the proxy contract.
 * @param saltNonce The salt nonce for the proxy contract.
 * @returns The address of the proxy contract.
 */
export const calculateProxyAddress = async (
  factory: SafeProxyFactory,
  singletonAddress: AddressLike,
  initializer: BytesLike,
  saltNonce: BigNumberish
) => {
  const salt = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256'],
    [ethers.solidityPackedKeccak256(['bytes'], [initializer]), saltNonce]
  )
  const factoryAddress = await factory.getAddress()
  const proxyCreationCode = await factory.proxyCreationCode()

  const deploymentCode = ethers.solidityPacked(['bytes', 'uint256'], [proxyCreationCode, singletonAddress])
  return ethers.getCreate2Address(factoryAddress, salt, ethers.keccak256(deploymentCode))
}

/**
 * Function to get the guard address of a Safe contract.
 * @param safe The Safe contract instance.
 * @returns The guard address of the Safe contract.
 */
export async function getGuard(safe: Safe): Promise<string> {
  return ethers.getAddress(ethers.dataSlice(await safe.getStorageAt(GUARD_STORAGE_SLOT, 1), 12))
}

/**
 * Function to create a Safe contract instance.
 * @param owner The owner of the Safe.
 * @param guard The guard address of the Safe.
 * @param saltNonce The salt nonce for the Safe.
 * @param safeModule The safe module address of the Safe.
 * @param fallbackHandler The fallback handler address of the Safe. Default is the zero address.
 * @param safeProxyFactory The SafeProxyFactory contract.
 * @param singleton The Safe singleton.
 * @returns The created Safe contract instance.
 */
export async function createSafe({
  owner,
  guard,
  saltNonce,
  safeModule,
  fallbackHandler = ZeroAddress,
  safeProxyFactory,
  singleton
}: SafeCreationOptions): Promise<Safe> {
  const provider = singleton.runner?.provider
  if (!provider) {
    throw new Error('Provider not found')
  }

  const initializer = singleton.interface.encodeFunctionData('setup', [
    [await owner.getAddress()],
    1,
    ZeroAddress,
    '0x',
    fallbackHandler,
    ZeroAddress,
    0,
    ZeroAddress
  ])
  saltNonce = saltNonce ?? ethers.toBigInt(ethers.randomBytes(32))

  // Calculate the address of the proxy
  // We calculate it offchain because a static call will revert if the proxy is already deployed
  const safeAddress = await calculateProxyAddress(
    safeProxyFactory,
    await singleton.getAddress(),
    initializer,
    saltNonce
  )
  // If the proxy is not deployed, we deploy it
  const contractCode = await provider.getCode(safeAddress)
  if (ethers.dataLength(contractCode) === 0) {
    await safeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce).then((tx) => tx.wait())
  }

  const safe = singleton.attach(safeAddress).connect(owner) as Safe
  if (guard !== undefined) {
    const currentGuard = await getGuard(safe)
    if (!sameHexString(currentGuard, guard as string)) {
      execTransaction({
        owners: [owner],
        safe: safe,
        to: safe,
        data: safe.interface.encodeFunctionData('setGuard', [guard])
      }).then((tx) => tx.wait())
    }
  }
  if (safeModule !== undefined) {
    const isModuleEnabled = await safe.isModuleEnabled(safeModule)
    if (!isModuleEnabled) {
      execTransaction({
        owners: [owner],
        safe: safe,
        to: safe,
        data: safe.interface.encodeFunctionData('enableModule', [safeModule])
      }).then((tx) => tx.wait())
    }
  }

  return safe
}

/**
 * Function to create a pre-approved signature for a Safe transaction.
 * @param owner The owner of the Safe.
 * @returns The pre-approved signature.
 */
async function preApprovedSignature(owner: AddressLike): Promise<string> {
  const ownerAddress = await ethers.resolveAddress(owner)
  return ethers.solidityPacked(['uint256', 'uint256', 'uint8'], [ownerAddress, 0, 1])
}

/**
 * Function to get the transaction hash of a Safe transaction.
 * @param safe The Safe contract instance.
 * @param to The address to send the transaction to. Default is the zero address.
 * @param value The value to send in the transaction. Default is 0.
 * @param data The data to send in the transaction. Default is empty bytes.
 * @param operation The operation to perform. Default is {SafeOperation.CALL}.
 * @param safeTxGas The gas limit for the transaction. Default is 0.
 * @param baseGas The base gas limit for the transaction. Default is 0.
 * @param gasPrice The gas price for the transaction. Default is 0.
 * @param gasToken The token to use for gas payment. Default is the zero address.
 * @param refundReceiver The address to receive the refund. Default is the zero address.
 * @returns The transaction hash.
 */
export async function getSafeTransactionHash({
  safe,
  to = ZeroAddress,
  value = 0n,
  data = '0x',
  operation = SafeOperation.Call,
  safeTxGas = 0n,
  baseGas = 0n,
  gasPrice = 0n,
  gasToken = ZeroAddress,
  refundReceiver = ZeroAddress
}: TransactionParametersWithSafe): Promise<string> {
  const nonce = BigInt(await safe.nonce())

  return await safe.getTransactionHash(
    to,
    value,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce
  )
}

/**
 * Function to execute a transaction on a Safe.
 * @param owners The owners of the Safe.
 * @param safe The Safe contract instance.
 * @param to The address to send the transaction to. Default is the zero address.
 * @param value The value to send in the transaction. Default is 0.
 * @param data The data to send in the transaction. Default is empty bytes.
 * @param operation The operation to perform. Default is {SafeOperation.CALL}.
 * @param safeTxGas The gas limit for the transaction. Default is 0.
 * @param baseGas The base gas limit for the transaction. Default is 0.
 * @param gasPrice The gas price for the transaction. Default is 0.
 * @param gasToken The token to use for gas payment. Default is the zero address.
 * @param refundReceiver The address to receive the refund. Default is the zero address.
 * @param additionalData Additional data like the signature for transaction. Default is empty bytes.
 * @param signingMethod The method to sign the transaction. Default is 'preApprovedSignature'.
 * @returns The transaction response.
 */
export async function execTransaction({
  owners,
  safe,
  to = ZeroAddress,
  value = 0n,
  data = '0x',
  operation = SafeOperation.Call,
  safeTxGas = 0n,
  baseGas = 0n,
  gasPrice = 0n,
  gasToken = ZeroAddress,
  refundReceiver = ZeroAddress,
  additionalData = '0x',
  signingMethod = 'preApprovedSignature'
}: ExecTransactionParameters): Promise<TransactionResponse> {
  const transactionHash = await getSafeTransactionHash({
    safe,
    to,
    value,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver
  })

  let signatureBytes: BytesLike = '0x'

  if (signingMethod === 'signMessage') {
    const bytesDataHash = ethers.getBytes(transactionHash)

    const sorted = await Promise.all(
      Array.from(owners).map(async (owner) => ({
        owner,
        address: await owner.getAddress()
      }))
    ).then((ownerInfos) =>
      ownerInfos
        .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase(), 'en', { sensitivity: 'base' }))
        .map((info) => info.owner)
    )

    for (let i = 0; i < sorted.length; i++) {
      const flatSig = (await sorted[i].signMessage(bytesDataHash)).replace(/1b$/, '1f').replace(/1c$/, '20')
      signatureBytes += flatSig.slice(2)
    }
  } else if (signingMethod === 'preApprovedSignature') {
    signatureBytes = (await preApprovedSignature(owners[0])) as BytesLike
  } else {
    throw new Error('signing method not supported')
  }

  if (additionalData.length > 2) {
    signatureBytes = solidityPacked(
      ['bytes', 'bytes', 'uint256'],
      [signatureBytes, additionalData, (additionalData.length - 2) / 2]
    ) as BytesLike
  }

  return await safe
    .connect(owners[0])
    .execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatureBytes)
}

/**
 * Function to calculate the hash of a message for a Safe.
 * @param safeAddress The address of the Safe.
 * @param message The message to hash.
 * @param chainId The chain ID of the network.
 * @returns The hash of the message.
 * @dev This function uses the EIP712 standard to calculate the hash of a message for a Safe.
 */
export async function calculateSafeMessageHash(safeAddress: string, message: string, chainId: number): Promise<string> {
  return ethers.TypedDataEncoder.hash({ verifyingContract: safeAddress, chainId }, EIP712_SAFE_MESSAGE_TYPE, {
    message
  })
}

/**
 * Function to create a random address.
 * @returns A random address.
 */
export function randomAddress(): AddressLike {
  return ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)))
}

/**
 * Function to create a random selector.
 * @returns A random selector.
 */
export function randomSelector(): BytesLike {
  return ethers.hexlify(ethers.randomBytes(4))
}

/**
 * Function to create configuration for the SafePolicyGuard.
 * @param target The target address of the configuration. Default is the zero address.
 * @param selector The selector of the configuration. Default is zero selector.
 * @param operation The operation of the configuration. Default is {SafeOperation.CALL}.
 * @param policy The policy address of the configuration. Default is the zero address.
 * @param data The data of the configuration. Default is empty bytes.
 * @returns The configuration object.
 */
export function createConfiguration({
  target = ZeroAddress as AddressLike,
  selector = '0x00000000' as BytesLike,
  operation = SafeOperation.Call,
  policy = ZeroAddress as AddressLike,
  data = '0x' as BytesLike
}): SafePolicyGuard.ConfigurationStruct {
  return {
    target,
    selector,
    operation,
    policy,
    data
  }
}

/**
 * Function to create the root hash of the configuration.
 * @param configurations The configurations to create the root hash from.
 * @returns The root hash of the configuration.
 * @dev The root hash is created by encoding the configurations and hashing them with keccak256.
 */
export function getConfigurationRoot(configurations: SafePolicyGuard.ConfigurationStruct[]): BytesLike {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address target, bytes4 selector, uint8 operation, address policy, bytes data)[]'],
      [configurations]
    )
  )
}

/**
 * Function to sign a Safe transaction with a signer.
 * @param signer The signer to sign the transaction with.
 * @param safeAddress The address of the Safe.
 * @param safeTx The transaction to sign.
 * @param chainId The chain ID of the network.
 * @returns The signed transaction.
 */
export const safeSignTypedData = async (
  signer: Signer,
  safeAddress: string,
  safeTx: TransactionParametersWithNonce,
  chainId?: BigNumberish
): Promise<SafeSignature> => {
  if (!chainId && !signer.provider) throw Error('Provider required to retrieve chainId')
  const cid = chainId || (await signer.provider!.getNetwork()).chainId
  const signerAddress = await signer.getAddress()
  return {
    signer: signerAddress,
    data: await signer.signTypedData({ verifyingContract: safeAddress, chainId: cid }, EIP712_SAFE_TX_TYPE, safeTx)
  }
}

/**
 * Function to build a Safe transaction.
 * @param tx The transaction parameters.
 * @returns The built Safe transaction.
 */
export const buildSafeTransaction = (tx: TransactionParametersWithNonce): TransactionParametersWithNonce => {
  return {
    to: tx.to || ZeroAddress,
    value: tx.value || 0,
    data: tx.data || '0x',
    operation: tx.operation || 0,
    safeTxGas: tx.safeTxGas || 0,
    baseGas: tx.baseGas || 0,
    gasPrice: tx.gasPrice || 0,
    gasToken: tx.gasToken || ZeroAddress,
    refundReceiver: tx.refundReceiver || ZeroAddress,
    nonce: tx.nonce || 0
  }
}

/**
 * Function to encode a multi-send transaction.
 * @param txs The transactions to encode.
 * @returns The encoded multi-send transaction.
 */
export const encodeMultiSend = (txs: MetaTransaction[]): string => {
  const encoded =
    '0x' +
    txs
      .map((tx) => {
        const data = ethers.getBytes(tx.data ?? '0x')
        return ethers
          .solidityPacked(
            ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
            [tx.operation, tx.to, tx.value, data.length, tx.data]
          )
          .slice(2)
      })
      .join('')
  return encoded
}

/**
 * Function to build a contract call transaction.
 * @param contract The contract to call.
 * @param method The method to call on the contract.
 * @param params The parameters to pass to the method.
 * @param nonce The nonce for the transaction.
 * @param delegateCall Whether to use delegate call. Default is false.
 * @param overrides Additional transaction parameters.
 * @returns The built transaction parameters.
 */
export const buildContractCall = async (
  contract: BaseContract,
  method: string,
  params: unknown[],
  nonce: BigNumberish,
  delegateCall?: boolean,
  overrides?: TransactionParametersWithNonce
): Promise<TransactionParametersWithNonce> => {
  const data = contract.interface.encodeFunctionData(method, params)
  return buildSafeTransaction({
    to: await contract.getAddress(),
    data,
    operation: delegateCall ? 1 : 0,
    nonce,
    ...overrides
  })
}

/**
 * Function to build a multi-send Safe transaction.
 * @param multiSend The multi-send contract.
 * @param txs The transactions to send.
 * @param nonce The nonce for the transaction.
 * @param overrides Additional transaction parameters.
 * @returns The built transaction parameters.
 */
export const buildMultiSendSafeTx = async (
  multiSend: BaseContract,
  txs: MetaTransaction[],
  nonce: BigNumberish,
  overrides?: TransactionParametersWithNonce
): Promise<TransactionParametersWithNonce> => {
  return buildContractCall(multiSend, 'multiSend', [encodeMultiSend(txs)], nonce, true, overrides)
}
