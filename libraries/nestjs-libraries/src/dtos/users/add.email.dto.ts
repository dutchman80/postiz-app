import { IsDefined, IsEmail } from 'class-validator';

export class AddEmailDto {
  @IsDefined()
  @IsEmail()
  email: string;
}
