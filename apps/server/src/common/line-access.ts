export type PlanLineRule = {
  lineMatchMode: string;
  lineTagsJson: string;
  lineIdsJson: string;
};

export type AccessLine = {
  id: string;
  tagsJson: string;
  isPublic?: boolean;
  status?: string;
};

export function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function matchesPlanLine(plan: PlanLineRule, line: AccessLine): boolean {
  if (plan.lineMatchMode === 'EXPLICIT') return parseStringArray(plan.lineIdsJson).includes(line.id);
  if (plan.lineMatchMode === 'TAGS') {
    const tags = new Set(parseStringArray(line.tagsJson));
    return parseStringArray(plan.lineTagsJson).some((tag) => tags.has(tag));
  }
  return plan.lineMatchMode === 'ALL';
}

export function isLineAuthorized(plan: PlanLineRule, line: AccessLine, extraLineIds: string[] = []): boolean {
  if (line.status !== undefined && line.status !== 'ACTIVE') return false;
  return extraLineIds.includes(line.id) || (line.isPublic !== false && matchesPlanLine(plan, line));
}
