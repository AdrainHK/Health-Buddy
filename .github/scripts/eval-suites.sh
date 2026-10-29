#!/usr/bin/env bash
# 按改动的文件挑出要跑的 AI 评测组（.github/workflows/eval.yml 用）。
# 输入：每行一个改动的文件路径（标准输入）；只有一行 ALL 时跑全部。
# 输出：评测组的 JSON 数组，如 ["companion,companion-speech"]；没有要跑的组时为 []。
# 只影响某个技能或专家的改动只跑对应的组；网关、合规词表、公共检查（wording、guardrails）、
# 评测框架本身等改动影响所有组，跑全部；受监视目录里认不出的文件也按跑全部处理（宁多勿漏）。
set -euo pipefail

SUMMARY='summary,ask,extraction'
REPORT='interpretation,outline,plan'
EXPERT='expert'
ROUTE='expert-routing,expert-synthesis'
TWIN='twin-summary,twin-consult'
VSCHED='visit-schedule'
CARE='care-plan'
VISIT='visit-script,visit-record,chat-transcription'
COMP='companion,companion-speech'
ALL_GROUPS=("$SUMMARY" "$REPORT" "$EXPERT" "$ROUTE" "$TWIN" "$VSCHED" "$CARE" "$VISIT" "$COMP")

declare -A picked=()
all=false

while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    ALL) all=true ;;
    # 测试文件不改提示词和评分，不触发评测
    *.test.ts) ;;
    packages/skills/src/companion/* | scripts/eval/src/companion.ts) picked[$COMP]=1 ;;
    packages/skills/src/visit-script/* | packages/skills/src/visit-record/* | \
      packages/skills/src/chat-transcription* | scripts/eval/src/visits.ts | \
      scripts/eval/src/chat-transcription.ts) picked[$VISIT]=1 ;;
    packages/skills/src/visit-schedule/*) picked[$VSCHED]=1 ;;
    packages/skills/src/care-plan/*) picked[$CARE]=1 ;;
    scripts/eval/src/plans.ts) picked[$VSCHED]=1; picked[$CARE]=1 ;;
    packages/skills/src/twin-summary/* | packages/skills/src/twin-input.ts | \
      packages/skills/src/twin-fixtures.ts | scripts/eval/src/twin.ts)
      picked[$TWIN]=1; picked[$SUMMARY]=1 ;;
    packages/skills/src/report-interpretation/* | packages/skills/src/interview-outline/* | \
      packages/skills/src/report-input.ts | packages/skills/src/report-fixtures.ts | \
      packages/skills/src/plan-evals.ts | packages/skills/src/risk-tier-guide.ts | \
      scripts/eval/src/report-skills.ts) picked[$REPORT]=1 ;;
    packages/skills/src/report-extraction/* | scripts/eval/src/extraction.ts | \
      packages/skills/src/client-recent-summary/* | packages/skills/src/ask*.ts | \
      scripts/eval/src/ask.ts) picked[$SUMMARY]=1 ;;
    packages/experts/* | scripts/eval/src/expert.ts)
      picked[$EXPERT]=1; picked[$ROUTE]=1; picked[$TWIN]=1; picked[$REPORT]=1 ;;
    # 只改评测工作流或本脚本时，跑一个小组确认流程能走通就够了
    .github/workflows/eval.yml | .github/scripts/eval-suites.sh) picked[$VSCHED]=1 ;;
    # 其余受监视的文件（网关、合规词表、技能公共部分、评测框架）影响所有组
    packages/skills/* | packages/ai-engine/* | packages/experts/* | \
      packages/shared/src/compliance/* | scripts/eval/*) all=true ;;
    # 工作流不监视的文件（服务器、前端、文档等）不影响评测
    *) ;;
  esac
done

out=()
for group in "${ALL_GROUPS[@]}"; do
  if $all || [ -n "${picked[$group]:-}" ]; then out+=("\"$group\""); fi
done
(IFS=,; echo "[${out[*]}]")
