// WebCrypto(PBKDF2) によるパスワードハッシュ。
// node:crypto の scrypt と違い Node / Cloudflare Workers の両方で動く（Workers 互換が要件）。

const ITERATIONS = 100_000;
const KEY_LEN = 32; // bytes

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  // ArrayBuffer 裏付けの Uint8Array にコピーして、node/dom 両 lib の BufferSource 差を回避する
  // （DOM 型名 BufferSource を使わずに済ませる）。
  const passBytes = new Uint8Array(new TextEncoder().encode(password));
  const saltBytes = new Uint8Array(salt);
  const key = await crypto.subtle.importKey("raw", passBytes, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

/** `salt:hash`（16進）形式で保存する。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  return `${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = fromHex(hashHex);
  const actual = await derive(password, fromHex(saltHex));
  if (expected.length !== actual.length) return false;
  // 定数時間比較
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ actual[i]!;
  return diff === 0;
}
