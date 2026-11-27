import fs from 'node:fs';
import path from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { APP_NAME, token } from './config.mjs';

const signInRequired = 'OAuth sign-in required. Click OAuth Sign In in Connections.';
const refreshReplyReuseMs = 10_000;

export class OAuthStore {
  constructor(dir, defaultRedirectUrl) {
    this.dir = path.join(dir, 'oauth');
    this.defaultRedirectUrl = defaultRedirectUrl;
    this.pending = new Map();
    this.refreshRequests = new Map();
  }

  fileFor(serverId) {
    return path.join(this.dir, `${serverId}.json`);
  }

  read(serverId) {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(serverId), 'utf8'));
    } catch {
      return {};
    }
  }

  write(serverId, data) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(serverId);
    const temp = path.join(this.dir, `.save-${token()}`);
    try {
      fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  clear(serverId) {
    this.refreshRequests.delete(serverId);
    const file = this.fileFor(serverId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const [st, rec] of this.pending) {
      if (rec.serverId === serverId) this.pending.delete(st);
    }
  }

  hasTokens(serverId) {
    const d = this.read(serverId);
    return Boolean(d?.tokens?.access_token);
  }

  getStatus(serverId) {
    return this.hasTokens(serverId) ? 'connected' : 'required';
  }

  fetchFor(serverId) {
    return async (input, init) => {
      const params = init?.body;
      const refreshToken = params instanceof URLSearchParams && params.get('grant_type') === 'refresh_token'
        ? params.get('refresh_token') : null;
      if (!refreshToken) return fetch(input, init);

      const current = this.read(serverId).tokens;
      const requestKey = JSON.stringify([
        String(input), new Headers(init.headers).get('authorization'), params.toString()
      ]);
      const active = this.refreshRequests.get(serverId);
      // Concurrent SDK auth flows can present the same single-use refresh token.
      if (active?.requestKey === requestKey && active.until > Date.now() && current?.refresh_token) {
        if ((current.refresh_token === refreshToken && active.accessToken === current.access_token) ||
          active.rotatedToken === current.refresh_token) return (await active.response).clone();
      }
      if (current?.refresh_token !== refreshToken) throw new Error('OAuth credentials changed during refresh.');

      const entry = { requestKey, accessToken: current?.access_token, until: Infinity };
      const forget = () => {
        if (this.refreshRequests.get(serverId) === entry) this.refreshRequests.delete(serverId);
      };
      entry.response = fetch(input, init).then(async (response) => {
        const tokens = response.ok ? await response.clone().json().catch(() => null) : null;
        if (tokens?.access_token && tokens.refresh_token && tokens.refresh_token !== refreshToken) {
          entry.rotatedToken = tokens.refresh_token;
          entry.until = Date.now() + refreshReplyReuseMs;
        } else {
          forget();
        }
        return response;
      }, (error) => {
        forget();
        throw error;
      });
      this.refreshRequests.set(serverId, entry);
      return (await entry.response).clone();
    };
  }

  createProvider(serverId, redirectUrl, { onAuthorize, stateValue } = {}) {
    const store = this;
    const background = redirectUrl === undefined;
    const clientId = background ? store.read(serverId).clientInformation?.client_id : undefined;
    return {
      get redirectUrl() {
        if (!background) return redirectUrl;
        // The SDK uses a redirect URL to select the PKCE refresh flow, even on background requests.
        const saved = store.read(serverId);
        return saved.redirectUrl || saved.clientInformation?.redirect_uris?.[0] || store.defaultRedirectUrl();
      },
      get clientMetadata() {
        return {
          client_name: APP_NAME,
          redirect_uris: [String(this.redirectUrl)],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        };
      },
      state() {
        if (background) {
          // Only the admin sign-in action can start a new browser authorization flow.
          const current = store.read(serverId);
          if (current.tokens?.refresh_token) throw new Error('OAuth token refresh failed. Refresh the connection to retry.');
          if (current.tokens) {
            delete current.tokens;
            store.write(serverId, current);
          }
          throw new Error(signInRequired);
        }
        return stateValue || token().slice(0, 32);
      },
      clientInformation() {
        const cur = store.read(serverId);
        if (background && !cur.clientInformation) throw new Error(signInRequired);
        return cur.clientInformation;
      },
      ...(!background && {
        saveClientInformation(info) {
          const cur = store.read(serverId);
          store.write(serverId, { ...cur, clientInformation: info });
        }
      }),
      tokens() {
        return store.read(serverId).tokens;
      },
      saveTokens(tokens) {
        const cur = store.read(serverId);
        if (background && (!cur.clientInformation || cur.clientInformation.client_id !== clientId)) {
          throw new Error(signInRequired);
        }
        store.write(serverId, { ...cur, ...(!background && { redirectUrl: String(redirectUrl) }), tokens });
      },
      redirectToAuthorization(url) {
        if (onAuthorize) onAuthorize(url);
      },
      saveCodeVerifier(verifier) {
        const cur = store.read(serverId);
        store.write(serverId, { ...cur, codeVerifier: verifier });
      },
      codeVerifier() {
        const v = store.read(serverId).codeVerifier;
        if (!v) throw new Error('Missing OAuth PKCE code verifier.');
        return v;
      },
      invalidateCredentials(scope) {
        const cur = store.read(serverId);
        if (background && cur.clientInformation?.client_id !== clientId) return;
        if (scope === 'all') {
          store.clear(serverId);
        } else if (scope === 'tokens') {
          delete cur.tokens;
          store.write(serverId, cur);
        } else if (scope === 'client') {
          delete cur.clientInformation;
          store.write(serverId, cur);
        } else if (scope === 'verifier') {
          delete cur.codeVerifier;
          store.write(serverId, cur);
        }
      }
    };
  }

  async startAuth(server, redirectUrl) {
    // Prune stale pending flows (> 15 minutes)
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (now - v.at > 15 * 60_000) this.pending.delete(k);
    }

    const stateValue = token().slice(0, 32);
    let authorizeUrl = null;
    const provider = this.createProvider(server.id, redirectUrl, {
      stateValue,
      onAuthorize: (url) => {
        authorizeUrl = String(url);
      }
    });

    const outcome = await auth(provider, { serverUrl: new URL(server.url), fetchFn: this.fetchFor(server.id) });
    if (outcome === 'AUTHORIZED') {
      return { status: 'authorized' };
    }
    if (!authorizeUrl) {
      throw new Error('Upstream OAuth server did not return an authorization URL.');
    }
    let parsedAuthUrl;
    try {
      parsedAuthUrl = new URL(authorizeUrl);
    } catch {
      throw new Error('Upstream OAuth server returned an invalid authorization URL.');
    }
    const safeAuthScheme =
      parsedAuthUrl.protocol === 'https:' ||
      (parsedAuthUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedAuthUrl.hostname));
    if (!safeAuthScheme) {
      throw new Error('Upstream OAuth authorization URL must use HTTPS (or loopback HTTP).');
    }
    this.pending.set(stateValue, {
      serverId: server.id,
      serverUrl: server.url,
      redirectUrl: String(redirectUrl),
      at: now
    });
    return { status: 'redirect', authorizeUrl, state: stateValue };
  }

  async finishAuth(stateValue, code) {
    const flow = this.pending.get(stateValue);
    if (!flow) {
      throw new Error('Invalid or expired OAuth state.');
    }
    this.pending.delete(stateValue);
    const provider = this.createProvider(flow.serverId, flow.redirectUrl, { stateValue });
    const outcome = await auth(provider, {
      serverUrl: new URL(flow.serverUrl),
      authorizationCode: code
    });
    if (outcome !== 'AUTHORIZED') {
      throw new Error('OAuth token exchange did not complete.');
    }
    return { serverId: flow.serverId };
  }
}
