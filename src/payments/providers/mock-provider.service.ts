
import { Injectable } from '@nestjs/common';
import {
    PaymentProvider,
    ProviderResult,
    ProviderScenario,
} from './provider.interface';

@Injectable()
export class MockProviderService implements PaymentProvider {
    private readonly outcomes = new Map<string, ProviderResult>();

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
            // Provider completes the operation but the response is lost.
            // Inquiry can recover the result.
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
        _providerReference: string,
        amount: number,
    ): Promise<{ success: boolean; refundedAmount: number }> {
        return {
            success: amount > 0,
            refundedAmount: amount,
        };
    }
}
