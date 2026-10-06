import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFormContext } from 'react-hook-form';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { Database, Gauge, Globe2, Mail, Palette, RefreshCw, Send, ShieldCheck, Trash2, UsersRound } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import type { SettingsForm } from '../settings-schema';
import type { DatabaseStatsResponse } from '@/components/shared/telemetry-cleanup-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { SettingsInput, SettingsSwitch, SettingsSelect, SettingsTextarea, SettingsEditor, SetOriginButton, SectionTitle } from './settings-fields';
import { TimezoneSettingField } from './timezone-setting-field';
import { GithubMirrorSettingsField } from './github-mirror-settings-field';
import { ProbePresetEditor } from './probe-preset-editor';
import { SpeedTierEditor } from './speed-tier-editor';
import { LandingSettingsTab } from './landing-settings-tab';
interface SettingsTabsProps {
  publicPlans: Array<{ id: string; name: string }>;
  defaultTemplate?: { name: string; description: string | null };
  dbStatsQuery: { isLoading: boolean; data?: DatabaseStatsResponse };
  vacuumMutation: { isPending: boolean; mutate: () => void };
  smtpTestMutation: { isPending: boolean };
  setSmtpTestOpen: (open: boolean) => void;
  setCleanupOpen: (open: boolean) => void;
}
export function SettingsTabs({ publicPlans, defaultTemplate, dbStatsQuery, vacuumMutation, smtpTestMutation, setSmtpTestOpen, setCleanupOpen }: SettingsTabsProps) {
  const { t } = useTranslation(['admin', 'common']);
  const form = useFormContext<SettingsForm>();
  return <>
            <TabsContent value="branding"><Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={Palette} title={t('admin:settings.sectionBranding')} description={t('admin:settings.sectionBrandingDesc')} /></CardHeader><CardContent className="grid min-w-0 gap-5 md:grid-cols-2">
               <SettingsInput name="siteName" label={t('admin:settings.fieldSiteName')} placeholder="RiriCloud" />
               <SettingsInput name="siteDescription" label={t('admin:settings.fieldSiteDesc')} placeholder={t('admin:settings.placeholderSiteDesc')} />
               <div className="space-y-2 md:col-span-2 min-w-0"><SettingsInput name="publicBaseUrl" label={t('admin:settings.fieldPublicBaseUrl')} placeholder="https://panel.example.com" description={t('admin:settings.descPublicBaseUrl')} /><SetOriginButton name="publicBaseUrl" /></div>
              <TimezoneSettingField />
              <SettingsInput name="logoUrl" label={t('admin:settings.fieldLogoUrl')} placeholder="https://cdn.example.com/logo.svg" description={t('admin:settings.descLogoUrl')} />
              <SettingsInput name="faviconUrl" label={t('admin:settings.fieldFaviconUrl')} placeholder="https://cdn.example.com/favicon.ico" />
              <SettingsInput name="footerCopyright" label={t('admin:settings.fieldFooterCopyright')} placeholder={t('admin:settings.placeholderFooterCopyright')} description={t('admin:settings.descFooterCopyright')} />
              <SettingsInput name="supportEmail" label={t('admin:settings.fieldSupportEmail')} placeholder="support@example.com" />
              <SettingsInput name="supportTelegramUrl" label={t('admin:settings.fieldSupportTg')} placeholder="https://t.me/riricloud" />
              <SettingsInput name="supportDiscordUrl" label={t('admin:settings.fieldSupportDiscord')} placeholder="https://discord.gg/example" />
              <SettingsInput name="supportCustomUrl" label={t('admin:settings.fieldSupportCustom')} placeholder="https://example.com/support" />
            </CardContent></Card></TabsContent>

            <TabsContent value="landing">
              <LandingSettingsTab />
            </TabsContent>

            <TabsContent value="users"><Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={UsersRound} title={t('admin:settings.sectionUsers')} description={t('admin:settings.sectionUsersDesc')} /></CardHeader><CardContent className="grid min-w-0 gap-5 md:grid-cols-2">
              <SettingsSwitch name="registrationEnabled" label={t('admin:settings.fieldRegistrationEnabled')} description={t('admin:settings.descRegistrationEnabled')} className="md:col-span-2" />
              <SettingsSelect name="defaultPlanId" label={t('admin:settings.fieldDefaultPlanId')} options={[{ value: 'none', label: t('admin:settings.optNoAutoPlan') }, ...publicPlans.map((plan) => ({ value: plan.id, label: plan.name }))]} description={t('admin:settings.descDefaultPlanId')} />
              <SettingsInput name="defaultBalanceYuan" label={t('admin:settings.fieldDefaultBalanceYuan')} type="number" min={0} description={t('admin:settings.descDefaultBalanceYuan')} />
              <div className="rounded-lg border border-dashed bg-muted/30 p-3.5 text-xs text-muted-foreground md:col-span-2 space-y-1 min-w-0">
                <p className="font-medium text-foreground">{t('admin:settings.noticeNewUserTrafficTitle')}</p>
                <p>{t('admin:settings.noticeNewUserTrafficDesc')}</p>
              </div>
              <SettingsInput name="passwordMinLength" label={t('admin:settings.fieldPasswordMinLength')} type="number" min={8} max={64} description={t('admin:settings.descPasswordMinLength')} />
              <div className="md:col-span-2 space-y-4 rounded-lg border p-4 shadow-sm">
                <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" /><div><h3 className="text-sm font-semibold">{t('admin:settings.sectionPasswordComplexity')}</h3><p className="text-xs text-muted-foreground">{t('admin:settings.descPasswordComplexity')}</p></div></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SettingsSwitch name="passwordRequireLowercase" label={t('admin:settings.fieldPasswordRequireLowercase')} description={t('admin:settings.descPasswordRequireLowercase')} />
                  <SettingsSwitch name="passwordRequireUppercase" label={t('admin:settings.fieldPasswordRequireUppercase')} description={t('admin:settings.descPasswordRequireUppercase')} />
                  <SettingsSwitch name="passwordRequireDigit" label={t('admin:settings.fieldPasswordRequireDigit')} description={t('admin:settings.descPasswordRequireDigit')} />
                  <SettingsSwitch name="passwordRequireSpecial" label={t('admin:settings.fieldPasswordRequireSpecial')} description={t('admin:settings.descPasswordRequireSpecial')} />
                </div>
              </div>
              <SettingsSelect name="emailDomainMode" label={t('admin:settings.fieldEmailDomainMode')} options={[{ value: 'none', label: t('admin:settings.optEmailDomainNone') }, { value: 'whitelist', label: t('admin:settings.optEmailDomainWhitelist') }, { value: 'blacklist', label: t('admin:settings.optEmailDomainBlacklist') }]} />
               <SettingsTextarea name="emailDomainListText" label={t('admin:settings.fieldEmailDomainListText')} rows={5} className="md:col-span-2" description={t('admin:settings.descEmailDomainListText')} />
               <div className="md:col-span-2 space-y-4 rounded-lg border p-4 shadow-sm">
                 <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="flex min-w-0 items-start gap-2"><Mail className="mt-0.5 size-5 shrink-0 text-primary" /><div><h3 className="text-sm font-semibold">{t('admin:settings.sectionSmtp')}</h3><p className="text-xs text-muted-foreground">{t('admin:settings.descSmtp')}</p></div></div><Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setSmtpTestOpen(true)} disabled={smtpTestMutation.isPending}><Send />{t('admin:settings.btnSendSmtpTest')}</Button></div>
                 <SettingsInput name="certificateExpiryWarningDays" label={t('admin:certificateManagement.threshold')} type="number" min={1} max={90} />
                 <SettingsSwitch name="certificateMailEnabled" label={t('admin:certificateManagement.mailEnabled')} description={t('admin:certificateManagement.mailDesc')} />
                 <SettingsTextarea name="certificateMailRecipientsText" label={t('admin:certificateManagement.recipients')} rows={3} />
                 <SettingsSwitch name="smtpEnabled" label={t('admin:settings.fieldSmtpEnabled')} description={t('admin:settings.descSmtpEnabled')} />
                 <div className="grid min-w-0 gap-4 sm:grid-cols-2"><SettingsInput name="smtpHost" label={t('admin:settings.fieldSmtpHost')} placeholder="smtp.example.com" /><SettingsInput name="smtpPort" label={t('admin:settings.fieldSmtpPort')} type="number" min={1} max={65535} /><SettingsSwitch name="smtpSecure" label={t('admin:settings.fieldSmtpSecure')} description={t('admin:settings.descSmtpSecure')} /><SettingsInput name="smtpUser" label={t('admin:settings.fieldSmtpUser')} placeholder="noreply@example.com" /><SettingsInput name="smtpPass" label={t('admin:settings.fieldSmtpPass')} type="password" placeholder={t('admin:settings.placeholderSmtpPass')} /><SettingsInput name="smtpFrom" label={t('admin:settings.fieldSmtpFrom')} placeholder="RiriCloud <noreply@example.com>" /></div>
                 <SettingsSwitch name="emailVerificationEnabled" label={t('admin:settings.fieldEmailVerificationEnabled')} description={t('admin:settings.descEmailVerificationEnabled')} />
                 <SettingsSwitch name="enforceEmailVerification" label={t('admin:settings.fieldEnforceEmailVerification')} description={t('admin:settings.descEnforceEmailVerification')} />
               </div>
               <div className="md:col-span-2 space-y-4 rounded-lg border p-4 shadow-sm"><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" /><div><h3 className="text-sm font-semibold">{t('admin:settings.sectionCaptcha')}</h3><p className="text-xs text-muted-foreground">{t('admin:settings.descCaptcha')}</p></div></div><SettingsSelect name="captchaMode" label={t('admin:settings.fieldCaptchaMode')} options={[{ value: 'OFF', label: t('admin:settings.optCaptchaOff') }, { value: 'LOCAL', label: t('admin:settings.optCaptchaLocal') }, { value: 'TURNSTILE', label: t('admin:settings.optCaptchaTurnstile') }]} />{form.watch('captchaMode') === 'TURNSTILE' ? <div className="grid gap-4 sm:grid-cols-2"><SettingsInput name="turnstileSiteKey" label={t('admin:settings.fieldTurnstileSiteKey')} placeholder="0x4AAAAAAA..." /><SettingsInput name="turnstileSecretKey" label={t('admin:settings.fieldTurnstileSecretKey')} type="password" placeholder={t('admin:settings.placeholderTurnstileSecretKey')} /></div> : null}</div>
             </CardContent></Card></TabsContent>

            <TabsContent value="subscription"><Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={Globe2} title={t('admin:settings.sectionSubscription')} description={t('admin:settings.sectionSubscriptionDesc')} /></CardHeader><CardContent className="grid min-w-0 gap-5 md:grid-cols-2">
               <div className="space-y-2 md:col-span-2 min-w-0"><SettingsInput name="subscriptionBaseUrl" label={t('admin:settings.fieldSubscriptionBaseUrl')} placeholder="https://sub.example.com" description={t('admin:settings.descSubscriptionBaseUrl')} /><SetOriginButton name="subscriptionBaseUrl" /></div>
              <SettingsSwitch name="subscriptionShortLinksEnabled" label={t('admin:settings.fieldSubscriptionShortLinksEnabled')} description={t('admin:settings.descSubscriptionShortLinksEnabled')} />
              <SettingsSwitch name="subscriptionEffectsSyncEnabled" label={t('admin:settings.fieldSubscriptionEffectsSyncEnabled')} description={t('admin:settings.descSubscriptionEffectsSyncEnabled')} />
              <SettingsInput name="subscriptionUpdateIntervalHours" label={t('admin:settings.fieldSubscriptionUpdateIntervalHours')} type="number" min={1} max={168} />
              <div className="rounded-lg border bg-muted/20 p-4 space-y-2 md:col-span-2 min-w-0">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-medium">{t('admin:settings.cardGlobalDefaultTemplate')}</p>
                    <p className="text-xs text-muted-foreground break-words">
                      {t('admin:settings.currentDefaultLabel')}<span className="font-semibold text-foreground">{defaultTemplate ? defaultTemplate.name : t('admin:settings.noDefaultTemplate')}</span>
                      {defaultTemplate?.description ? ` — ${defaultTemplate.description}` : ''}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0" asChild>
                    <Link to="/admin/templates">{t('admin:settings.btnManageTemplates')}</Link>
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t('admin:settings.descGlobalDefaultTemplate')}</p>
              </div>
              <SettingsSwitch name="publicLinesEnabled" label={t('admin:settings.fieldPublicLinesEnabled')} description={t('admin:settings.descPublicLinesEnabled')} />
              <SettingsSwitch name="includeUsageHeaders" label={t('admin:settings.fieldIncludeUsageHeaders')} description={t('admin:settings.descIncludeUsageHeaders')} />
              <SettingsSwitch name="appendSubscriptionSpeedBadge" label={t('admin:settings.fieldAppendSubscriptionSpeedBadge')} description={t('admin:settings.descAppendSubscriptionSpeedBadge')} />
              <SettingsSwitch name="speedLimitUnitConversionEnabled" label={t('admin:settings.fieldSpeedLimitUnitConversionEnabled')} description={t('admin:settings.descSpeedLimitUnitConversionEnabled')} />
              <div className="md:col-span-2 min-w-0">
                <SpeedTierEditor />
              </div>
            </CardContent></Card></TabsContent>

             <TabsContent value="agent"><Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={Gauge} title={t('admin:settings.sectionAgent')} description={t('admin:settings.sectionAgentDesc')} /></CardHeader><CardContent className="grid min-w-0 gap-5 md:grid-cols-2">
              <SettingsSwitch name="deviceLimitEnabled" label={t('admin:settings.fieldDeviceLimitEnabled')} description={t('admin:settings.descDeviceLimitEnabled')} className="md:col-span-2" />
              <SettingsInput name="deviceOnlineWindowSecs" label={t('admin:settings.fieldDeviceOnlineWindowSecs')} type="number" min={15} max={600} description={t('admin:settings.descDeviceOnlineWindowSecs')} />
              <SettingsInput name="heartbeatTimeoutSecs" label={t('admin:settings.fieldHeartbeatTimeoutSecs')} type="number" min={5} max={3600} />
              <SettingsInput name="configSyncDebounceMs" label={t('admin:settings.fieldConfigSyncDebounceMs')} type="number" min={0} max={10000} />
              <SettingsInput name="defaultPollIntervalSecs" label={t('admin:settings.fieldDefaultPollIntervalSecs')} type="number" min={5} max={300} />
              <SettingsInput name="binaryDownloadBaseUrl" label={t('admin:settings.fieldBinaryDownloadBaseUrl')} placeholder="https://downloads.example.com/riricloud" description={t('admin:settings.descBinaryDownloadBaseUrl')} />
              <SettingsInput name="githubRepoUrl" label={t('admin:settings.fieldGithubRepoUrl')} placeholder={__DEFAULT_GITHUB_REPO_URL__} description={t('admin:settings.descGithubRepoUrl')} />
              <div className="md:col-span-2 min-w-0">
                <GithubMirrorSettingsField />
              </div>
              <div className="rounded-lg border bg-muted/20 p-4 md:col-span-2 space-y-4 min-w-0">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">{t('admin:latencyTest.settings.title')}</h4>
                  <p className="text-xs text-muted-foreground">{t('admin:latencyTest.settings.description')}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 min-w-0">
                  <SettingsSwitch name="lineSpeedtestEnabled" label={t('admin:latencyTest.settings.enabled')} description={t('admin:latencyTest.settings.enabledHelp')} className="sm:col-span-2" />
                  <SettingsInput name="lineSpeedtestIntervalMins" label={t('admin:latencyTest.settings.interval')} type="number" min={1} max={1440} description={t('admin:latencyTest.settings.intervalHelp')} />
                  <SettingsInput name="lineSpeedtestTimeoutMs" label={t('admin:latencyTest.settings.timeout')} type="number" min={500} max={30000} description={t('admin:latencyTest.settings.timeoutHelp')} />
                  <div className="sm:col-span-2 min-w-0">
                    <SettingsInput name="lineSpeedtestTargetUrl" label={t('admin:latencyTest.settings.target')} placeholder="https://cp.cloudflare.com/generate_204" description={t('admin:latencyTest.settings.targetHelp')} />
                  </div>
                </div>
              </div>
               <ProbePresetEditor />
             </CardContent></Card></TabsContent>

            <TabsContent value="storage"><div className="space-y-4">
              <Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={Database} title={t('admin:settings.sectionStorage')} description={t('admin:settings.sectionStorageDesc')} /></CardHeader><CardContent className="grid min-w-0 gap-5 md:grid-cols-2">
                <SettingsInput name="trafficHourlyRetentionDays" label={t('admin:settings.fieldTrafficHourlyRetentionDays')} type="number" min={1} max={3650} description={t('admin:settings.descTrafficHourlyRetentionDays')} />
                <SettingsInput name="nodeRateRetentionDays" label={t('admin:settings.fieldNodeRateRetentionDays')} type="number" min={1} max={3650} description={t('admin:settings.descNodeRateRetentionDays')} />
                <SettingsInput name="logsRetentionDays" label={t('admin:settings.fieldLogsRetentionDays')} type="number" min={1} max={3650} />
                <SettingsInput name="logsMaxCount" label={t('admin:settings.fieldLogsMaxCount')} type="number" min={1000} max={1000000} />
                <SettingsSelect name="logsMinIngestLevel" label={t('admin:settings.fieldLogsMinIngestLevel')} options={[{ value: 'DEBUG', label: 'DEBUG' }, { value: 'INFO', label: t('admin:settings.optLogsLevelInfo') }, { value: 'WARN', label: 'WARN' }, { value: 'ERROR', label: 'ERROR' }]} description={t('admin:settings.descLogsMinIngestLevel')} />
                <div className="rounded-lg border bg-muted/20 p-4 text-xs text-muted-foreground md:col-span-2">{t('admin:settings.tipLegacyTrafficLogNotice')}</div>
              </CardContent></Card>
              <Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={Gauge} title={t('admin:settings.cardAgentLogRotateTitle')} description={t('admin:settings.descAgentLogRotate')} /></CardHeader><CardContent className="grid min-w-0 gap-5 md:grid-cols-2">
                <SettingsInput name="agentLogMaxSizeMb" label={t('admin:settings.fieldAgentLogMaxSizeMb')} type="number" min={1} max={1024} />
                <SettingsInput name="agentLogMaxFiles" label={t('admin:settings.fieldAgentLogMaxFiles')} type="number" min={1} max={20} description={t('admin:settings.descAgentLogMaxFiles')} />
              </CardContent></Card>
              <Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={Trash2} title={t('admin:settings.cardStorageVacuumTitle')} description={t('admin:settings.descStorageVacuum')} /></CardHeader><CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('admin:settings.statMainDb')}</p>
                    <p className="mt-1 text-base font-semibold tabular-nums">
                      {dbStatsQuery.isLoading
                        ? t('admin:settings.statReading')
                        : formatBytes(dbStatsQuery.data?.databases.find((d) => d.target === 'main')?.totalSize ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('admin:settings.statTelemetryDb')}</p>
                    <p className="mt-1 text-base font-semibold tabular-nums">
                      {dbStatsQuery.isLoading
                        ? t('admin:settings.statReading')
                        : formatBytes(dbStatsQuery.data?.databases.find((d) => d.target === 'telemetry')?.totalSize ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t('admin:settings.statTotalDb')}</p>
                    <p className="mt-1 text-base font-semibold tabular-nums">
                      {dbStatsQuery.isLoading
                        ? t('admin:settings.statReading')
                        : formatBytes(dbStatsQuery.data?.totalBytes ?? 0)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="destructive" onClick={() => setCleanupOpen(true)}>
                    <Trash2 />{t('admin:settings.btnOpenCleanup')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={vacuumMutation.isPending}
                    onClick={() => vacuumMutation.mutate()}
                  >
                    <RefreshCw className={vacuumMutation.isPending ? 'animate-spin' : ''} />
                    {vacuumMutation.isPending ? t('admin:settings.vacuuming') : t('admin:settings.btnVacuum')}
                  </Button>
                </div>
              </CardContent></Card>
            </div></TabsContent>

             <TabsContent value="advanced"><Card className="min-w-0 overflow-hidden"><CardHeader><SectionTitle icon={ShieldCheck} title={t('admin:settings.sectionAdvanced')} description={t('admin:settings.sectionAdvancedDesc')} /></CardHeader><CardContent className="min-w-0 space-y-6">
              <div className="max-w-2xl min-w-0"><SettingsInput name="jwtSessionDays" label={t('admin:settings.fieldJwtSessionDays')} type="number" min={1} max={30} description={t('admin:settings.descJwtSessionDays')} /></div>
              <SettingsEditor name="customCss" label={t('admin:settings.fieldCustomCss')} extensions={[css()]} description={t('admin:settings.descCustomCss')} />
              <SettingsEditor name="customHeadHtml" label={t('admin:settings.fieldCustomHeadHtml')} extensions={[html()]} description={t('admin:settings.descCustomHeadHtml')} />
            </CardContent></Card></TabsContent>
  </>;
}
