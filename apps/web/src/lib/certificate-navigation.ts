export function certificateReturnPath(state: unknown): string | null {
  const path = (state as { certificateReturn?: unknown } | null)?.certificateReturn;
  if (typeof path !== 'string') return null;
  try {
    const url = new URL(path, 'https://panel.invalid');
    return url.origin === 'https://panel.invalid' && url.pathname === '/admin/certificates' ? url.pathname + url.search : null;
  } catch { return null; }
}

export function certificateLinesPath(search: string, id: string, page = 1, filters: { search?: string; lineStatus?: string; relation?: string } = {}): string {
  const params = new URLSearchParams(search);
  params.set('certificateId', id);
  params.set('tab', 'lines');
  params.set('linePage', String(page));
  for (const [key, value] of Object.entries({ lineSearch: filters.search, lineStatus: filters.lineStatus, lineRelation: filters.relation })) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return '/admin/certificates?' + params.toString();
}

export function positivePage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}
