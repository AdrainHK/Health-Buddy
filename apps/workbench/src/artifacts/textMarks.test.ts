import { filenameFromDisposition } from '../api/artifacts';
import { parseBlocks } from './PlainMarkdown';
import { bannedTermMarks, criticalMarks, judgementMarks, segmentText } from './textMarks';

describe('textMarks', () => {
  it('covers banned terms split by spaces or zero-width characters', () => {
    const text = '合成：可以根​治，也能筛 查。仅供参考，非医疗诊断';
    const marks = bannedTermMarks(text);
    expect(marks.map((m) => text.slice(m.start, m.end))).toEqual(['根​治', '筛 查']);
  });

  it('marks the digits of a critical value', () => {
    const text = '收缩压 185，注意休息';
    const [mark] = criticalMarks(text, [{ metric: 'sbp', index: 4 }]);
    expect(mark && text.slice(mark.start, mark.end)).toBe('185');
  });

  it('relocates judgement hints after a local edit and drops missing ones', () => {
    const saved = '有高血压风险，请注意';
    const hints = [{ text: '高血压', index: 1 }];
    expect(judgementMarks(saved, hints, saved)[0]).toMatchObject({ start: 1, end: 4 });
    expect(judgementMarks(`补充。${saved}`, hints, saved)[0]).toMatchObject({ start: 4 });
    expect(judgementMarks('请注意', hints, saved)).toEqual([]);
  });

  it('splits text into plain and marked segments without overlaps', () => {
    const segs = segmentText('abcdef', [
      { kind: 'judgement', start: 1, end: 4, label: 'x' },
      { kind: 'banned', start: 1, end: 3, label: 'y' },
    ]);
    expect(segs.map((s) => [s.text, s.mark?.kind])).toEqual([
      ['a', undefined],
      ['bc', 'banned'],
      ['def', undefined],
    ]);
  });
});

describe('filenameFromDisposition', () => {
  it('prefers the UTF-8 filename* parameter', () => {
    const header = `attachment; filename="export.png"; filename*=UTF-8''${encodeURIComponent('客户近况小结-2026-10-15.png')}`;
    expect(filenameFromDisposition(header, 'png')).toBe('客户近况小结-2026-10-15.png');
  });

  it('falls back to filename and then to a default name', () => {
    expect(filenameFromDisposition('attachment; filename="a.pdf"', 'pdf')).toBe('a.pdf');
    expect(filenameFromDisposition(null, 'pdf')).toBe('export.pdf');
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''..%2F..%2Fx.pdf`, 'pdf')).toBe(
      '.._.._x.pdf',
    );
  });
});

describe('parseBlocks', () => {
  it('recognises headings, lists and paragraphs only', () => {
    expect(parseBlocks('# 标题\n- 一\n- 二\n\n正文<b>x</b>')).toEqual([
      { kind: 'heading', level: 1, text: '标题' },
      { kind: 'list', ordered: false, items: ['一', '二'] },
      { kind: 'paragraph', lines: ['正文<b>x</b>'] },
    ]);
  });
});
