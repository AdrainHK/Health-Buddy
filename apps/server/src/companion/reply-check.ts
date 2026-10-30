import { HttpStatus } from '@nestjs/common';
import { checkHandoffReply } from '@health-buddy/skills';
import { ApiException } from '../common/api-error.js';

/**
 * 健管师发出的回复（直接写的、/转交回复 审核后的）共用的发送检查（规格 2.4、合规审查 S1、S2）：
 * 禁用词、只给健管师看的提示语 → 400；药名、病名、数值评价等提醒没确认 → 400，reasons 第一项是 needs_confirmation
 */
export function assertReplySendable(text: string, acknowledgeWarnings: boolean): void {
  const check = checkHandoffReply(text);
  if (check.bannedTerms.length) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_content', {
      reasons: ['banned_term'],
      terms: check.bannedTerms,
    });
  }
  if (check.managerOnly) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_content', {
      reasons: ['manager_only_text'],
    });
  }
  if (check.warnings.length && !acknowledgeWarnings) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_content', {
      reasons: ['needs_confirmation', ...check.warnings],
    });
  }
}
