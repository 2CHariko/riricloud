import { useState } from 'react';
import { flagAssets } from '@/lib/flag-assets';
import { splitFlagText } from '@/lib/flag-text';

function FlagGlyph({ text, src }: { text: string; src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return text;

  // 原始字符仍在文本流中可选择/复制并供读屏读取，SVG 仅作不可交互的覆盖层。
  return (
    <span className="relative inline-block h-[1em] w-[1.25em] overflow-hidden whitespace-nowrap align-[-0.125em]">
      <span className="opacity-0">{text}</span>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

// 不扫描或修改 DOM，不改变名称数据、搜索值、输入框、剪贴板按钮或订阅导出。
export function FlagText({ text }: { text: string }) {
  return (
    <>
      {splitFlagText(text, flagAssets).map((part, index) => part.src
        ? <FlagGlyph key={`${index}:${part.src}`} text={part.text} src={part.src} />
        : part.text)}
    </>
  );
}
