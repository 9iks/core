import { app, Contracts } from "@arkecosystem/core-kernel";
import {
    Enums,
    Interfaces as MagistrateInterfaces,
    Transactions as MagistrateTransactions,
} from "@arkecosystem/core-magistrate-crypto";
import { Handlers, TransactionReader } from "@arkecosystem/core-transactions";
import { Interfaces, Managers, Transactions } from "@arkecosystem/crypto";

import {
    BridgechainIsNotRegisteredError,
    BridgechainIsResignedError,
    BusinessIsNotRegisteredError,
    BusinessIsResignedError,
} from "../errors";
import { MagistrateApplicationEvents } from "../events";
import { IBridgechainWalletAttributes, IBusinessWalletAttributes } from "../interfaces";
import { BridgechainRegistrationTransactionHandler } from "./bridgechain-registration";

export class BridgechainUpdateTransactionHandler extends Handlers.TransactionHandler {
    public getConstructor(): Transactions.TransactionConstructor {
        return MagistrateTransactions.BridgechainUpdateTransaction;
    }

    public dependencies(): ReadonlyArray<Handlers.TransactionHandlerConstructor> {
        return [BridgechainRegistrationTransactionHandler];
    }

    public walletAttributes(): ReadonlyArray<string> {
        return [];
    }

    public async isActivated(): Promise<boolean> {
        return !!Managers.configManager.getMilestone().aip11;
    }

    public async bootstrap(
        connection: Contracts.Database.Connection,
        walletRepository: Contracts.State.WalletRepository,
    ): Promise<void> {
        const reader: TransactionReader = await TransactionReader.create(connection, this.getConstructor());

        while (reader.hasNext()) {
            const transactions = await reader.read();

            for (const transaction of transactions) {
                const wallet: Contracts.State.Wallet = walletRepository.findByPublicKey(transaction.senderPublicKey);
                const businessAttributes: IBusinessWalletAttributes = wallet.getAttribute<IBusinessWalletAttributes>(
                    "business",
                );

                const { bridgechainId, seedNodes } = transaction.asset.bridgechainUpdate;
                businessAttributes.bridgechains[bridgechainId].bridgechainAsset.seedNodes = seedNodes;

                walletRepository.reindex(wallet);
            }
        }
    }

    public async throwIfCannotBeApplied(
        transaction: Interfaces.ITransaction,
        wallet: Contracts.State.Wallet,
        databaseWalletRepository: Contracts.State.WalletRepository,
    ): Promise<void> {
        if (!wallet.hasAttribute("business")) {
            throw new BusinessIsNotRegisteredError();
        }

        if (wallet.getAttribute("business.resigned") === true) {
            throw new BusinessIsResignedError();
        }

        const businessAttributes: IBusinessWalletAttributes = wallet.getAttribute<IBusinessWalletAttributes>(
            "business",
        );
        const bridgechainUpdate: MagistrateInterfaces.IBridgechainUpdateAsset =
            transaction.data.asset.bridgechainUpdate;
        const bridgechainAttributes: IBridgechainWalletAttributes =
            businessAttributes.bridgechains[bridgechainUpdate.bridgechainId.toFixed()];

        if (!bridgechainAttributes) {
            throw new BridgechainIsNotRegisteredError();
        }

        if (bridgechainAttributes.resigned) {
            throw new BridgechainIsResignedError();
        }

        return super.throwIfCannotBeApplied(transaction, wallet, databaseWalletRepository);
    }

    public emitEvents(transaction: Interfaces.ITransaction, emitter: Contracts.Kernel.Events.EventDispatcher): void {
        emitter.dispatch(MagistrateApplicationEvents.BridgechainUpdate, transaction.data);
    }

    public async canEnterTransactionPool(
        data: Interfaces.ITransactionData,
        pool: Contracts.TransactionPool.Connection,
        processor: Contracts.TransactionPool.Processor,
    ): Promise<boolean> {
        return true;
    }

