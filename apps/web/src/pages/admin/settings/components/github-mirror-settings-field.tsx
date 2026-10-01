import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useFormContext } from 'react-hook-form';
import { CheckCircle2, Loader2, XCircle, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { isValidHttpUrl, type SettingsForm } from '../settings-schema';
import type { SystemSettings } from '../settings-types';
interface GithubMirrorTestItem {
  url: string;
  label: string;
  isOfficial: boolean;
  available: boolean;
  latencyMs: number | null;
  bytesRead: number;
  speedBps: number | null;
  error?: string;
}

interface GithubMirrorTestResponse {
  targetAssetUrl: string;
  recommendedUrl: string;
  recommendedIsOfficial: boolean;
  items: GithubMirrorTestItem[];
}

const PRESET_GITHUB_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/'];

function normalizeMirrorKey(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function GithubMirrorSettingsField() {
  const { t } = useTranslation(['admin', 'common']);
  const queryClient = useQueryClient();
  const { control, watch, setValue, resetField } = useFormContext<SettingsForm>();
  const mirrorText = watch('githubMirrorUrlsText') ?? '';
  const repoUrl = watch('githubRepoUrl') ?? '';

  const currentMirrors = useMemo(
    () =>
      mirrorText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [mirrorText]
  );

  const primaryMirror = currentMirrors[0] ?? null;

  const testMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<GithubMirrorTestResponse>(
          '/admin/binary-resources/github-mirrors/test',
          {
            repoUrl: repoUrl.trim() || undefined,
            mirrorUrls: currentMirrors
          },
          { timeout: 25_000 }
        )
      ).data,
    onSuccess: (data) => {
      const hasAvailable = data.items.some((item) => item.available);
      if (hasAvailable) {
        toast.success(t('admin:settings.toastMirrorTestDone', { source: data.recommendedUrl }));
      } else {
        toast.warning(t('admin:settings.toastMirrorTestAllFailed'));
      }
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error, t('admin:settings.toastMirrorTestFailed')));
    }
  });

  const applyDefaultSourceMutation = useMutation({
    mutationFn: async ({ nextMirrors, sourceLabel }: { nextMirrors: string[]; sourceLabel: string }) => {
      const trimmedRepoUrl = repoUrl.trim();
      const updated = (
        await api.put<SystemSettings>('/admin/settings', {
          ...(trimmedRepoUrl && isValidHttpUrl(trimmedRepoUrl) ? { githubRepoUrl: trimmedRepoUrl } : {}),
          githubMirrorUrls: nextMirrors
        })
      ).data;
      return { updated, sourceLabel, nextMirrors, trimmedRepoUrl };
    },
    onSuccess: ({ nextMirrors, sourceLabel, trimmedRepoUrl }) => {
      resetField('githubMirrorUrlsText', { defaultValue: nextMirrors.join('\n') });
      if (trimmedRepoUrl && isValidHttpUrl(trimmedRepoUrl)) {
        resetField('githubRepoUrl', { defaultValue: trimmedRepoUrl });
      }
      toast.success(t('admin:settings.toastDefaultMirrorSaved', { source: sourceLabel }));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'binary-resources'] });
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error, t('admin:settings.saveFailed')));
    }
  });

  const handleSelectDefaultSource = (item: { url: string; label: string; isOfficial: boolean }) => {
    if (item.isOfficial) {
      applyDefaultSourceMutation.mutate({
        nextMirrors: [],
        sourceLabel: item.label
      });
      return;
    }
    const failedSet = new Set(
      (testMutation.data?.items ?? [])
        .filter((candidate) => !candidate.isOfficial && !candidate.available)
        .map((candidate) => normalizeMirrorKey(candidate.url))
    );
    const chosenKey = normalizeMirrorKey(item.url);
    const remaining = currentMirrors.filter((m) => {
      const key = normalizeMirrorKey(m);
      return key !== chosenKey && !failedSet.has(key);
    });
    const nextMirrors = [item.url.endsWith('/') ? item.url : `${item.url}/`, ...remaining];
    applyDefaultSourceMutation.mutate({
      nextMirrors,
      sourceLabel: item.label
    });
  };

  const bestItem = testMutation.data?.items.find(
    (item) => item.available && normalizeMirrorKey(item.url) === normalizeMirrorKey(testMutation.data?.recommendedUrl ?? '')
  );

  return (
    <div className="space-y-3 rounded-lg border bg-muted/15 p-4 min-w-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between min-w-0">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FormLabel className="text-sm font-semibold">{t('admin:settings.fieldGithubMirrorUrlsText')}</FormLabel>
            <Badge variant="outline" className="font-mono text-xs">
              {t('admin:settings.githubMirrorDefaultLabel')}
              {primaryMirror ? primaryMirror : t('admin:settings.githubMirrorOfficialDirect')}
            </Badge>
            {primaryMirror ? (
              <span className="text-[11px] text-muted-foreground">{t('admin:settings.githubMirrorFallbackHint')}</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate()}
          >
            {testMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
            {testMutation.isPending ? t('admin:settings.testingGithubMirrors') : t('admin:settings.btnTestGithubMirrors')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={applyDefaultSourceMutation.isPending || currentMirrors.length === 0}
            onClick={() =>
              handleSelectDefaultSource({
                url: 'https://github.com',
                label: t('admin:settings.githubMirrorOfficialDirect'),
                isOfficial: true
              })
            }
          >
            {t('admin:settings.btnUseOfficialDirect')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setValue('githubMirrorUrlsText', PRESET_GITHUB_MIRRORS.join('\n'), { shouldDirty: true })}
          >
            {t('admin:settings.btnRestoreDefaultMirrors')}
          </Button>
        </div>
      </div>

      <FormField
        control={control}
        name="githubMirrorUrlsText"
        render={({ field }) => (
          <FormItem className="min-w-0">
            <FormControl>
              <Textarea
                {...field}
                rows={3}
                className="min-w-0 font-mono text-xs"
                value={String(field.value ?? '')}
                placeholder={PRESET_GITHUB_MIRRORS.join('\n')}
              />
            </FormControl>
            <FormDescription className="break-words">{t('admin:settings.descGithubMirrorUrlsText')}</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      {testMutation.data ? (
        <div className="space-y-2.5 rounded-md border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">{t('admin:settings.mirrorTestResultTitle')}</span>
            {bestItem ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 text-xs"
                disabled={applyDefaultSourceMutation.isPending}
                onClick={() => handleSelectDefaultSource(bestItem)}
              >
                {t('admin:settings.btnApplyBestMirror', { source: bestItem.label })}
              </Button>
            ) : null}
          </div>
          <div className="divide-y rounded-md border">
            {testMutation.data.items.map((item) => {
              const isCurrentDefault = item.isOfficial
                ? currentMirrors.length === 0
                : Boolean(primaryMirror && normalizeMirrorKey(primaryMirror) === normalizeMirrorKey(item.url));
              const isRecommended =
                item.available &&
                normalizeMirrorKey(item.url) === normalizeMirrorKey(testMutation.data?.recommendedUrl ?? '');

              return (
                <div
                  key={item.url}
                  className="flex flex-col gap-2 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {item.available ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <XCircle className="size-3.5 shrink-0 text-destructive" />
                    )}
                    <span className="truncate font-mono font-medium text-foreground">{item.label}</span>
                    {item.isOfficial ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {t('admin:settings.mirrorTestOfficialBadge')}
                      </Badge>
                    ) : null}
                    {isCurrentDefault ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t('admin:settings.mirrorTestCurrentDefaultBadge')}
                      </Badge>
                    ) : null}
                    {isRecommended ? (
                      <Badge className="bg-emerald-600 text-[10px] text-white hover:bg-emerald-600">
                        {t('admin:settings.mirrorTestBestBadge')}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {item.available ? (
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        {t('admin:settings.mirrorTestAvailable', {
                          latency: item.latencyMs ?? 0,
                          speed: formatBytes(item.speedBps ?? 0)
                        })}
                      </span>
                    ) : (
                      <span className="text-destructive">
                        {t('admin:settings.mirrorTestUnavailable', { error: item.error ?? 'Timeout' })}
                      </span>
                    )}
                    <Button
                      type="button"
                      variant={isCurrentDefault ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={applyDefaultSourceMutation.isPending || isCurrentDefault}
                      onClick={() => handleSelectDefaultSource(item)}
                    >
                      {isCurrentDefault
                        ? t('admin:settings.mirrorTestCurrentDefaultBadge')
                        : t('admin:settings.btnSetDefaultMirror')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
