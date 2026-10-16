import { reportExtractionEvalCases } from '@health-buddy/skills';
import { describe, expect, it } from 'vitest';
import { renderSample } from './report-samples.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('合成体检报告样本', () => {
  // 渲染 10 份样本（含照片效果）在 CI 机器上要几秒，超过默认 5 秒
  it(
    '每个识别评测用例都能渲染：PDF 页数对得上，照片每页一张 PNG',
    { timeout: 60_000 },
    async () => {
      for (const c of reportExtractionEvalCases) {
        const pages = await renderSample(c.sample);
        if (c.sample.render === 'pdf') {
          expect(pages, c.id).toHaveLength(1);
          const pdf = pages[0]!.data.toString('latin1');
          expect(pdf.startsWith('%PDF-'), c.id).toBe(true);
          expect(pdf.match(/\/Type \/Page\b/g)?.length, c.id).toBe(c.sample.pages.length);
        } else {
          expect(pages, c.id).toHaveLength(c.sample.pages.length);
          for (const p of pages) expect(p.data.subarray(0, 4).equals(PNG_MAGIC), c.id).toBe(true);
        }
      }
    },
  );

  it('样本上的个人信息是合成的，用例之间一致', () => {
    const ids = new Set(reportExtractionEvalCases.map((c) => c.sample.person.idNumber));
    expect(ids.size).toBe(1);
    // 合成证件号：18 位，不做真实校验
    expect([...ids][0]).toMatch(/^\d{17}[\dX]$/);
  });
});
