import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const scrypt = promisify(scryptCb) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;
const SCRYPT_N = 131072; // 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const JWT_TTL_SECONDS = 24 * 60 * 60;

export interface AdminAuth {
  login: string;
  passwordHash: string;
  jwtSecret: string;
  createdAt: string;
}

export function defaultAdminAuthFile(dshHome: string): string {
  return join(dshHome, "admin-auth.json");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(SALT_BYTES)): Promise<string> {
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![n, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(hashB64 ?? "", "base64url");
  const derived = (await scrypt(password, Buffer.from(saltB64 ?? "", "base64url"), expected.length, {
    N: n,
    r,
    p,
    maxmem: 256 * 1024 * 1024
  })) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export interface AdminAuthWithPassword extends AdminAuth {
  /** Plaintext password — returned to the caller exactly once, never written to the file. */
  plaintextPassword: string;
}

export async function createAdminAuth(): Promise<AdminAuthWithPassword> {
  const login = `balbes-${randomBytes(4).toString("hex")}`;
  const plaintextPassword = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(plaintextPassword);
  return {
    login,
    passwordHash,
    jwtSecret: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
    plaintextPassword
  };
}

interface JwtHeader { alg: "HS256"; typ: "JWT" }
interface JwtPayload { sub: string; iat: number; exp: number }

function sign(secret: string, header: JwtHeader, payload: JwtPayload): string {
  const enc = (o: unknown) => b64url(JSON.stringify(o));
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function issueToken(jwtSecret: string, login: string, ttlSeconds = JWT_TTL_SECONDS): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { sub: login, iat: now, exp: now + ttlSeconds };
  return { token: sign(jwtSecret, { alg: "HS256", typ: "JWT" }, payload), expiresAt: new Date((now + ttlSeconds) * 1000).toISOString() };
}

export function verifyToken(jwtSecret: string, token: string): { login: string; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let payload: JwtPayload;
  try {
    const header = JSON.parse(Buffer.from(h ?? "", "base64url").toString("utf8")) as JwtHeader;
    if (header.alg !== "HS256") return null;
    payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
  const expected = createHmac("sha256", jwtSecret).update(`${h}.${p}`).digest();
  const actual = Buffer.from(s ?? "", "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (payload.exp === undefined || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return { login: payload.sub, exp: payload.exp };
}

export async function writeAdminAuth(dshHome: string, auth: AdminAuth): Promise<void> {
  const file = defaultAdminAuthFile(dshHome);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  // tmp + rename is atomic within the same directory; fsync optional for stage-2.
  await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export async function loadAdminAuth(dshHome: string): Promise<AdminAuth> {
  const file = defaultAdminAuthFile(dshHome);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`admin auth file ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: AdminAuth;
  try {
    parsed = JSON.parse(raw) as AdminAuth;
  } catch {
    throw new Error(`admin auth file ${file} is not valid JSON`);
  }
  if (typeof parsed.login !== "string" || typeof parsed.passwordHash !== "string" || typeof parsed.jwtSecret !== "string") {
    throw new Error(`admin auth file ${file} misses required fields`);
  }
  return parsed;
}
