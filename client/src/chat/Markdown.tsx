import type { JSX, ReactNode } from 'react';

/**
 * Code, a link (its address may hold one pair of brackets, as wiki addresses do), bold, then
 * italics; each found from the left.
 */
const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|(?<!\w)_(?!\s)(.+?)_(?!\w)/g;

/** Only web addresses become links. */
const WEB = /^https?:\/\//i;

/**
 * A line of text with its inline formatting as elements; anything else, HTML included, as text.
 * Keys start with `at`, the line's place, so lines side by side don't share one.
 */
function inline(text: string, at: number | string = 0): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, code, linkText, href, bold, bold2, italic, italic2] = match;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${at}:${match.index}`;
    if (code !== undefined) nodes.push(<code key={key}>{code}</code>);
    else if (linkText !== undefined && href !== undefined) {
      nodes.push(
        WEB.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {inline(linkText, key)}
          </a>
        ) : (
          inline(linkText, key)
        ),
      );
    } else if (bold !== undefined || bold2 !== undefined) {
      nodes.push(<strong key={key}>{inline(bold ?? bold2 ?? '', key)}</strong>);
    } else {
      nodes.push(<em key={key}>{inline(italic ?? italic2 ?? '', key)}</em>);
    }
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A line of the answer, by where it is in it (its key). */
type Line = { at: number; text: string };

/** Lines joined as they were written, each break kept. */
function lines(texts: Line[]): ReactNode[] {
  return texts.flatMap((line, i) =>
    i === 0
      ? inline(line.text, line.at)
      : [<br key={`br${line.at}`} />, ...inline(line.text, line.at)],
  );
}

/** A list's item, with the bullets indented under it. */
type Item = Line & { children: Line[] };

/** A table's column: its place, its heading and how its cells line up. */
type Column = { col: number; text: string; align: 'left' | 'center' | 'right' | null };

type Block =
  | { kind: 'heading'; at: number; depth: number; text: string }
  | { kind: 'paragraph'; at: number; lines: Line[] }
  | { kind: 'list'; at: number; ordered: boolean; start: number; items: Item[] }
  | { kind: 'table'; at: number; columns: Column[]; rows: { at: number; cells: string[] }[] }
  | { kind: 'code'; at: number; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const INDENTED = /^\s{2,}/;
const FENCE = /^\s*```/;
const DIVIDER_CELL = /^:?-+:?$/;

/** A table row's cells: split at each bar that isn't escaped (`\|`), the outer bars dropped. */
function cellsOf(line: string): string[] {
  const row = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
}

/** How each column of a table lines up, from its divider row (`|---|:---:|`); null for another line. */
function dividerOf(line: string | undefined): Column['align'][] | null {
  if (!line?.includes('|')) return null;
  const cells = cellsOf(line);
  if (!cells.every((cell) => DIVIDER_CELL.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(':')) return cell.endsWith(':') ? 'center' : 'left';
    return cell.endsWith(':') ? 'right' : null;
  });
}

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  const source = text.split('\n');
  for (let at = 0; at < source.length; at++) {
    const line = source[at] ?? '';
    if (FENCE.test(line)) {
      const start = at;
      const code: string[] = [];
      for (at++; at < source.length && !FENCE.test(source[at] ?? ''); at++)
        code.push(source[at] ?? '');
      blocks.push({ kind: 'code', at: start, text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') continue;
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', at, depth: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      continue;
    }
    // A table: its header row, then a divider row with as many columns, even straight after a
    // paragraph's line.
    const head = line.includes('|') ? cellsOf(line) : [];
    const divider = head.length > 0 ? dividerOf(source[at + 1]) : null;
    if (divider && divider.length === head.length) {
      const start = at;
      const columns = head.map((text, col) => ({ col, text, align: divider[col] ?? null }));
      const rows: { at: number; cells: string[] }[] = [];
      // Its rows go on to a line without a bar (a blank one, say).
      for (at += 2; source[at]?.includes('|'); at++)
        rows.push({ at, cells: cellsOf(source[at] ?? '') });
      at--;
      blocks.push({ kind: 'table', at: start, columns, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const previous = blocks.at(-1);
      const last = previous?.kind === 'list' ? previous.items.at(-1) : undefined;
      // A bullet indented under a list's item belongs to that item.
      if (bullet && last && INDENTED.test(line)) {
        last.children.push({ at, text: bullet[1] ?? '' });
        continue;
      }
      const ordered = numbered !== null;
      const entry = { at, text: (numbered ? numbered[2] : bullet?.[1]) ?? '', children: [] };
      if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(entry);
      else {
        // A numbered list goes on from its first number (step 3 after a paragraph is still 3).
        const start = numbered ? Number(numbered[1]) : 1;
        blocks.push({ kind: 'list', at, ordered, start, items: [entry] });
      }
      continue;
    }
    const previous = blocks.at(-1);
    // A line straight after a paragraph's carries it on.
    if (previous?.kind === 'paragraph' && source[at - 1]?.trim())
      previous.lines.push({ at, text: line });
    else blocks.push({ kind: 'paragraph', at, lines: [{ at, text: line }] });
  }
  return blocks;
}

function renderBlock(block: Block): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const Heading = block.depth <= 2 ? 'h3' : block.depth === 3 ? 'h4' : 'h5';
      return <Heading key={block.at}>{inline(block.text, block.at)}</Heading>;
    }
    case 'paragraph':
      return <p key={block.at}>{lines(block.lines)}</p>;
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List key={block.at} start={block.ordered && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item) => (
            <li key={item.at}>
              {inline(item.text, item.at)}
              {item.children.length > 0 && (
                <ul>
                  {item.children.map((child) => (
                    <li key={child.at}>{inline(child.text, child.at)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </List>
      );
    }
    case 'table': {
      // A row's cells by column: one it lacks is empty, and any past the last column are left out.
      const align = (column: Column) => (column.align ? { textAlign: column.align } : undefined);
      return (
        <table key={block.at}>
          <thead>
            <tr>
              {block.columns.map((column) => (
                <th key={column.col} scope="col" style={align(column)}>
                  {inline(column.text, `${block.at}:${column.col}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.at}>
                {block.columns.map((column) => (
                  <td key={column.col} style={align(column)}>
                    {inline(row.cells[column.col] ?? '', `${row.at}:${column.col}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'code':
      return (
        <pre key={block.at}>
          <code>{block.text}</code>
        </pre>
      );
  }
}

/**
 * An answer's Markdown: headings (under the chat's own), paragraphs, bulleted and numbered
 * lists, tables, bold, italics, code and links, which open in a new tab (only web addresses).
 * HTML is shown as the text it is, never run.
 */
export function Markdown(props: { text: string }): JSX.Element {
  return <>{blocksOf(props.text).map(renderBlock)}</>;
}