    public async applyToSender(
        transaction: Interfaces.ITransaction,
        walletRepository: Contracts.State.WalletRepository,
    ): Promise<void> {
        await super.applyToSender(transaction, walletRepository);

        const wallet: Contracts.State.Wallet = walletRepository.findByPublicKey(transaction.data.senderPublicKey);
        const businessAttributes: IBusinessWalletAttributes = wallet.getAttribute<IBusinessWalletAttributes>(
            "business",
        );
        const bridgechainUpdate: MagistrateInterfaces.IBridgechainUpdateAsset =
            transaction.data.asset.bridgechainUpdate;

        const bridgechainAttributes: IBridgechainWalletAttributes =
            businessAttributes.bridgechains[bridgechainUpdate.bridgechainId.toFixed()];
        bridgechainAttributes.bridgechainAsset.seedNodes = bridgechainUpdate.seedNodes;

        walletRepository.reindex(wallet);
    }

    public async revertForSender(
        transaction: Interfaces.ITransaction,
        walletRepository: Contracts.State.WalletRepository,
    ): Promise<void> {
        await super.revertForSender(transaction, walletRepository);

        const sender: Contracts.State.Wallet = walletRepository.findByPublicKey(transaction.data.senderPublicKey);
        const businessAttributes: IBusinessWalletAttributes = sender.getAttribute<IBusinessWalletAttributes>(
            "business",
        );

        const connection: Contracts.Database.Connection = app.get<Contracts.Database.Connection>("database");
        const reader: TransactionReader = await TransactionReader.create(connection, this.getConstructor());
        const updateTransactions: Contracts.Database.IBootstrapTransaction[] = [];
        while (reader.hasNext()) {
            updateTransactions.push(...(await reader.read()));
        }

        if (updateTransactions.length > 1) {
            const updateTransaction: Contracts.Database.IBootstrapTransaction = updateTransactions.pop();
            const { bridgechainId, seedNodes } = updateTransaction.asset.bridgechainUpdate;
            const bridgechainAttributes: IBridgechainWalletAttributes = businessAttributes.bridgechains[bridgechainId];
            bridgechainAttributes.bridgechainAsset.seedNodes = seedNodes;
        } else {
            // There are equally many bridgechain registrations as bridgechains a wallet posseses in the database.
            // By getting the index of the bridgechainId we can use it as an offset to get
            // the actual registration transaction.
            const bridgechainId: string = transaction.data.asset.bridgechainUpdate.bridgechainId.toFixed();
            const registrationIndex: number = Object.keys(businessAttributes.bridgechains).indexOf(bridgechainId);

            const bridgechainRegistration: MagistrateInterfaces.IBridgechainRegistrationAsset = (await app
                .get<Contracts.Database.Connection>("database")
                .transactionsRepository.search({
                    parameters: [
                        {
                            field: "senderPublicKey",
                            value: sender.publicKey,
                            operator: Contracts.Database.SearchOperator.OP_EQ,
                        },
                        {
                            field: "type",
                            value: Enums.MagistrateTransactionType.BridgechainRegistration,
                            operator: Contracts.Database.SearchOperator.OP_EQ,
                        },
                    ],
                    orderBy: [
                        {
                            direction: "asc",
                            field: "nonce",
                        },
                    ],
                    paginate: {
                        limit: 1,
                        offset: registrationIndex,
                    },
                })).rows[0].asset.bridgechainRegistration;

            const bridgechainAttributes: IBridgechainWalletAttributes = businessAttributes.bridgechains[bridgechainId];
            bridgechainAttributes.bridgechainAsset.seedNodes = bridgechainRegistration.seedNodes;
        }

        walletRepository.reindex(sender);
    }

    public async applyToRecipient(
        transaction: Interfaces.ITransaction,
        walletRepository: Contracts.State.WalletRepository,
        // tslint:disable-next-line: no-empty
    ): Promise<void> {}

    public async revertForRecipient(
        transaction: Interfaces.ITransaction,
        walletRepository: Contracts.State.WalletRepository,
        // tslint:disable-next-line:no-empty
    ): Promise<void> {}
}