
import { Injectable } from '@nestjs/common';
import {
    PaymentProvider,
    ProviderResult,
    ProviderScenario,
} from './provider.interface';

@Injectable()
export class MockProviderService implements PaymentProvider {
    private readonly outcomes = new Map<string, ProviderResult>();

    private readonly refundOutcomes = new Map<
        string,
        {
            amount: number;
            result: {
                success: boolean;
                refundedAmount: number;
                refundReference?: string;
            };
        }
    >();

    private getKey(companyId: string, merchantReference: string): string {
        return `${companyId}:${merchantReference}`;
    }

    async sale(input: {
        companyId: string;
        merchantReference: string;
        amount: number;
        scenario?: ProviderScenario;
    }): Promise<ProviderResult> {
        const scenario = input.scenario ?? 'SUCCESS';
        const key = this.getKey(input.companyId, input.merchantReference);
        const providerReference = `MOCK-${input.companyId}-${input.merchantReference}`;

        if (scenario === 'TIMEOUT') {
            this.outcomes.set(key, {
                status: 'SUCCESS',
                providerReference,
            });

            return { status: 'UNKNOWN', reason: 'PROVIDER_TIMEOUT' };
        }

        const result: ProviderResult =
            scenario === 'DECLINED'
                ? { status: 'FAILED', reason: 'CARD_DECLINED', providerReference }
                : scenario === 'PENDING'
                    ? { status: 'PENDING', providerReference }
                    : { status: 'SUCCESS', providerReference };

        this.outcomes.set(key, result);
        return result;
    }

    async inquiry(
        companyId: string,
        merchantReference: string,
    ): Promise<ProviderResult> {
        const key = this.getKey(companyId, merchantReference);

        return (
            this.outcomes.get(key) ?? {
                status: 'UNKNOWN',
                reason: 'NOT_FOUND',
            }
        );
    }

    async void(
        _providerReference: string,
    ): Promise<{ success: boolean }> {
        return { success: true };
    }

    async refund(
        providerReference: string,
        amount: number,
        idempotencyKey: string,
    ): Promise<{
        success: boolean;
        refundedAmount: number;
        refundReference?: string;
    }> {
        const key = `${providerReference}:${idempotencyKey}`;

        const existing = this.refundOutcomes.get(key);

        if (existing) {
            if (existing.amount !== amount) {
                return {
                    success: false,
                    refundedAmount: 0,
                };
            }

            return existing.result;
        }

        const result = {
            success: amount > 0,
            refundedAmount: amount > 0 ? amount : 0,
            refundReference: `REFUND-${key}`,
        };

        this.refundOutcomes.set(key, {
            amount,
            result,
        });

        return result;
    }
}
