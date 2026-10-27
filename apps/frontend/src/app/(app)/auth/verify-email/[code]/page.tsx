export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { VerifyEmail } from '@gitroom/frontend/components/auth/verify.email';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
export const metadata: Metadata = {
  title: `${
    isGeneralServerSide() ? 'Postiz' : 'Gitroom'
  } - Verify your email address`,
  description: '',
};
export default async function Auth() {
  return <VerifyEmail />;
}
