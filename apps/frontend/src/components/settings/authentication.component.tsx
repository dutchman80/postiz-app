'use client';

import React, { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { FormProvider, useForm } from 'react-hook-form';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { AddEmailDto } from '@gitroom/nestjs-libraries/dtos/users/add.email.dto';

interface UserEmail {
  id: string;
  email: string;
  verifiedAt: string | null;
}

export const useEmails = () => {
  const fetch = useFetch();

  const load = useCallback(async () => {
    return (await fetch('/user/emails')).json();
  }, []);

  return useSWR<UserEmail[]>('user-emails', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });
};

export const AddEmail = ({ onAdded }: { onAdded: () => Promise<any> }) => {
  const modals = useModals();
  const fetch = useFetch();
  const toast = useToaster();
  const t = useT();
  const resolver = useMemo(() => {
    return classValidatorResolver(AddEmailDto);
  }, []);
  const form = useForm({
    values: {
      email: '',
    },
    resolver,
    mode: 'onChange',
  });

  const submit = useCallback(
    async (values: { email: string }) => {
      const response = await fetch('/user/emails', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const { message } = await response.json().catch(() => ({} as any));
        toast.show(
          (Array.isArray(message) ? message[0] : message) ||
            t('could_not_add_email', 'Could not add the email address'),
          'warning'
        );
        return;
      }
      await onAdded();
      modals.closeAll();
      toast.show(
        t(
          'verification_email_sent',
          'Verification email sent, check your inbox'
        )
      );
    },
    [onAdded, t]
  );

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <div className="relative flex gap-[10px] flex-col flex-1 p-[16px] pt-0">
          <Input
            label="Email"
            translationKey="label_email"
            placeholder={t('enter_email', 'Enter email')}
            name="email"
            type="email"
          />
          <Button type="submit" className="mt-[18px]">
            {t('send_verification_email', 'Send Verification Email')}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
};

const AuthenticationComponent = () => {
  const t = useT();
  const fetch = useFetch();
  const toast = useToaster();
  const modals = useModals();
  const user = useUser();
  const { data, mutate } = useEmails();
  const primary = user?.email?.toLowerCase();

  const addEmail = useCallback(() => {
    modals.openModal({
      classNames: {
        modal: 'bg-transparent text-textColor',
      },
      title: t('top_title_add_email', 'Add Email Address'),
      withCloseButton: true,
      children: <AddEmail onAdded={mutate} />,
    });
  }, [t, mutate]);

  const showError = useCallback(
    async (response: Response, fallback: string) => {
      const { message } = await response.json().catch(() => ({} as any));
      toast.show(
        (Array.isArray(message) ? message[0] : message) || fallback,
        'warning'
      );
    },
    []
  );

  const resend = useCallback(
    (email: UserEmail) => async () => {
      const response = await fetch(`/user/emails/${email.id}/resend`, {
        method: 'POST',
      });
      if (!response.ok) {
        await showError(
          response,
          t(
            'could_not_send_verification',
            'Could not send the verification email'
          )
        );
        return;
      }
      toast.show(
        t(
          'verification_email_sent',
          'Verification email sent, check your inbox'
        )
      );
    },
    [t]
  );

  const remove = useCallback(
    (email: UserEmail) => async () => {
      if (
        !(await deleteDialog(
          t(
            'are_you_sure_remove_email',
            'Are you sure you want to remove this email address?'
          )
        ))
      ) {
        return;
      }
      const response = await fetch(`/user/emails/${email.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        await showError(
          response,
          t('could_not_remove_email', 'Could not remove the email address')
        );
        return;
      }
      await mutate();
    },
    [t]
  );

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[24px]">
      <div className="flex flex-col gap-[4px]">
        <div className="mt-[4px]">
          {t('sign_in_emails', 'Sign-in email addresses')}
        </div>
        <div className="text-[14px] text-textItemBlur">
          {t(
            'sign_in_emails_description',
            'Sign in with any verified address, using your password or a provider such as Google that uses that address.'
          )}
        </div>
      </div>
      <div className="flex flex-col gap-[16px]">
        {(Array.isArray(data) ? data : []).map((email) => (
          <div key={email.id} className="flex items-center gap-[12px]">
            <div className="flex-1 text-[14px]">{email.email}</div>
            <div className="flex-1 text-[14px] text-textItemBlur">
              {email.email === primary
                ? t('primary', 'Primary')
                : email.verifiedAt
                ? t('verified', 'Verified')
                : t('pending_verification', 'Pending verification')}
            </div>
            <div className="flex-1 flex justify-end gap-[8px]">
              {!email.verifiedAt && (
                <Button
                  className="!bg-customColor3 !h-[24px] border border-customColor21 rounded-[4px] text-[12px]"
                  onClick={resend(email)}
                  secondary={true}
                >
                  {t('resend', 'Resend')}
                </Button>
              )}
              {email.email !== primary && (
                <Button
                  className="!bg-customColor3 !h-[24px] border border-customColor21 rounded-[4px] text-[12px]"
                  onClick={remove(email)}
                  secondary={true}
                >
                  {t('remove', 'Remove')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div>
        <Button onClick={addEmail}>
          {t('add_email_address', 'Add email address')}
        </Button>
      </div>
    </div>
  );
};

export default AuthenticationComponent;
