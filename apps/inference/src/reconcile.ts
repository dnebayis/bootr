import { createPublicClient, http, type Address, type Hex } from 'viem';
import type { InferenceRequest } from './db/schema.js';
import type { RequestStore } from './store.js';

/**
 * Reconciliation of `in_flight` / `unknown` rows ("never buy a replacement").
 *
 * While a row is `unknown`, the payer's signed authorization may still be settled by whoever
 * holds it (relay or facilitator), so the client must not pay for a replacement. A row leaves
 * `unknown` only on evidence:
 *  - on-chain: USDC `authorizationState(from, nonce)` is true -> funds moved. Because
 *    `(payer, nonce)` is unique across rows, the used nonce can only belong to this row. If the
 *    relay holds the completion, the row becomes `succeeded` and replays deliver it; otherwise it
 *    becomes a `credit` and a replay with the same key runs the request without a new payment.
 *  - expiry: the authorization's `validBefore` has passed and the nonce is unused (or, without
 *    an RPC, the relay never submitted it) -> nobody can settle it any more -> `failed`, and the
 *    client may retry with a new Idempotency-Key.
 * A stale `in_flight` row whose payment already settled (relay crashed during the upstream call)
 * becomes a `credit` directly.
 */

export interface AuthorizationChecker {
  isUsed(args: { asset: string; authorizer: string; nonce: string }): Promise<boolean>;
}

const authorizationStateAbi = [
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export function createRpcAuthorizationChecker(rpcUrl: string): AuthorizationChecker {
  // No CCIP-Read: the asset is a payer-named address, and an OffchainLookup revert must not make the relay fetch URLs.
  const client = createPublicClient({ transport: http(rpcUrl), ccipRead: false });
  return {
    async isUsed({ asset, authorizer, nonce }) {
      return client.readContract({
        address: asset as Address,
        abi: authorizationStateAbi,
        functionName: 'authorizationState',
        args: [authorizer as Address, nonce as Hex],
      });
    },
  };
}

export interface ReconcilerOptions {
  store: RequestStore;
  checker?: AuthorizationChecker;
  /** Rows stuck `in_flight` longer than this are treated as interrupted (-> unknown). */
  staleAfterMs: number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

export type Reconciler = (row: InferenceRequest) => Promise<InferenceRequest>;

export function createReconciler(opts: ReconcilerOptions): Reconciler {
  const now = opts.now ?? Date.now;

  return async function reconcile(row) {
    let current = row;

    if (current.status === 'in_flight' && now() - current.updatedAt.getTime() > opts.staleAfterMs) {
      const paid = current.payment?.settled === true;
      current =
        (await opts.store.update(
          current.payer,
          current.idempotencyKey,
          paid
            ? { status: 'credit', statusReason: 'relay_interrupted_after_payment' }
            : { status: 'unknown', statusReason: 'relay_interrupted' },
          'in_flight',
        )) ??
        (await opts.store.get(current.payer, current.idempotencyKey)) ??
        current;
    }
    if (current.status !== 'unknown' || !current.payment) return current;

    const payment = current.payment;
    const expired = payment.expiresAt !== undefined && now() / 1000 > payment.expiresAt;

    if (opts.checker && payment.authorization) {
      let used: boolean;
      try {
        used = await opts.checker.isUsed({
          asset: payment.asset,
          authorizer: payment.authorization.from,
          nonce: payment.authorization.nonce,
        });
      } catch (err) {
        opts.log?.warn(
          `reconcile: authorizationState read failed for ${current.requestId}: ${String(err)}`,
        );
        return current;
      }
      if (used) {
        const paid = {
          chargedMicroUsdc: Number(payment.amount),
          payment: { ...payment, settled: true },
        };
        if (current.response?.status === 200) {
          return (
            (await opts.store.update(
              current.payer,
              current.idempotencyKey,
              { status: 'succeeded', statusReason: 'reconciled_onchain_paid', ...paid },
              'unknown',
            )) ?? current
          );
        }
        // Paid but no completion yet: the payment becomes a credit for this key.
        return (
          (await opts.store.update(
            current.payer,
            current.idempotencyKey,
            { status: 'credit', statusReason: 'reconciled_onchain_paid', ...paid },
            'unknown',
          )) ?? current
        );
      }
      if (expired) return markExpired(current);
      return current;
    }

    // No on-chain evidence available: only an authorization the relay never submitted can be
    // declared dead, and only after it expired.
    if (expired && !payment.settlementAttempted) return markExpired(current);
    return current;
  };

  async function markExpired(row: InferenceRequest): Promise<InferenceRequest> {
    return (
      (await opts.store.update(
        row.payer,
        row.idempotencyKey,
        {
          status: 'failed',
          statusReason: 'authorization_expired_unsettled',
          response: {
            status: 502,
            headers: {},
            body: {
              error: {
                code: 'request_failed_unpaid',
                message:
                  'The request did not complete and the payment authorization expired unused. Nothing was charged.',
              },
            },
          },
        },
        'unknown',
      )) ?? row
    );
  }
}
