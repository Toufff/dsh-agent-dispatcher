import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGroups } from '../src/ui/project-view.js';
test('real project identity groups local mappings and keeps test history separate', () => {
  const mapping = { workspaceId: 'w', projectId: 'p', tokenEnv: 'TOKEN' };
  const projects = [{ id: 'a', label: 'Business', linear: mapping }, { id: 'b', label: 'Second folder', linear: mapping },
    { id: 'test', label: 'Test', category: 'test', linear: mapping }, { id: 'local', label: 'Local test', category: 'archive' }];
  const catalogs = { TOKEN: { organization: { id: 'w', name: 'Workspace' }, projects: [{ id: 'p', name: 'Real project' }] } };
  assert.deepEqual(projectGroups(projects, catalogs), [{ key: 'linear:w:p', ids: ['a','b'], label: 'Workspace / Real project' }]);
  assert.deepEqual(projectGroups(projects, catalogs, 'history').map(g => g.ids), [['test'],['local']]);
  assert.equal(projectGroups(projects, catalogs, 'all').length, 2);
  const otherWorkspace = [...projects, { id: 'other', label: 'Other workspace', linear: { ...mapping, workspaceId: 'other' } }];
  assert.equal(projectGroups(otherWorkspace, catalogs).length, 2);
  assert.match(projectGroups(otherWorkspace, catalogs).at(-1).label, /名称待检查/);
});
