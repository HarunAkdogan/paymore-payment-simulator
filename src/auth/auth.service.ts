
import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';
import { compare, hash } from 'bcryptjs';

import { User, UserDocument } from '../users/user.schema';

@Injectable()
export class AuthService {
    constructor(
        @InjectModel(User.name)
        private readonly users: Model<UserDocument>,
        private readonly jwtService: JwtService,
    ) { }

    async register(email: string, password: string, companyId: string) {
        if (!Types.ObjectId.isValid(companyId)) {
            throw new BadRequestException('Invalid companyId');
        }

        const normalizedEmail = email.toLowerCase().trim();

        const existingUser = await this.users.findOne({
            email: normalizedEmail,
        });

        if (existingUser) {
            throw new ConflictException('Email already registered');
        }

        const passwordHash = await hash(password, 12);

        const user = await this.users.create({
            email: normalizedEmail,
            passwordHash,
            companyId: new Types.ObjectId(companyId),
        });

        return {
            id: user._id.toString(),
            email: user.email,
            companyId: user.companyId.toString(),
        };
    }

    async login(email: string, password: string) {
        const user = await this.users
            .findOne({ email: email.toLowerCase().trim() })
            .lean();

        if (!user || !user.isActive) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const passwordIsValid = await compare(
            password,
            user.passwordHash,
        );

        if (!passwordIsValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const payload = {
            sub: user._id.toString(),
            companyId: user.companyId.toString(),
        };

        const accessToken = await this.jwtService.signAsync(payload);

        return {
            accessToken,
            tokenType: 'Bearer',
            expiresIn: '15m',
        };
    }
}
