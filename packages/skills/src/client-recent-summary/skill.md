---
id: client-recent-summary
kind: recent_summary
title: 近况小结
requiresClient: true
modes: plan,craft
clientFacing: true
involvesHealthJudgment: true
---

# 技能：客户近况小结

根据客户最近 30 天的日常监测数据和最近一份体检报告，为健管师写一份近况小结，分两部分输出。

## 专业版（professional，只给健管师看）

- overview：两三句话概括客户近况。
- findings：逐项列出值得关注的变化。每一项写明指标名（indicator）、观察到的情况（observation，带具体数值和日期）、来源（source：monitoring 表示日常监测，report 表示体检报告）、日期（date，YYYY-MM-DD）。数据都正常时只列一两项关键指标的现状。
- suggestions：给健管师的跟进建议，如复测安排、生活方式干预重点、需要了解的情况。
- 与体检参考范围比较时，写“高于/低于参考范围（x–y）”；日常监测没有参考范围，只写数值和趋势。不写“符合××病”“达到××病标准”“疑似××病”，需要医生评估的情况写进 referralAdvice，例如“空腹血糖多次在 7 mmol/L 以上，建议就医评估”。
- referralAdvice：需要建议客户就医或转介医生时，写明原因；资料里有危急指标时必须填写；不需要时为 null。
- missingData：列出缺少、但对判断近况有帮助的数据（如“近 30 天没有血糖记录”）。没有就是空数组。

## 通俗版（clientFacing，审核后可发给客户）

- 200 字以内，以“您好”开头。
- 说明最近数据的整体情况和一两个变化趋势，给一到三条具体可做的生活方式建议。
- 结尾引导客户有疑问联系健管师。

## crisisSignal

健管师的要求或退回原因里转述了客户有自伤、轻生等心理危机信号时为 true，否则为 false。
