import { internalFetch } from '@gitroom/helpers/utils/internal.fetch';
import { cookies } from 'next/headers';
export const dynamic = 'force-dynamic';
import { Register } from '@gitroom/frontend/components/auth/register';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import Link from 'next/link';
import { getT } from '@gitroom/react/translation/get.translation.service.backend';
import { LoginWithOidc } from '@gitroom/frontend/components/auth/login.with.oidc';
export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Register`,
  description: '',
};
export default async function Auth(params: {searchParams: Promise<{provider: string}>}) {
  const t = await getT();
  if (process.env.DISABLE_REGISTRATION === 'true') {
    const canRegister = (
      await (await internalFetch('/auth/can-register')).json()
    ).register;
    if (!canRegister && !(await params?.searchParams)?.provider) {
      return (
        <>
          <LoginWithOidc />
          <div className="text-center">
            {t('registration_is_disabled', 'Registration is disabled')}
            <br />
            <Link className="underline hover:font-bold" href="/auth/login">
              {t('login_instead', 'Login instead')}
            </Link>
          </div>
        </>
      );
    }
  }
  return <Register inviteOrgName={await getInviteOrgName()} />;
}

// the invite token lives in the httpOnly "org" cookie set by proxy.ts,
// so only the server can tell the register form which team is being joined
async function getInviteOrgName(): Promise<string | null> {
  const org = (await cookies()).get('org')?.value;
  if (!org) {
    return null;
  }

  try {
    const { name } = await (
      await internalFetch('/auth/invite', {
        method: 'POST',
        body: JSON.stringify({ org }),
      })
    ).json();
    return name || null;
  } catch (err) {
    return null;
  }
}
