import { describe, expect, it } from 'vitest';
import {
  createOrganizationRequestSchema,
  operatorInviteRequestSchema,
  parseAccountCsv,
} from './accounts.js';

describe('批量开通 CSV 解析（M7 规格 2.4）', () => {
  it('跳过空行，行号按文件里的行算，中文角色转成代码，引号里的逗号不拆', () => {
    const r = parseAccountCsv(
      '\uFEFF姓名,邮箱,角色,机构名称\r\n合成甲,a@test.example,健管师,\r\n\r\n"合成,乙",b@test.example,机构管理员,一号机构\n',
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        { row: 2, displayName: '合成甲', email: 'a@test.example', role: 'manager', orgName: '' },
        {
          row: 4,
          displayName: '合成,乙',
          email: 'b@test.example',
          role: 'org_admin',
          orgName: '一号机构',
        },
      ],
    });
  });

  it('表头不对、没有数据行、超过 200 行时整份拒绝', () => {
    expect(parseAccountCsv('name,email\nx,y')).toEqual({ ok: false, error: 'bad_header' });
    expect(parseAccountCsv('姓名,邮箱,角色,机构名称\n\n')).toEqual({ ok: false, error: 'empty' });
    expect(parseAccountCsv('')).toEqual({ ok: false, error: 'empty' });
    const many = [
      '姓名,邮箱,角色,机构名称',
      ...Array.from({ length: 201 }, (_, i) => `n${i},e${i}@x.cn,健管师,`),
    ];
    expect(parseAccountCsv(many.join('\n'))).toEqual({ ok: false, error: 'too_many_rows' });
  });
});

describe('单个开通请求', () => {
  it('机构管理员必须选机构', () => {
    const base = { displayName: '合成', email: 'a@test.example', orgId: null };
    expect(operatorInviteRequestSchema.safeParse({ ...base, role: 'manager' }).success).toBe(true);
    expect(operatorInviteRequestSchema.safeParse({ ...base, role: 'org_admin' }).success).toBe(
      false,
    );
    expect(operatorInviteRequestSchema.safeParse({ ...base, role: 'operator_admin' }).success).toBe(
      false,
    );
  });
});

describe('机构名称', () => {
  it('不能含禁用词', () => {
    expect(createOrganizationRequestSchema.safeParse({ name: '合成健康管理中心' }).success).toBe(
      true,
    );
    expect(createOrganizationRequestSchema.safeParse({ name: '合成慢病筛查中心' }).success).toBe(
      false,
    );
  });
});
