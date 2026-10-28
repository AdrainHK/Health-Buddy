import { describe, expect, it } from 'vitest';
import { findBannedTerms } from '../compliance/index.js';
import {
  COMPANION_DEFAULT_SCRIPTS,
  COMPANION_SCRIPT_MAX,
  bindCompanionDeviceRequestSchema,
  companionStatusOf,
  importDeviceBatchRequestSchema,
  recordCompanionConsentRequestSchema,
  serialLast4,
  updateCompanionSettingsRequestSchema,
} from './companion.js';

describe('伴侣契约（M6 第 1 步）', () => {
  it('激活码去掉空格和连字符、转大写；格式不对的拒绝', () => {
    expect(
      bindCompanionDeviceRequestSchema.parse({
        serialNo: ' HB-0001 ',
        activationCode: 'ab cd-12 34',
      }),
    ).toEqual({ serialNo: 'HB-0001', activationCode: 'ABCD1234' });
    expect(
      bindCompanionDeviceRequestSchema.safeParse({ serialNo: 'HB-0001', activationCode: '12345' })
        .success,
    ).toBe(false);
    expect(
      bindCompanionDeviceRequestSchema.safeParse({
        serialNo: '中文序列号',
        activationCode: 'ABCD1234',
      }).success,
    ).toBe(false);
  });

  it('同意必须勾选确认', () => {
    const base = { noticeVersion: 1, consentedOn: '2026-10-01' };
    expect(recordCompanionConsentRequestSchema.safeParse(base).success).toBe(false);
    expect(
      recordCompanionConsentRequestSchema.safeParse({ ...base, confirmed: true }).success,
    ).toBe(true);
  });

  it('设置至少改一项；称呼不超过 10 个字', () => {
    expect(updateCompanionSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(updateCompanionSettingsRequestSchema.safeParse({ nameForClient: null }).success).toBe(
      true,
    );
    expect(
      updateCompanionSettingsRequestSchema.safeParse({ nameForClient: '一二三四五六七八九十一' })
        .success,
    ).toBe(false);
  });

  it('批次导入：设备密钥至少 32 位', () => {
    const device = {
      serialNo: 'HB-0001',
      deviceSecret: 'x'.repeat(31),
      activationCode: 'ABCD1234',
    };
    expect(importDeviceBatchRequestSchema.safeParse({ name: 'b', devices: [device] }).success).toBe(
      false,
    );
  });

  it('状态和序列号显示', () => {
    expect(companionStatusOf(null)).toBe('unbound');
    expect(companionStatusOf({ status: 'bound' })).toBe('pending_activation');
    expect(companionStatusOf({ status: 'revoked' })).toBe('revoked');
    expect(serialLast4('HB-TEST-0001')).toBe('0001');
  });

  it('默认固定话术：没有禁用词、不超过长度、不说疾病判断', () => {
    for (const text of Object.values(COMPANION_DEFAULT_SCRIPTS)) {
      expect(findBannedTerms(text)).toEqual([]);
      expect(text.length).toBeLessThanOrEqual(COMPANION_SCRIPT_MAX);
      expect(text).not.toMatch(/偏高|偏低|正常|异常|风险/);
    }
  });
});
