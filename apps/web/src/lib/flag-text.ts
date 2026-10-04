export interface FlagTextPart {
  text: string;
  src?: string;
}

// 只识别国家/地区旗帜的区域指示符对；不猜测地区，不改写普通表情或未知序列。
export function splitFlagText(text: string, assets: Readonly<Record<string, string>>): FlagTextPart[] {
  const parts: FlagTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)) {
    const key = Array.from(match[0], (character) => character.codePointAt(0)!.toString(16)).join('-');
    const src = assets[key];
    if (!src) continue;
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) });
    parts.push({ text: match[0], src });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor) });
  return parts;
}
