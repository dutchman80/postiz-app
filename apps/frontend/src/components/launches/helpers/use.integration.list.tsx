'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useCallback } from 'react';
import useSWR from 'swr';

export const useIntegrationList = (enabled = true) => {
  const fetch = useFetch();

  const load = useCallback(async (path: string) => {
    return (await (await fetch(path)).json()).integrations;
  }, []);

  return useSWR(enabled ? '/integrations/list' : null, load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });
};