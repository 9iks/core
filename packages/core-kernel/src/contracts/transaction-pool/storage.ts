import { Interfaces } from "@arkecosystem/crypto";

export interface Storage {
    hasTransaction(id: string): boolean;
    getAllTransactions(): Iterable<Interfaces.ITransaction>;
    addTransaction(transaction: Interfaces.ITransaction): void;
    removeTransaction(id: string): void;
    flush(): void;
}