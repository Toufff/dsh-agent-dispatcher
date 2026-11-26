// Comment trust for projects switched to the bot account (settings.linear, commentTrust 'bot').
// The bot's own comments are self (never input); trusted authors are followup.commentAuthorIds plus the owner
// account(s) (binding ownerUserIds, default the project's linear.assigneeId). The author id decides, and a trusted
// comment counts whether it was posted while the round ran or after it settled. Legacy (shared-account) projects
// never reach this module.
//
// Transition guard (binding selfPrefixGuard, default on): the owner's personal account is also the account that
// manually started sessions, the research director and other automation still post with, always behind
// followup.selfCommentPrefix ("ZRSTUDIO", e.g. "ZRSTUDIO（OPUS-1）："). A comment whose body starts with that prefix
// is therefore self, whoever wrote it — the same rule as push-queue's Get-LinearCommentClass in bot mode — so such
// writebacks never wake or continue a task. Turn it off only after every automation posts as the bot.
export function selfPrefixOf(policy, mapping) {
  if (mapping?.selfPrefixGuard === false) return '';
  return String(policy?.selfCommentPrefix ?? 'ZRSTUDIO').trim();
}
export function botTrust(policy, mapping, botId) {
  if (!botId) throw new Error('bot identity unknown');
  const owners = [...new Set((mapping.ownerUserIds || []).filter(Boolean))];
  // The bot resolving to an owner or collaborator means a personal key (or the wrong app) was configured as the
  // bot: every owner comment would be "self". Fail closed instead of silently ignoring the owner.
  if (owners.includes(botId))
    throw Object.assign(new Error('Linear 机器人身份与 owner 账号相同，配置错误'), { code: 'LINEAR_IDENTITY_MISMATCH' });
  const trusted = [...new Set([...(policy?.commentAuthorIds || []), ...owners].filter(id => id && id !== botId))];
  const prefix = selfPrefixOf(policy, mapping).toLowerCase();
  const self = c => c?.user?.id === botId ||
    Boolean(prefix) && String(c?.body || '').trimStart().toLowerCase().startsWith(prefix);
  return { botId, owners, trusted, self, prefix,
    accepts: (c, allowed = trusted) => !self(c) && allowed.includes(c?.user?.id) };
}
