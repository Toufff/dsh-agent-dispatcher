export function projectGroups(projects, catalogs = {}, scope = 'business') {
  const groups = new Map();
  for (const p of projects) {
    const category = p.category || 'business';
    if (scope !== 'all' && (scope === 'business' ? category !== 'business' : category === 'business')) continue;
    const mapping = p.linear, key = mapping ? `linear:${mapping.workspaceId}:${mapping.projectId}` : `local:${p.id}`;
    const catalog = catalogs[mapping?.tokenEnv];
    const verified = mapping && catalog?.organization.id === mapping.workspaceId;
    const name = verified && catalog.projects.find(item => item.id === mapping.projectId)?.name;
    if (!groups.has(key)) groups.set(key, { key, ids: [], label: mapping
      ? name ? `${catalog.organization.name} / ${name}` : `${p.label}（Linear 名称待检查）`
      : `本地 / ${p.label}` });
    groups.get(key).ids.push(p.id);
  }
  return [...groups.values()];
}
