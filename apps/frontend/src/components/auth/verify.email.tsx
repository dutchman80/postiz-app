'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export const VerifyEmail = () => {
  const fetch = useFetch();
  const params = useParams();
  const t = useT();
  const [verified, setVerified] = useState<boolean | null>(null);
  const run = useRef(false);

  useEffect(() => {
    if (!run.current) {
      run.current = true;
      verify();
    }
  }, []);

  const verify = useCallback(async () => {
    const response = await fetch('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({
        code: params.code,
      }),
    });
    const { verified } = await response.json();
    setVerified(!!verified);
  }, []);

  if (verified === null) {
    return <LoadingComponent />;
  }

  return (
    <div className="flex flex-col flex-1">
      <h1 className="text-3xl font-bold text-start mb-4">
        {verified
          ? t('email_verified', 'Email address verified')
          : t(
              'email_verification_failed',
              'This verification link is invalid or has expired'
            )}
      </h1>
      <div className="text-textColor">
        {verified
          ? t(
              'email_verified_description',
              'You can now sign in with this email address.'
            )
          : t(
              'email_verification_failed_description',
              'Request a new verification email from your settings.'
            )}
      </div>
      <p className="mt-4 text-sm">
        <Link href="/auth/login" className="underline cursor-pointer">
          {t('go_to_login', 'Go to Login')}
        </Link>
      </p>
    </div>
  );
};
