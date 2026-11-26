// Comment trust for projects switched to the bot account (settings.linear, commentTrust 'bot').
// The bot's own comments are self (never input); trusted authors are followup.commentAuthorIds plus the owner
// account(s) (binding ownerUserIds, default the project's linear.assigneeId). Only the author id decides:
// text prefixes ("ZRSTUDIO：", "owner：") are ignored, and a trusted comment counts whether it was posted while
// the round ran or after it settled. Legacy (shared-account) projects never reach this module.
export function botTrust(policy, mapping, botId) {
  if (!botId) throw new Error('bot identity unknown');
  const owners = [...new Set((mapping.ownerUserIds || []).filter(id => id && id !== botId))];
  const trusted = [...new Set([...(policy?.commentAuthorIds || []), ...owners].filter(id => id && id !== botId))];
  const self = c => c?.user?.id === botId;
  return { botId, owners, trusted, self,
    accepts: (c, allowed = trusted) => !self(c) && allowed.includes(c?.user?.id) };
}
