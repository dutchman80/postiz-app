'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useCallback } from 'react';
import useSWR from 'swr';

export const useAllOrgsIntegrations = (enabled: boolean) => {
  const fetch = useFetch();

  const load = useCallback(async (path: string) => {
    return (await (await fetch(path)).json()).integrations;
  }, []);

  return useSWR(enabled ? '/user/all/integrations' : null, load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });
};
