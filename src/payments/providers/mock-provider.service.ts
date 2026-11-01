import { Injectable } from '@nestjs/common';
import { PaymentProvider, ProviderResult, ProviderScenario } from './provider.interface';
@Injectable()
export class MockProviderService implements PaymentProvider {
  private readonly outcomes = new Map<string, ProviderResult>();
  async sale(input: { merchantReference: string; amount: number; scenario?: ProviderScenario }): Promise<ProviderResult> {
    const scenario = input.scenario ?? 'SUCCESS';
    const providerReference = `MOCK-${input.merchantReference}`;
    if (scenario === 'TIMEOUT') {
      // Provider completes the operation but the response is lost: inquiry can recover the result.
      this.outcomes.set(input.merchantReference, { status: 'SUCCESS', providerReference });
      return { status: 'UNKNOWN', reason: 'PROVIDER_TIMEOUT' };
    }
    const result: ProviderResult = scenario === 'DECLINED'
      ? { status: 'FAILED', reason: 'CARD_DECLINED', providerReference }
      : scenario === 'PENDING'
        ? { status: 'PENDING', providerReference }
        : { status: 'SUCCESS', providerReference };
    this.outcomes.set(input.merchantReference, result);
    return result;
  }
  async inquiry(merchantReference: string): Promise<ProviderResult> {
    return this.outcomes.get(merchantReference) ?? { status: 'UNKNOWN', reason: 'NOT_FOUND' };
  }
  async void(_providerReference: string): Promise<{ success: boolean }> { return { success: true }; }
  async refund(_providerReference: string, amount: number): Promise<{ success: boolean; refundedAmount: number }> { return { success: amount > 0, refundedAmount: amount }; }
}
