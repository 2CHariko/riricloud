import type { LineType } from './constants';

export interface LineTagInput {
  id: string;
  tag?: string | null;
  type: LineType | string;
}

export function resolveLineTags(line: LineTagInput): { direct?: string; entry?: string; landing?: string } {
  if (line.type === 'EXTERNAL') return {};
  const base = line.tag?.trim() || `line-${line.id}`;
  if (line.type === 'DIRECT') return { direct: base };
  return { entry: `${base}-entry`, landing: `${base}-landing` };
}
