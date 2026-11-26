// Linear credentials for the bot account (OAuth client credentials) and for a personal API key bound through
// settings.linear. Only fixed official endpoints are used: nothing in an issue, a comment or a response can
// redirect where a credential is sent. The access token lives in memory only; status() exposes expiry
// metadata and errors, never the token or the client secret.
export const TOKEN_URL = 'https://api.linear.app/oauth/token';
export const GRAPHQL_URL = 'https://api.linear.app/graphql';
export const DEFAULT_SCOPE = 'read,write,app:assignable,app:mentionable';
export const REFRESH_BEFORE_MS = 3 * 86400e3;
const MIN_VALID_MS = 60e3, IDENTITY_TTL_MS = 10 * 60e3, MAX_BACKOFF_MS = 30 * 60e3;
const backoff = n => Math.min(MAX_BACKOFF_MS, 60e3 * 2 ** Math.min(Math.max(n, 1) - 1, 5));
/** Refresh threshold: 3 days, or half the token's lifetime when that is shorter (no refresh on every call). */
export const refreshBefore = ttlMs => Math.min(REFRESH_BEFORE_MS, Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs / 2 : REFRESH_BEFORE_MS);

const authError = (message, code = 'LINEAR_AUTH') => Object.assign(new Error(message), { code });

/** Stable identity of a credential block (no secret values; env var names only). */
export function credentialKey(auth) {
  if (!auth) return null;
  return auth.mode === 'clientCredentials'
    ? `cc:${auth.clientIdEnv}:${auth.clientSecretEnv}:${auth.scope || DEFAULT_SCOPE}`
    : `key:${auth.tokenEnv}`;
}
/** Env var names a credential reads (kept out of executor environments). */
export const credentialEnvNames = auth => !auth ? [] : auth.mode === 'clientCredentials' ? [auth.clientIdEnv, auth.clientSecretEnv] : [auth.tokenEnv];

