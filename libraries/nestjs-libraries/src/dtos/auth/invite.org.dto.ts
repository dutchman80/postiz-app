import { IsDefined, IsString } from 'class-validator';

export class InviteOrgDto {
  @IsString()
  @IsDefined()
  org: string;
}
