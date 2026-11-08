export type ProviderScenario = 'SUCCESS' | 'DECLINED' | 'PENDING' | 'TIMEOUT';

export interface ProviderResult {
    status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNKNOWN';
    providerReference?: string;
    reason?: string;
}

export interface PaymentProvider {
    sale(input: {
        companyId: string;
        merchantReference: string;
        amount: number;
        scenario?: ProviderScenario;
    }): Promise<ProviderResult>;

    inquiry(companyId: string, merchantReference: string): Promise<ProviderResult>;

    void(providerReference: string): Promise<{ success: boolean }>;

    refund(
        providerReference: string,
        amount: number,
    ): Promise<{ success: boolean; refundedAmount: number }>;
}
