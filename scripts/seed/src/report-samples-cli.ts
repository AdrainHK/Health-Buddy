/**
 * 生成合成体检报告样本（PDF 和“手机照片”），方便在预览环境手动上传试用：
 *
 *   pnpm --filter @health-buddy/seed report-samples [输出目录，默认 report-samples]
 *
 * 样本来自识别评测用例，全部是合成数据。
 */
import { reportExtractionEvalCases } from '@health-buddy/skills';
import { writeReportSamples } from './report-samples.js';

const dir = process.argv[2] ?? 'report-samples';
const written = await writeReportSamples(
  dir,
  reportExtractionEvalCases.map((c) => ({ id: c.id, sample: c.sample })),
);
console.log(`已生成 ${written.length} 个样本文件：${dir}`);
