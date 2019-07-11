import { assert } from 'chai';
import sinon from 'sinon';
import config from 'config';
import { SWAP_TYPE, TYPE } from 'bridge-core';
import { bnb, loki, postgres } from '../../core';
import functions from '../../functions/swaps';
import { dbHelper } from '../helpers';

const sandbox = sinon.createSandbox();

describe('Processing Swaps', () => {
  afterEach(() => {
    sandbox.restore();
  });

  describe('#getTransactions', () => {
    it('should combine swap amounts', async () => {
      const swaps = [
        { address: '1', amount: '10' },
        { address: '1', amount: 20 },
        { address: '2', amount: '15' },
      ];

      const transactions = functions.getTransactions(swaps);
      assert.deepEqual(transactions, [
        { address: '1', amount: 30 },
        { address: '2', amount: 15 },
      ]);
    });

    it('should be able to parse string amounts', async () => {
      const transactions = functions.getTransactions([{ address: '1', amount: '12.3456789' }]);
      assert.deepEqual(transactions, [{ address: '1', amount: 12.3456789 }]);
    });

    it('should return a 0 amount if swap amount was not a number', async () => {
      const transactions = functions.getTransactions([{ address: '1', amount: 'invalid amount' }]);
      assert.deepEqual(transactions, [{ address: '1', amount: 0 }]);
    });
  });

  describe('#send', () => {
    const transactions = [{ address: '1', amount: 7 * 1e9 }];

    let bnbStub;
    let lokiStub;

    beforeEach(() => {
      bnbStub = sandbox.stub(bnb, 'multiSend');
      lokiStub = sandbox.stub(loki, 'multiSend');
    });

    it('should send to BNB if swap type is LOKI_TO_BLOKI', async () => {
      await functions.send(SWAP_TYPE.LOKI_TO_BLOKI, transactions);
      assert(bnbStub.called, 'bnb.multiSend was not called');
    });

    it('should send to LOKI if swap type is BLOKI_TO_LOKI', async () => {
      await functions.send(SWAP_TYPE.BLOKI_TO_LOKI, transactions);
      assert(lokiStub.called, 'loki.multiSend was not called');
    });

    it('should throw an error if swap type was invalid', async () => {
      try {
        await functions.send('invalid', transactions);
        assert.fail('Should have failed');
      } catch (e) {
        assert.strictEqual(e.message, 'Invalid swap type');
      }
    });

    it('should convert the transactions to correct outputs for BNB', async () => {
      await functions.send(SWAP_TYPE.LOKI_TO_BLOKI, transactions);

      const { args } = bnbStub.getCalls()[0];
      assert.lengthOf(args, 3);

      const outputs = args[1];
      assert.isNotNull(outputs);
      assert.deepEqual(outputs, [{
        to: transactions[0].address,
        coins: [{
          denom: 'TEST', // Defines in test.json
          amount: transactions[0].amount,
        }],
      }]);
    });

    it('should deduct the widthdrawal fee from each transaction for Loki', async () => {
      const fee = config.get('loki.withdrawalFee');

      await functions.send(SWAP_TYPE.BLOKI_TO_LOKI, transactions);

      const { args } = lokiStub.getCalls()[0];
      assert.lengthOf(args, 1);

      const outputs = args[0];
      assert.isNotNull(outputs);
      assert.deepEqual(outputs, [{
        address: transactions[0].address,
        amount: transactions[0].amount - (fee * 1e9),
      }]);
    });
  });

  describe('#processAllSwapsOfType', () => {
    beforeEach(async () => {
      // Clear out any data in the db
      await postgres.none('TRUNCATE client_accounts, accounts_loki, accounts_bnb, swaps CASCADE;');

      sandbox.stub(bnb, 'multiSend').returns(['bnbTxHash1', 'bnbTxHash2']);
      sandbox.stub(loki, 'multiSend').returns(['lokiTxHash1', 'lokiTxHash2']);
    });

    const processAllSwapsOfType = async swapType => {
      const addressType = swapType === SWAP_TYPE.LOKI_TO_BLOKI ? TYPE.BNB : TYPE.LOKI;
      const accountType = addressType === TYPE.BNB ? TYPE.LOKI : TYPE.BNB;
      const clientAccountUuid = 'cbfa4d0f-cecb-4c46-88b8-719bbca6395a';
      const swapUuid = 'a2a67748-ae5d-415c-81d6-803d28dc29fb';

      await postgres.tx(t => t.batch([
        dbHelper.insertClientAccount(clientAccountUuid, 'address', addressType, 'uuid', accountType),
        dbHelper.insertSwap(swapUuid, swapType, 10 * 1e9, clientAccountUuid, 'pending'),
      ]));

      await functions.processAllSwapsOfType(swapType);

      return postgres.oneOrNone('select transfer_transaction_hash from swaps where uuid = $1', [swapUuid]);
    };

    context('LOKI_TO_BLOKI', () => {
      it('should update the transfer transactions hash on success', async () => {
        const swap = await processAllSwapsOfType(SWAP_TYPE.LOKI_TO_BLOKI);
        assert.isNotNull(swap);
        assert.strictEqual(swap.transfer_transaction_hash, 'bnbTxHash1,bnbTxHash2');
      });
    });

    context('BLOKI_TO_LOKI', () => {
      it('should update the transfer transactions hash on success', async () => {
        const swap = await processAllSwapsOfType(SWAP_TYPE.BLOKI_TO_LOKI);
        assert.isNotNull(swap);
        assert.strictEqual(swap.transfer_transaction_hash, 'lokiTxHash1,lokiTxHash2');
      });
    });
  });
});
