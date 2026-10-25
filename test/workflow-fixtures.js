export const workItems = status => [{ id: 'goal', title: 'Synthetic goal', status: status === 'complete' ? 'done' : status === 'continue' ? 'ready' : status,
  dependsOn: [], action: status === 'continue' ? 'Verify next local step' : '', evidence: status === 'complete' ? ['Synthetic verification passed'] : [],
  ...(['blocked', 'decision'].includes(status) ? { blocker: { kind: status === 'decision' ? 'permission' : 'external', owner: 'responsible party', reason: 'specific missing input', resumeWhen: 'verified input supplied' } } : {}) }];
