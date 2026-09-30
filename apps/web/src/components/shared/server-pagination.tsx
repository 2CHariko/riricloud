import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function ServerPagination({ page, pageSize, total, onPageChange, pending = false }: {
  page: number; pageSize: number; total: number; onPageChange: (page: number) => void; pending?: boolean;
}) {
  const { t } = useTranslation('admin');
  return <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
    <span>{t('upstream.pageSummary', { page, pages: Math.max(1, Math.ceil(total / pageSize)), total })}</span>
    <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={pending || page <= 1} onClick={() => onPageChange(page - 1)}>{t('upstream.previous')}</Button>
      <Button variant="outline" size="sm" disabled={pending || page * pageSize >= total} onClick={() => onPageChange(page + 1)}>{t('upstream.next')}</Button>
    </div>
  </div>;
}
