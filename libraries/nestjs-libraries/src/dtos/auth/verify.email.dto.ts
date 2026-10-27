import { IsDefined, IsString } from 'class-validator';

export class VerifyEmailDto {
  @IsDefined()
  @IsString()
  code: string;
}
