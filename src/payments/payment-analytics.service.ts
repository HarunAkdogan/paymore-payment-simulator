import { Injectable } from "@nestjs/common";
import { Payment, PaymentStatus } from "./payment.schema";
import { Model, Types } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";



@Injectable()
export class PaymentAnalyticsService {

    constructor(
        @InjectModel(Payment.name)
        private readonly paymentModel: Model<Payment>,
    ) { }

    async getSuccessfulPayments(companyId : string) {

        return this.paymentModel.find({
            companyId: new Types.ObjectId(companyId),
            status: PaymentStatus.SUCCESS,
        }).sort({ amount: 1 }).select("amount currency").lean();
    }


    async getCompanyPaymentsByDate(companyId : string, startDate : Date, endDate : Date) {
        return this.paymentModel.find({
            companyId: new Types.ObjectId(companyId),
            createdAt: {
                $gte: startDate,
                $lte: endDate,
            },
        }).sort({ createdAt: -1 }).select('merchantReference amount currency status createdAt')
            .lean();
    }

    async getLatestCompanyPayments(companyId: string) {
        return this.paymentModel
            .find({
                companyId: new Types.ObjectId(companyId),
            })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('merchantReference amount currency status createdAt')
            .lean();
    }

    async getCompanyPaymentStatusCounts(companyId: string) {
        return this.paymentModel.aggregate([
            {
                $match: {
                    companyId: new Types.ObjectId(companyId),
                },
            },
            {
                $group: {
                    _id: null,

                    successful: {
                        $sum: {
                            $cond: [
                                { $eq: ['$status', PaymentStatus.SUCCESS] },
                                1,
                                0,
                            ],
                        },
                    },

                    declined: {
                        $sum: {
                            $cond: [
                                { $eq: ['$status', PaymentStatus.VOIDED] },
                                1,
                                0,
                            ],
                        },
                    },

                    pending: {
                        $sum: {
                            $cond: [
                                { $eq: ['$status', PaymentStatus.PENDING] },
                                1,
                                0,
                            ],
                        },
                    },

                    total: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    successful: 1,
                    declined: 1,
                    pending: 1,
                    total: 1,
                },
            },
        ]);
    }

   async getCompanyPaymentCount(companyId: string) {
    return this.paymentModel.countDocuments({
        companyId: new Types.ObjectId(companyId),
    });
}



    async getCompanyPaymentSummary(companyId: string) {

        /*
        return this.paymentModel.findOne({
            companyId: new Types.ObjectId(companyId),
        });
        */
       return this.paymentModel.aggregate([
            {
                $match: {
                    companyId: new Types.ObjectId(companyId),
                    status: PaymentStatus.SUCCESS,
                },
            },
            {
                $group: {
                    _id: '$currency',
                    totalAmount: { $sum: '$amount' },
                    paymentCount: { $sum: 1 },

                },
               
            },

           {
               $project: {
                   _id: 0,
                   currency: "$_id",
                   totalAmount: "$totalAmount",
                   paymentCount: "$paymentCount",
               },
           }
        ]);

        
    }

}