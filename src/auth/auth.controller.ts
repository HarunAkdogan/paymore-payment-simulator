
import {
    Body,
    Controller,
    Post,
} from '@nestjs/common';
import {
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import {
    IsEmail,
    IsMongoId,
    IsString,
    MinLength,
} from 'class-validator';

import { AuthService } from './auth.service';

class RegisterDto {
    @IsEmail()
    email!: string;

    @IsString()
    @MinLength(8)
    password!: string;

    @IsMongoId()
    companyId!: string;
}

class LoginDto {
    @IsEmail()
    email!: string;

    @IsString()
    @MinLength(8)
    password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    @Post('register')
    @ApiOperation({ summary: 'Register a user' })
    register(@Body() dto: RegisterDto) {
        return this.authService.register(
            dto.email,
            dto.password,
            dto.companyId,
        );
    }

    @Post('login')
    @ApiOperation({ summary: 'User login' })
    login(@Body() dto: LoginDto) {
        return this.authService.login(dto.email, dto.password);
    }
}
