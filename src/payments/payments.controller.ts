
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
    constructor(private readonly payments: PaymentsService) { }

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
    list(@Req() req: AuthenticatedRequest) {
        return this.payments.listByCompany(req.user.companyId);
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

    @Post(':id/refund')
    refund(
        @Param('id') id: string,
        @Body() dto: RefundDto,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.payments.refund(
            id,
            req.user.companyId,
            dto.amount,
        );
    }
}
