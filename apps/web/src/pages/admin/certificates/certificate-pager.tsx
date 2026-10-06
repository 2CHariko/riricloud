import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function CertificatePager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const { t } = useTranslation(['admin', 'common']);
  return <div className="flex flex-wrap items-center justify-end gap-2 py-2">
    <span className="text-xs text-muted-foreground">{t('admin:certificateManagement.page', { page, pages: Math.max(1, Math.ceil(total / 20)), total })}</span>
    <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t('admin:certificateManagement.previous')}</Button>
    <Button type="button" size="sm" variant="outline" disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>{t('admin:certificateManagement.next')}</Button>
  </div>;
}
