
import {
    Body,
    Controller,
    Get,
    Headers,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { RateLimitGuard } from '../common/rate-limit.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundDto } from './dto/refund.dto';
import { PaymentsService } from './payments.service';
import { PaymentAnalyticsService } from './payment-analytics.service';
import { Query } from '@nestjs/common';


interface AuthenticatedRequest extends Request {
    user: {
        sub: string;
        companyId: string;
    };
}

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
@UseGuards(RateLimitGuard, JwtAuthGuard)
export class PaymentsController {
    constructor(private readonly payments: PaymentsService, private readonly paymentAnalyticsService: PaymentAnalyticsService,) { }

    @Post()
    @ApiHeader({ name: 'Idempotency-Key', required: true })
    @ApiOperation({ summary: 'Create a simulated payment' })
    create(
        @Body() dto: CreatePaymentDto,
        @Headers('idempotency-key') key: string,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.payments.create(
            { ...dto, companyId: req.user.companyId },
            key,
        );
    }

    @Get(':id')
    get(
        @Param('id') id: string,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.payments.findOne(id, req.user.companyId);
    }

    @Get()
    list(
        @Req() req: AuthenticatedRequest,
        @Query('page') page: string = '1',
        @Query('limit') limit: string = '10',
    ) {
        return this.payments.listByCompany(
            req.user.companyId,
            Number(page),
            Number(limit),
        );
    }

    @Post(':id/inquiry')
    inquiry(
        @Param('id') id: string,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.payments.inquiry(id, req.user.companyId);
    }

    @Post(':id/void')
    void(
        @Param('id') id: string,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.payments.void(id, req.user.companyId);
    }

    @Get('analytics/paymentsuccessful')
    getSuccessfulPayments(@Req() req: AuthenticatedRequest) {
        return this.paymentAnalyticsService.getSuccessfulPayments(
            req.user.companyId,
        );

    }


    @Get('analytics/date-range')
    getCompanyPaymentsByDate(
        @Req() req: AuthenticatedRequest,
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
    ) {
        return this.paymentAnalyticsService.getCompanyPaymentsByDate(
            req.user.companyId,
            new Date(startDate),
            new Date(endDate),
        );
    }


    
    @Get('analytics/paymentlatest')
    getLatestCompanyPayments(@Req() req: AuthenticatedRequest) {
        return this.paymentAnalyticsService.getLatestCompanyPayments(
            req.user.companyId,
        );

    }

    @Get('analytics/paymentcount')
    getCompanyPaymentCount(@Req() req: AuthenticatedRequest) {
        return this.paymentAnalyticsService.getCompanyPaymentCount(
            req.user.companyId,
        );

    }

    @Get('analytics/paymentstatuscount')
    getCompanyPaymentStatusCount(@Req() req: AuthenticatedRequest) {
        return this.paymentAnalyticsService.getCompanyPaymentStatusCounts(
            req.user.companyId,
        );

    }

    @Get('analytics/summary')
    getCompanyPaymentSummary(@Req() req: AuthenticatedRequest) {
        return this.paymentAnalyticsService.getCompanyPaymentSummary(
            req.user.companyId,
        );

    }

 

    @Post(':id/refund')
    @ApiHeader({ name: 'Idempotency-Key', required: true })
    @ApiOperation({ summary: 'Refund a payment' })
    refund(
        @Param('id') id: string,
        @Body() dto: RefundDto,
        @Headers('idempotency-key') key: string,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.payments.refund(
            id,
            req.user.companyId,
            dto.amount,
            key,
        );
    }

    
}
