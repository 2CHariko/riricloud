import * as React from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Check, CloudDownload, ExternalLink, Link2, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { formatDateTime } from '@/lib/utils';
import { extractErrorMessage } from '@/lib/api';
import { BINARY_STATUS_LABELS, bytes, formatTargetBadge } from '../binary-labels';
import {
  resolveSupportedTargets,
  useBinaryResourceMutations,
  useGithubReleases,
  type BinaryStatus,
  type GithubReleaseItem
} from '../use-binaries';

const OS_LABELS: Record<string, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };

function targetLabel(target: string) {
  const [, os, arch] = target.split('-');
  return `Agent · ${OS_LABELS[os] ?? os} ${(arch ?? '').toUpperCase()}`;
}

interface UrlImportFormValues {
  url: string;
  upstreamVersion: string;
  target: string;
  notes: string;
}

const EMPTY_URL_VALUES: UrlImportFormValues = {
  url: '',
  upstreamVersion: '',
  target: 'AUTO',
  notes: ''
};

export function GithubReleaseDialog({
  open,
  onOpenChange,
  supportedTargets
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supportedTargets?: string[];
}) {
  const { t } = useTranslation(['admin', 'common']);
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<'github' | 'url'>('github');
  const releasesQuery = useGithubReleases({ enabled: open && activeTab === 'github' });
  const { importGithubRelease, importResource } = useBinaryResourceMutations();
  const [activePullKey, setActivePullKey] = React.useState<string | null>(null);
  const targets = resolveSupportedTargets(supportedTargets);

  const syncMainTable = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['admin', 'binary-resources'],
      predicate: (query) => query.queryKey[2] !== 'github-releases'
    });
  }, [queryClient]);

  React.useEffect(() => {
    if (open && releasesQuery.dataUpdatedAt) {
      syncMainTable();
    }
  }, [open, releasesQuery.dataUpdatedAt, syncMainTable]);

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      syncMainTable();
    }
    onOpenChange(nextOpen);
  };

  const urlSchema = React.useMemo(
    () =>
      z.object({
        url: z
          .string()
          .trim()
          .min(1, t('admin:binaries.valUrlRequired'))
          .refine((val) => /^https?:\/\//i.test(val), t('admin:binaries.valUrlInvalid')),
        upstreamVersion: z.string().trim().max(64, t('admin:binaries.valUpstreamMax')),
        target: z.string(),
        notes: z.string().trim().max(2000, t('admin:binaries.notesMax'))
      }),
    [t]
  );

  const urlForm = useForm<UrlImportFormValues>({
    resolver: zodResolver(urlSchema),
    defaultValues: EMPTY_URL_VALUES
  });

  useFormResetOnKey({
    open,
    resetKey: 'remote-import',
    reset: () => {
      setActiveTab('github');
      urlForm.reset(EMPTY_URL_VALUES);
    }
  });

  const handlePullRelease = (release: GithubReleaseItem, selectedTargets?: string[]) => {
    const pullKey = selectedTargets?.length === 1 ? `${release.tagName}:${selectedTargets[0]}` : `${release.tagName}:ALL`;
    setActivePullKey(pullKey);
    importGithubRelease.mutate(
      {
        tagName: release.tagName,
        ...(selectedTargets?.length ? { targets: selectedTargets } : {})
      },
      {
        onSettled: () => setActivePullKey(null)
      }
    );
  };

  const handleUrlSubmit = urlForm.handleSubmit((values) => {
    importResource.mutate(
      {
        url: values.url.trim(),
        ...(values.upstreamVersion.trim() ? { upstreamVersion: values.upstreamVersion.trim() } : {}),
        ...(values.target && values.target !== 'AUTO' ? { target: values.target } : {}),
        ...(values.notes.trim() ? { notes: values.notes.trim() } : {})
      },
      {
        onSuccess: () => handleDialogOpenChange(false)
      }
    );
  });

  const releases = releasesQuery.data?.releases ?? [];
  const currentRepoUrl = releasesQuery.data?.repoUrl || __DEFAULT_GITHUB_REPO_URL__;
  const primaryMirror = releasesQuery.data?.githubMirrorUrls?.[0]?.trim() || '';

  return (
    <ResponsiveDialog open={open} onOpenChange={handleDialogOpenChange}>
      <ResponsiveDialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{t('admin:binaries.githubDialogTitle')}</DialogTitle>
          <DialogDescription>{t('admin:binaries.githubDialogDesc')}</DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as 'github' | 'url')} className="min-w-0 space-y-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="github" className="gap-1.5">
              <CloudDownload className="size-4" />
              {t('admin:binaries.tabGithubRelease')}
            </TabsTrigger>
            <TabsTrigger value="url" className="gap-1.5">
              <Link2 className="size-4" />
              {t('admin:binaries.tabUrlImport')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="github" className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-muted-foreground">{t('admin:binaries.githubCurrentRepo')}</span>
                  <a
                    href={currentRepoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 truncate font-mono font-medium text-foreground hover:underline"
                  >
                    <span className="truncate">{currentRepoUrl}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </div>
                <div className="flex min-w-0 items-center gap-1">
                  <span className="text-muted-foreground">{t('admin:binaries.githubCurrentSource')}</span>
                  <span className="truncate font-mono text-foreground">
                    {primaryMirror || t('admin:binaries.githubOfficialSource')}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  to="/admin/settings"
                  onClick={() => handleDialogOpenChange(false)}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Settings2 className="size-3.5" />
                  {t('admin:binaries.githubGoSettings')}
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={releasesQuery.isFetching}
                  onClick={() => {
                    void releasesQuery.refetch();
                    syncMainTable();
                  }}
                >
                  <RefreshCw className={`mr-1.5 size-3.5 ${releasesQuery.isFetching ? 'animate-spin' : ''}`} />
                  {t('admin:binaries.githubRefresh')}
                </Button>
              </div>
            </div>

            {releasesQuery.isPending ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : releasesQuery.isError ? (
              <EmptyState
                title={t('admin:binaries.githubLoadFailedTitle')}
                description={extractErrorMessage(releasesQuery.error, t('admin:binaries.githubEmptyDesc'))}
              />
            ) : releases.length === 0 ? (
              <EmptyState
                title={t('admin:binaries.githubEmptyTitle')}
                description={t('admin:binaries.githubEmptyDesc')}
              />
            ) : (
              <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                {releases.map((release) => {
                  const importedCount = release.assets.filter((item) => item.imported).length;
                  const totalCount = release.assets.length;
                  const allImported = totalCount > 0 && importedCount === totalCount;
                  const missingTargets = release.assets.filter((item) => !item.imported).map((item) => item.target);
                  const isPullingAll = activePullKey === `${release.tagName}:ALL`;

                  return (
                    <div key={release.tagName} className="space-y-3 rounded-lg border p-3.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-foreground">{release.name || release.tagName}</span>
                            <Badge variant="outline" className="font-mono text-xs">
                              v{release.version}
                            </Badge>
                            {release.prerelease ? (
                              <Badge variant="secondary" className="text-xs">
                                {t('admin:binaries.githubPrerelease')}
                              </Badge>
                            ) : null}
                            {release.existingStatus ? (
                              <Badge variant={release.existingStatus === 'ACTIVE' ? 'default' : 'secondary'} className="text-xs">
                                {BINARY_STATUS_LABELS[release.existingStatus as BinaryStatus] ?? release.existingStatus}
                              </Badge>
                            ) : null}
                            {allImported ? (
                              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-400">
                                <Check className="mr-1 size-3" />
                                {t('admin:binaries.githubImportedBadge')}
                              </Badge>
                            ) : importedCount > 0 ? (
                              <Badge variant="outline" className="text-xs">
                                {t('admin:binaries.githubPartialBadge', { imported: importedCount, total: totalCount })}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            {release.publishedAt ? (
                              <span>{t('admin:binaries.githubPublishedAt', { time: formatDateTime(release.publishedAt) })}</span>
                            ) : null}
                            {release.htmlUrl ? (
                              <a
                                href={release.htmlUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                              >
                                {release.tagName}
                                <ExternalLink className="size-3" />
                              </a>
                            ) : null}
                          </div>
                        </div>

                        <Button
                          size="sm"
                          variant={allImported ? 'outline' : 'default'}
                          disabled={importGithubRelease.isPending}
                          onClick={() =>
                            handlePullRelease(
                              release,
                              !allImported && importedCount > 0 ? missingTargets : undefined
                            )
                          }
                        >
                          {isPullingAll ? (
                            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <CloudDownload className="mr-1.5 size-3.5" />
                          )}
                          {isPullingAll
                            ? t('admin:binaries.githubPulling')
                            : allImported
                              ? t('admin:binaries.githubRePullAll')
                              : importedCount > 0
                                ? t('admin:binaries.githubPullMissing', { count: missingTargets.length })
                                : t('admin:binaries.githubPullAll', { count: totalCount })}
                        </Button>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {release.assets.map((asset) => {
                          const isPullingTarget = activePullKey === `${release.tagName}:${asset.target}`;
                          return (
                            <Button
                              key={asset.target}
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={importGithubRelease.isPending}
                              onClick={() => handlePullRelease(release, [asset.target])}
                              className={`h-7 gap-1.5 px-2.5 font-mono text-xs ${
                                asset.imported
                                  ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                                  : ''
                              }`}
                            >
                              {isPullingTarget ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : asset.imported ? (
                                <Check className="size-3" />
                              ) : (
                                <CloudDownload className="size-3" />
                              )}
                              <span>{formatTargetBadge(asset.target)}</span>
                              {asset.size > 0 ? (
                                <span className="text-[10px] text-muted-foreground">{bytes(asset.size)}</span>
                              ) : null}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="url" className="min-w-0">
            <Form {...urlForm}>
              <form className="space-y-4" onSubmit={handleUrlSubmit}>
                <FormField
                  control={urlForm.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:binaries.urlLabel')}</FormLabel>
                      <FormControl>
                        <Input type="url" {...field} placeholder={t('admin:binaries.urlPlaceholder')} />
                      </FormControl>
                      <FormDescription>{t('admin:binaries.urlDesc')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    control={urlForm.control}
                    name="upstreamVersion"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('admin:binaries.upstreamVersionLabel')}</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder={t('admin:binaries.upstreamVersionPlaceholder')} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={urlForm.control}
                    name="target"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('admin:binaries.targetLabel')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="AUTO">{t('admin:binaries.targetAutoDetect')}</SelectItem>
                            {targets.map((target) => (
                              <SelectItem key={target} value={target}>
                                {targetLabel(target)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={urlForm.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:binaries.notesLabel')}</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder={t('admin:binaries.notesPlaceholder')} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button type="submit" disabled={importResource.isPending}>
                    {importResource.isPending ? t('admin:binaries.processing') : t('admin:binaries.formImportTitle')}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </TabsContent>
        </Tabs>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

