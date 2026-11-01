import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

describe('PaymentsService refund validation', () => {
  const payment = { _id: 'id1', amount: 10000, refundedAmount: 7000, status: 'SUCCESS', providerReference: 'mock-ref', save: jest.fn() };
  const model: any = { findById: jest.fn().mockResolvedValue(payment), findOneAndUpdate: jest.fn() };
  const provider: any = { refund: jest.fn().mockResolvedValue({ success: true, refundedAmount: 1000 }) };
  const redis: any = {};
  const service = new PaymentsService(model, provider, redis);
  it('rejects refund greater than remaining balance', async () => {
    await expect(service.refund('id1', 4000)).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.refund).not.toHaveBeenCalled();
  });
  it('rejects refund for missing provider state', async () => {
    model.findById.mockResolvedValueOnce({ ...payment, status: 'FAILED' });
    await expect(service.refund('id1', 1000)).rejects.toBeInstanceOf(ConflictException);
  });
});
