/* eslint-disable no-extend-native */
import { bnb, loki } from '../helpers';
import { db, crypto, transaction, validation, SWAP_TYPE, TYPE } from '../utils';

// - Public

/**
 * Swap tokens
 * Request Data:
 *  - type: The type of swap (SWAP_TYPE).
 *  - address: An address. The type of address is determined from the `type` passed.
 *  E.g If `type = LOKI_TO_BLOKI` then the `address` is expected to be a loki address.
 */
export function swapToken(req, res, next) {
  crypto.decryptAPIPayload(req, res, next, async data => {
    const result = await validation.validateSwap(data);
    if (result != null) {
      res.status(400);
      res.body = { status: 400, success: false, result };
      return next(null, req, res, next);
    }

    const { type, address } = data;

    // We assume the address type is that of the currency we are swapping to.
    // So if the swap is LOKI_TO_BLOKI then we want the user to give the BNB address
    // We then generate a LOKI address that they will deposit to.
    // After the deposit we pay them out to the BNB address they passed.
    const addressType = type === SWAP_TYPE.LOKI_TO_BLOKI ? TYPE.BNB : TYPE.LOKI;

    try {
      const account = await db.getClientAccount(address, addressType);
      if (account) {
        res.status(205);
        res.body = { status: 200, success: true, result: account };
        return next(null, req, res, next);
      }

      let newAccount = null;
      if (addressType === TYPE.LOKI) {
        // Create a BNB account
        newAccount = bnb.createAccountWithMnemonic();
      } else if (addressType === TYPE.BNB) {
        newAccount = await loki.createAccount();
      }

      if (!newAccount) {
        console.error('Failed to make new account for: ', addressType);
        throw new Error('Invalid swap');
      }

      const clientAccount = await db.insertClientAccount(address, addressType, newAccount);
      res.status(205);
      res.body = { status: 200, success: true, result: clientAccount };
    } catch (error) {
      console.log(error);
      const message = (error && error.message);
      res.status(500);
      res.body = { status: 500, success: false, result: message || error };
    }

    return next(null, req, res, next);
  });
}

/**
 * Check to see if transfer was done.
 * Validate that against the swaps that have recorded previously.
 * Insert all new deposits into swaps.
 * Return all new deposits.
 *
 * Request Data:
 *  - uuid: The uuid that was returned in `swapToken` (client account uuid)
 */
export function finalizeSwap(req, res, next) {
  crypto.decryptAPIPayload(req, res, next, async data => {
    const result = validation.validateUuidPresent(data);
    if (result != null) {
      res.status(400);
      res.body = { status: 400, success: false, result };
      return next(null, req, res, next);
    }

    const { uuid } = data;
    try {
      const clientAccount = await db.getClientAccountForUuid(uuid);
      if (!clientAccount) {
        res.status(400);
        res.body = { status: 400, success: false, result: 'Unable to find swap details' };
        return next(null, req, res, next);
      }

      const { accountAddress, accountType } = clientAccount;

      const [transactions, swaps] = await Promise.all([
        transaction.getIncomingTransactions(accountAddress, accountType),
        db.getSwapsForClientAccount(uuid),
      ]);

      if (!transactions || transactions.length === 0) {
        res.status(400);
        res.body = { status: 400, success: false, result: 'Unable to find a deposit' };
        return next(null, req, res, next);
      }

      // Filter out any transactions we haven't added to our swaps db
      const newTransactions = transactions.filter(tx => !swaps.find(s => s.deposit_transaction_hash === tx.hash));
      if (newTransactions.length === 0) {
        res.status(400);
        res.body = { status: 400, success: false, result: 'Unable to find any new deposits' };
        return next(null, req, res, next);
      }

      // Give back the new swaps to the user
      const newSwaps = await db.insertSwaps(newTransactions, clientAccount);
      res.status(205);
      res.body = { status: 200, success: true, result: newSwaps };
    } catch (error) {
      console.log(error);
      const message = (error && error.message);
      res.status(500);
      res.body = { status: 500, success: false, result: message || error };
    }

    return next(null, req, res, next);
  });
}

export async function getSwaps(req, res, next) {
  const data = req.query;

  const result = validation.validateUuidPresent(data);
  if (result != null) {
    res.status(400);
    res.body = { status: 400, success: false, result };
    return next(null, req, res, next);
  }

  const { uuid } = data;

  try {
    const clientAccount = await db.getClientAccountForUuid(uuid);
    if (!clientAccount) {
      res.status(400);
      res.body = { status: 400, success: false, result: 'Unable to find swap details' };
      return next(null, req, res, next);
    }

    const { address, addressType, accountAddress } = clientAccount;

    const swaps = await db.getSwapsForClientAccount(uuid);
    if (!swaps) {
      res.status(400);
      res.body = { status: 400, success: false, result: 'Failed to fetch swaps' };
      return next(null, req, res, next);
    }

    const lokiAddress = addressType === TYPE.LOKI ? address : accountAddress;
    const bnbAddress = addressType === TYPE.BNB ? address : accountAddress;

    const formatted = swaps.map(swap => {
      const transactionHashes = swap.transfer_transaction_hash;
      const transactionHashArray = (transactionHashes && transactionHashes.split(',')) || [];

      return {
        uuid: swap.uuid,
        type: swap.type,
        lokiAddress,
        bnbAddress,
        amount: swap.amount,
        txHash: swap.deposit_transaction_hash,
        transferTxHashes: transactionHashArray,
        created: swap.created,
      };
    });

    res.status(205);
    res.body = { status: 200, success: true, result: formatted };
  } catch (error) {
    console.log(error);
    const message = (error && error.message);
    res.status(500);
    res.body = { status: 500, success: false, result: message || error };
  }

  return next(null, req, res, next);
}
