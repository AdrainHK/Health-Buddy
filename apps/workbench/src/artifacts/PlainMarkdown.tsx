import type { ReactNode } from 'react';
import styles from './PlainMarkdown.module.css';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; lines: string[] };

/** 把 Markdown 切成块：标题、列表、段落。其余语法按原文显示。 */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;
  let list: Extract<Block, { kind: 'list' }> | null = null;
  const flush = () => {
    if (paragraph) blocks.push({ kind: 'paragraph', lines: paragraph });
    if (list) blocks.push(list);
    paragraph = null;
    list = null;
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null && bullet === null;
      if (paragraph || (list && list.ordered !== ordered)) flush();
      if (!list) list = { kind: 'list', ordered, items: [] };
      list.items.push(item[1] ?? '');
      continue;
    }
    if (list) flush();
    if (!paragraph) paragraph = [];
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** 行内只认 **粗体**，其余字符原样作为文本节点 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let pos = 0;
  let key = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    out.push(<strong key={key++}>{m[1]}</strong>);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/**
 * 简单的 Markdown 显示：只生成 React 文本节点和少量固定标签，
 * 不解析、不插入任何原始 HTML（专业版来自大模型，不能信任）。
 */
export function PlainMarkdown({ source }: { source: string }) {
  return (
    <div className={styles.root}>
      {parseBlocks(source).map((block, i) => {
        if (block.kind === 'heading') {
          return (
            <p key={i} className={styles.heading} data-level={block.level}>
              {inline(block.text)}
            </p>
          );
        }
        if (block.kind === 'list') {
          const items = block.items.map((item, j) => <li key={j}>{inline(item)}</li>);
          return block.ordered ? (
            <ol key={i} className={styles.list}>
              {items}
            </ol>
          ) : (
            <ul key={i} className={styles.list}>
              {items}
            </ul>
          );
        }
        return (
          <p key={i} className={styles.paragraph}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
