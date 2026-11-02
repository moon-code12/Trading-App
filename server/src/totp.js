import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g).map((c) => ALPHABET[parseInt(c, 2)]).join('');
}

function decode(s) {
  const bits = [...s].map((c) => ALPHABET.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

export function code(secret, t = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', decode(secret)).update(counter).digest();
  const o = h[19] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

export function verify(secret, input, t = Date.now()) {
  return [-1, 0, 1].some((w) => code(secret, t + w * 30000) === String(input));
}

export const otpauthUrl = (secret, email) =>
  `otpauth://totp/TradeApp:${encodeURIComponent(email)}?secret=${secret}&issuer=TradeApp`;
