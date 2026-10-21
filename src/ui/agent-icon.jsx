import React from 'react';
import codex from './icons/codex.svg';
import claude from './icons/claude.svg';
import deepseek from './icons/deepseek.svg';

const icons = { codex, claude, dsh: deepseek };
/** Bundled, reviewed SVG assets only; never render remote issue content as markup. */
export function AgentIcon({ type }) {
  return icons[type]
    ? <span className={`agent-icon agent-icon-${type}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[type] }}/>
    : <svg className="agent-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="m8 10 3 2-3 2m6 0h3"/></svg>;
}