export class LinearCredential {
  constructor(auth, { env = process.env, fetcher = fetch, now = Date.now } = {}) {
    this.auth = auth; this.env = env; this.fetcher = fetcher; this.now = now;
    this.key = credentialKey(auth); this.failures = 0;
    // Consecutive rejections (401 / AUTHENTICATION_ERROR) of tokens the endpoint issued. Not reset by a new token,
    // only by a request the API accepted: a revoked app keeps getting tokens that GraphQL refuses.
    this.authFailures = 0;
  }
  get oauth() { return this.auth.mode === 'clientCredentials'; }
  bearer() { return `Bearer ${this.token}`; }
  /** The Authorization header value. Proactive refresh, single-flight, fail closed when no valid token exists. */
  async authorization() {
    if (!this.oauth) {
      const key = this.env[this.auth.tokenEnv];
      if (!key) throw authError(`缺少环境变量 ${this.auth.tokenEnv}`);
      return key;
    }
    const left = () => (this.token ? this.expiresAt - this.now() : -1);
    if (left() > refreshBefore(this.ttlMs)) return this.bearer();
    if (!this.refreshing) {
      // After a failure the token endpoint is not called again until the backoff ends.
      if (this.retryAt > this.now()) {
        if (left() > MIN_VALID_MS) return this.bearer();
        throw authError(this.error || 'Linear 机器人令牌不可用');
      }
      this.refreshing = this.fetchToken().finally(() => { this.refreshing = null; });
    }
    try { await this.refreshing; }
    catch (error) {
      // A proactive refresh that failed keeps using the still-valid token; without one, fail closed.
      if (left() > MIN_VALID_MS) return this.bearer();
      throw error;
    }
    return this.bearer();
  }
  async fetchToken() {
    const id = this.env[this.auth.clientIdEnv], secret = this.env[this.auth.clientSecretEnv];
    try {
      if (!id || !secret) throw authError(`缺少环境变量 ${!id ? this.auth.clientIdEnv : this.auth.clientSecretEnv}`);
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: this.auth.scope || DEFAULT_SCOPE });
      let response;
      try {
        response = await this.fetcher(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(), signal: AbortSignal.timeout(15000) });
      } catch { throw authError('Linear 机器人令牌请求失败（网络）'); }
      if (!response.ok) throw authError(`Linear 机器人令牌请求被拒绝（HTTP ${response.status}）`);
      let data;
      try { data = await response.json(); } catch { throw authError('Linear 机器人令牌响应无法解析'); }
      const ttl = Number(data?.expires_in);
      if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(ttl) || ttl <= 0)
        throw authError('Linear 机器人令牌响应缺少 access_token 或 expires_in');
      this.token = data.access_token; this.fetchedAt = this.now(); this.ttlMs = ttl * 1000; this.expiresAt = this.fetchedAt + this.ttlMs;
      this.failures = 0; this.retryAt = 0; this.error = null;
      this.identityAt = 0;   // a new token is checked against the expected bot again
    } catch (error) {
      this.failures++;
      this.retryAt = this.now() + backoff(this.failures);
      this.error = error.code === 'LINEAR_AUTH' ? error.message : 'Linear 机器人令牌获取失败';
      throw error.code === 'LINEAR_AUTH' ? error : authError(this.error);
    }
  }
  /** A request was rejected as unauthenticated with this header: drop the token so the next call refreshes. */
  // The first rejection refreshes at once (an expired or rotated token). A rejection of a token issued after an
  // earlier rejection starts an exponential backoff: until it ends requests fail closed without calling the token
  // endpoint (a revoked app, a missing scope, or another process re-issuing and voiding our token).
  invalidate(header) {
    if (!this.oauth || !this.token || header !== this.bearer()) return;
    this.authFailures++;
    this.token = null; this.expiresAt = 0;
    this.retryAt = this.authFailures > 1 ? this.now() + backoff(this.authFailures - 1) : 0;
    if (this.authFailures > 1) this.error = `Linear 拒绝了机器人令牌（连续 ${this.authFailures} 次），退避后再试`;
  }
  /** The API accepted a request made with this header: rejections are no longer consecutive. */
  accepted(header) { if (this.oauth && this.token && header === this.bearer()) this.authFailures = 0; }
  /** viewer { id app } of this credential, cross-checked with botUserId and workspaceId (mismatch fails closed). */
  identity() {
    if (this.identityValue && this.now() - this.identityAt < IDENTITY_TTL_MS) {
      if (this.identityError) return Promise.reject(authError(this.identityError, 'LINEAR_IDENTITY_MISMATCH'));
      return Promise.resolve(this.identityValue);
    }
    this.identifying ||= this.readIdentity().finally(() => { this.identifying = null; });
    return this.identifying;
  }
  async readIdentity() {
    const authorization = await this.authorization();
    let response;
    try {
      response = await this.fetcher(GRAPHQL_URL, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query { viewer { id name app } organization { id } }', variables: {} }), signal: AbortSignal.timeout(15000) });
    } catch { throw authError('Linear 身份查询失败（网络）'); }
    if (response.status === 401) { this.invalidate(authorization); throw authError('Linear 身份查询未通过认证'); }
    if (!response.ok) throw authError(`Linear 身份查询失败（HTTP ${response.status}）`);
    const data = (await response.json().catch(() => ({})))?.data;
    if (!data?.viewer?.id) throw authError('Linear 身份查询没有返回 viewer');
    // A readable viewer does not end a rejection streak (only a real request accepted by LinearClient does).
    const value = { id: data.viewer.id, name: data.viewer.name || '', app: Boolean(data.viewer.app), organizationId: data.organization?.id || null };
    this.identityValue = value; this.identityAt = this.now(); this.identityError = null;
    if (this.auth.botUserId && value.id !== this.auth.botUserId)
      this.identityError = `Linear 凭据身份与配置的 botUserId 不一致（实际 ${value.id}），已停止接单与回写`;
    else if (this.auth.botUserId && !value.app)
      this.identityError = 'Linear 凭据不是应用账号（viewer.app=false），不能作为机器人使用，已停止接单与回写';
    else if (this.auth.workspaceId && value.organizationId && value.organizationId !== this.auth.workspaceId)
      this.identityError = 'Linear 凭据属于另一个工作区，已停止接单与回写';
    if (this.identityError) throw authError(this.identityError, 'LINEAR_IDENTITY_MISMATCH');
    return value;
  }
  /** Header for a request, after the identity check passed. */
  async ready() { await this.identity(); return this.authorization(); }
  status() {
    return { key: this.key, id: this.auth.id, mode: this.auth.mode, botUserId: this.auth.botUserId || null,
      viewer: this.identityValue || null, tokenExpiresAt: this.oauth && this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      tokenFetchedAt: this.oauth && this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      error: this.identityError || this.error || null };
  }
}

/** One credential object per block, shared by every client so refresh and identity checks are single-flight. */
export class LinearCredentials {
  constructor(options = {}) { this.options = options; this.map = new Map(); }
  get(auth) {
    const key = credentialKey(auth);
    let credential = this.map.get(key);
    // Changed botUserId/workspaceId on the same env names starts a fresh check.
    if (credential && (credential.auth.botUserId !== auth.botUserId || credential.auth.workspaceId !== auth.workspaceId)) credential = null;
    if (!credential) { credential = new LinearCredential(auth, this.options); this.map.set(key, credential); }
    credential.auth = auth;
    return credential;
  }
  status() { return [...this.map.values()].map(c => c.status()); }
}
