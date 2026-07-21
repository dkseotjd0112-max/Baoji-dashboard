// ============================================================
// 공용 암호화 helper (worker.js에서 사용)
// - 브라우저(오프라인 비밀번호 생성기)와 서버(이 파일) 양쪽이
//   똑같은 Web Crypto API(crypto.subtle)를 쓰기 때문에, 여기 있는
//   해시 계산 로직은 비밀번호생성기_오프라인.html의 로직과 반드시
//   100% 동일해야 합니다(파라미터 하나라도 다르면 비밀번호가 절대
//   일치하지 않습니다).
// ============================================================

const PBKDF2_ITERATIONS = 100000;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toUrlSafe(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUrlSafe(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return b64;
}

// 비밀번호 + salt(base64, 없으면 새로 생성) -> {salt, hash} (둘 다 base64)
export async function pbkdf2Hash(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)) };
}

async function hmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// 세션 토큰 발급: {u:아이디, r:권한, exp:만료(epoch초)} -> "payload.서명" 문자열
export async function createSession(payloadObj, secret) {
  const payloadB64 = toUrlSafe(btoa(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = toUrlSafe(bytesToBase64(new Uint8Array(sig)));
  return payloadB64 + '.' + sigB64;
}

// 세션 토큰 검증: 서명이 맞고 만료 전이면 payload 객체 반환, 아니면 null
export async function verifySession(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const key = await hmacKey(secret);
  const sigBytes = base64ToBytes(fromUrlSafe(sigB64));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
  if (!valid) return null;

  let obj;
  try {
    obj = JSON.parse(atob(fromUrlSafe(payloadB64)));
  } catch (e) {
    return null;
  }

  if (obj.exp && Math.floor(Date.now() / 1000) > obj.exp) return null;
  return obj;
}

export function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}
