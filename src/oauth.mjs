import fs from 'node:fs';
import path from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { APP_NAME, token } from './config.mjs';

export class OAuthStore {
  constructor(dir) {
    this.dir = path.join(dir, 'oauth');
    this.pending = new Map();
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

  createProvider(serverId, redirectUrl, { onAuthorize, stateValue } = {}) {
    const store = this;
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata() {
        return {
          client_name: APP_NAME,
          redirect_uris: redirectUrl ? [String(redirectUrl)] : [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        };
      },
      state() {
        return stateValue || token().slice(0, 32);
      },
      clientInformation() {
        return store.read(serverId).clientInformation;
      },
      saveClientInformation(info) {
        const cur = store.read(serverId);
        store.write(serverId, { ...cur, clientInformation: info });
      },
      tokens() {
        return store.read(serverId).tokens;
      },
      saveTokens(tokens) {
        const cur = store.read(serverId);
        store.write(serverId, { ...cur, tokens });
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

    const outcome = await auth(provider, { serverUrl: new URL(server.url) });
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
