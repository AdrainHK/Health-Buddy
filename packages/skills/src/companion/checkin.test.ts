import { checkinValuesInRange, COMPANION_DEFAULT_SCRIPTS } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import {
  CHECKIN_METRIC_SPOKEN,
  checkCompanionReply,
  extractNumbers,
  parseCheckinReading,
  parseCheckinStatus,
  parseConfirmation,
  renderCompanionScript,
  spokenNumber,
  spokenReading,
} from './index.js';

/** M6 第 5 步：打卡回答的规则识别（规格 2.3）。全部是合成的说法 */

describe('服药、运动的回答', () => {
  it.each([
    ['吃了吃了', 'done'],
    ['早上已经吃过了', 'done'],
    ['哎呀忘了', 'missed'],
    ['还没吃呢', 'missed'],
    ['今天不用吃', 'skipped'],
    ['今天天气不错', null],
    // 问句、记不清、要配药都不是回答（合规审查 B1、S4）
    ['我今天药吃了吗', null],
    ['我今天药吃没吃', null],
    ['我不记得吃没吃了', null],
    ['药吃完了', null],
    ['药停了', null],
  ])('服药：%s', (text, status) => {
    expect(parseCheckinStatus('medication', text)).toBe(status);
  });

  it.each([
    ['做了，走了半个小时', 'done'],
    ['只做了一部分', 'partial'],
    ['走了一会就回来了', 'partial'],
    ['今天下雨没走', 'missed'],
    ['没做完', 'partial'],
    ['孙子来了', null],
  ])('运动：%s', (text, status) => {
    expect(parseCheckinStatus('exercise', text)).toBe(status);
  });

  it('测量类不按状态识别', () => {
    expect(parseCheckinStatus('measurement', '量了')).toBeNull();
  });
});

describe('取数', () => {
  it.each([
    ['一百三十二', [132]],
    ['八十六', [86]],
    ['十五', [15]],
    ['一百零三', [103]],
    ['一百三', [130]],
    ['八千五', [8500]],
    ['一万二', [12000]],
    ['两万三千四百', [23400]],
    ['七点八', [7.8]],
    ['一三二', [132]],
    ['132/86', [132, 86]],
    ['走了 12,000 步', [12000]],
    ['睡了七个半小时', [7.5]],
    ['早上七点量的', []],
  ])('%s', (text, numbers) => {
    expect(extractNumbers(text)).toEqual(numbers);
  });

  it('血压：两个数按大小分高压、低压', () => {
    expect(parseCheckinReading('bp', '高压一百三十二，低压八十六')).toEqual([132, 86]);
    expect(parseCheckinReading('bp', '86，132')).toEqual([132, 86]);
    expect(parseCheckinReading('bp', '132')).toBeNull();
    expect(parseCheckinReading('bp', '量了，还行')).toBeNull();
  });

  it('其他项目一个数；体重说斤换成公斤', () => {
    expect(parseCheckinReading('fpg', '空腹七点八')).toEqual([7.8]);
    expect(parseCheckinReading('weight', '一百三十斤')).toEqual([65]);
    expect(parseCheckinReading('weight', '六十五公斤')).toEqual([65]);
    expect(parseCheckinReading('steps', '走了八千多步')).toEqual([8000]);
    expect(parseCheckinReading('sleep_hours', '睡了七个半小时')).toEqual([7.5]);
    expect(parseCheckinReading('fpg', '七点八还是八点二来着')).toBeNull();
  });

  it('合理范围：高压要比低压大，超出范围的不收', () => {
    expect(checkinValuesInRange('bp', [132, 86])).toBe(true);
    expect(checkinValuesInRange('bp', [86, 132])).toBe(false);
    expect(checkinValuesInRange('bp', [1320, 86])).toBe(false);
    expect(checkinValuesInRange('fpg', [78])).toBe(false);
    expect(checkinValuesInRange('weight', [65])).toBe(true);
  });
});

describe('复述确认', () => {
  it.each([
    ['对', 'yes'],
    ['对的对的', 'yes'],
    ['嗯', 'yes'],
    ['是的，没错', 'yes'],
    ['不对，是一百三十五', 'no'],
    ['不是', 'no'],
    ['我想想', null],
    ['是不是有点高啊', null],
    ['对了，我想问个事', null],
    ['对吗', null],
  ])('%s', (text, answer) => {
    expect(parseConfirmation(text)).toBe(answer);
  });
});

describe('念出来的话', () => {
  it('数字念成中文', () => {
    expect(spokenNumber(132)).toBe('一百三十二');
    expect(spokenNumber(86)).toBe('八十六');
    expect(spokenNumber(105)).toBe('一百零五');
    expect(spokenNumber(12)).toBe('十二');
    expect(spokenNumber(7.8)).toBe('七点八');
    expect(spokenNumber(12000)).toBe('一万二千');
    expect(spokenNumber(8050)).toBe('八千零五十');
  });

  it('复述只说数，不评价；替换后能通过输出检查', () => {
    for (const [metric, values] of [
      ['bp', [185, 125]],
      ['fpg', [2.8]],
      ['weight', [65.5]],
      ['steps', [8000]],
      ['sleep_hours', [7.5]],
    ] as const) {
      const text = renderCompanionScript(COMPANION_DEFAULT_SCRIPTS.checkin_confirm_reading, {
        reading: spokenReading(metric, values),
      });
      expect(text).not.toContain('{');
      expect(checkCompanionReply(text)).toEqual([]);
    }
    for (const metric of Object.values(CHECKIN_METRIC_SPOKEN)) {
      const text = renderCompanionScript(COMPANION_DEFAULT_SCRIPTS.reminder_measurement, {
        metric,
      });
      expect(checkCompanionReply(text)).toEqual([]);
    }
  });

  it('打卡话术本身能通过输出检查', () => {
    for (const kind of ['checkin_recorded', 'checkin_retry', 'checkin_noted'] as const) {
      expect(checkCompanionReply(COMPANION_DEFAULT_SCRIPTS[kind])).toEqual([]);
    }
  });
});
