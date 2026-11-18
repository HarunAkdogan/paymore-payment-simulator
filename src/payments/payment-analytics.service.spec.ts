import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { PaymentAnalyticsService } from './payment-analytics.service';
import { Payment } from './payment.schema';
import { Types } from 'mongoose';

describe('PaymentAnalyticsService Mock', () => {
    let service: PaymentAnalyticsService;

    const mockPaymentModel = {
        aggregate: jest.fn(),
        countDocuments: jest.fn(),
    };

    beforeEach(async () => {

        jest.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentAnalyticsService,
                {
                    provide: getModelToken(Payment.name),
                    useValue: mockPaymentModel,
                },
            ],
        }).compile();

        service = module.get<PaymentAnalyticsService>(PaymentAnalyticsService);
    });


    /*
    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    */

    it('Farklý þirketler için doðru companyId ile sorgu yapmalý', async () => {

        const companyId1 = "6af587d512a1a510cc29b724";
        const companyId2 = "6af587d512a1a510cc29b725";

        //mockPaymentModel.countDocuments.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
        
        await service.getCompanyPaymentCount(companyId1);
        await service.getCompanyPaymentCount(companyId2);

        //expect(result1).toBe(3);
        //expect(result2).toBe(5);
        
        expect(mockPaymentModel.countDocuments).toHaveBeenNthCalledWith(1, { companyId: new Types.ObjectId(companyId1) });
        expect(mockPaymentModel.countDocuments).toHaveBeenNthCalledWith(2, { companyId: new Types.ObjectId(companyId2) });

    });


    it('Geçersiz companyId verildiðinde hata fýrlatmalý', async () => {
        await expect(
            service.getCompanyPaymentCount('12345'),
        ).rejects.toThrow();

        expect(mockPaymentModel.countDocuments).not.toHaveBeenCalled();
    });

    it('countDocumnents bir kere çaðýrýlmalý', async () => {

        await service.getCompanyPaymentCount("6af587d512a1a510cc29b724");
        expect(mockPaymentModel.countDocuments).toHaveBeenCalledTimes(1);
    });


    it('Doðru companyId ile sorgulama', async () => {
        const companyId = '6af587d512a1a510cc29b724';

        mockPaymentModel.countDocuments.mockResolvedValue(0);

        await service.getCompanyPaymentCount(companyId);

        expect(mockPaymentModel.countDocuments).toHaveBeenCalledWith({
            companyId: new Types.ObjectId(companyId),
        });
    });

    it('Kayýt yoksa hata vermeden 0 dönmeli', async () => {
        mockPaymentModel.countDocuments.mockResolvedValue(0);

        const companyId = '6af587d512a1a510cc29b724';

        await expect(
            service.getCompanyPaymentCount(companyId),
        ).resolves.toBe(0);
    });






    it('þirket ödeme sayýsýný vermeli', async () => {

        const companyId = '6af587d512a1a510cc29b724';

        mockPaymentModel.countDocuments.mockResolvedValue(8);

        const result = await service.getCompanyPaymentCount(companyId);

        expect(mockPaymentModel.countDocuments).toHaveBeenCalledWith({
            companyId: new Types.ObjectId(companyId),
        });

        expect(result).toBe(8);

    });
});