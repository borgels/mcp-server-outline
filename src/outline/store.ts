import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-user encrypted API-key store + one-time enrollment-state store.
 *
 * Outline API tokens are *personal* — each token inherits its creating user's
 * collection/document permissions. So this connector never holds a workspace-wide
 * service token: every user pastes their own key once, it is encrypted at rest
 * with AES-256-GCM (key derived from OUTLINE_ENCRYPTION_KEY) and keyed by the
 * gateway-verified identity. A user can only ever reach their own row, and thus
 * only ever sees what Outline already lets them see.
 *
 * Persisted to a JSON file on a Docker volume (survives restarts).
 */

export interface UserKey {
  apiToken: string;
  /** Outline identity the key resolved to at enrollment (auth.info), for display only. */
  outlineUserId?: string;
  outlineUserName?: string;
  outlineEmail?: string;
  workspaceName?: string;
  connectedAt: number;
}

/** What outline_status may reveal — never the token itself. */
export type UserKeyInfo = Omit<UserKey, 'apiToken'>;

interface EnrollState {
  user: string;
  createdAt: number;
}

interface Encrypted {
  iv: string;
  tag: string;
  data: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export class KeyStore {
  private readonly path: string;
  private readonly key: Buffer;
  private keys: Record<string, Encrypted> = {};
  private states: Record<string, EnrollState> = {};

  constructor(options: { path?: string; encryptionKey?: string } = {}) {
    this.path = options.path ?? process.env.OUTLINE_STORE_PATH ?? '/data/store.json';
    const secret = options.encryptionKey ?? process.env.OUTLINE_ENCRYPTION_KEY;
    if (!secret || secret.length < 16) {
      throw new Error('Missing/weak OUTLINE_ENCRYPTION_KEY (min 16 chars) — required to encrypt personal API keys at rest.');
    }
    this.key = createHash('sha256').update(secret).digest();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        keys?: Record<string, Encrypted>;
        states?: Record<string, EnrollState>;
      };
      this.keys = raw.keys ?? {};
      this.states = raw.states ?? {};
    } catch {
      this.keys = {};
      this.states = {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.store.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify({ keys: this.keys, states: this.states }), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace
  }

  private encrypt(value: UserKey): Encrypted {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private decrypt(enc: Encrypted): UserKey {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(enc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8')) as UserKey;
  }

  /** userKey normalizes the verified identity (lowercased UPN/oid). */
  static userKey(identity: string): string {
    return identity.trim().toLowerCase();
  }

  getKey(user: string): UserKey | undefined {
    const enc = this.keys[KeyStore.userKey(user)];
    return enc ? this.decrypt(enc) : undefined;
  }

  /** Connection metadata without the secret — safe to return from a tool. */
  getKeyInfo(user: string): UserKeyInfo | undefined {
    const record = this.getKey(user);
    if (!record) {
      return undefined;
    }
    const { apiToken: _apiToken, ...info } = record;
    return info;
  }

  setKey(user: string, record: UserKey): void {
    this.keys[KeyStore.userKey(user)] = this.encrypt(record);
    this.persist();
  }

  deleteKey(user: string): boolean {
    const key = KeyStore.userKey(user);
    if (!this.keys[key]) {
      return false;
    }
    delete this.keys[key];
    this.persist();
    return true;
  }

  // --- one-time enrollment state (binds the browser form to a verified user) ---

  createState(user: string): string {
    this.gcStates();
    const state = randomBytes(24).toString('base64url');
    this.states[state] = { user: KeyStore.userKey(user), createdAt: Date.now() };
    this.persist();
    return state;
  }

  /** Who a still-valid state belongs to, without spending it (GET renders the form). */
  peekState(state: string): string | undefined {
    this.gcStates();
    const entry = this.states[state];
    if (!entry || Date.now() - entry.createdAt > STATE_TTL_MS) {
      return undefined;
    }
    return entry.user;
  }

  consumeState(state: string): string | undefined {
    const user = this.peekState(state);
    if (this.states[state]) {
      delete this.states[state];
      this.persist();
    }
    return user;
  }

  private gcStates(): void {
    const now = Date.now();
    let changed = false;
    for (const [s, e] of Object.entries(this.states)) {
      if (now - e.createdAt > STATE_TTL_MS) {
        delete this.states[s];
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }
}
