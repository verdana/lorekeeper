/**
 * Encryption/decryption of sensitive config (API keys).
 *
 * Electron 主进程里使用系统级安全存储（macOS Keychain / Windows DPAPI /
 * Linux libsecret），非 Electron 环境（pnpm start / pnpm dev:server）回退到
 * 明文，保证开发流程不依赖 safeStorage。
 *
 * Ciphertext format: enc:v1:<base64>
 * Only texts with this prefix are decrypted; unprefixed ones are legacy plaintext.
 */

const CIPHER_PREFIX = 'enc:v1:'

type SafeStorage = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

let cached: SafeStorage | null | undefined

function getSafeStorage(): SafeStorage | undefined {
  if (cached !== undefined) return cached ?? undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { safeStorage: SafeStorage }
    cached = electron.safeStorage ?? null
  } catch {
    cached = null
  }
  return cached ?? undefined
}

export function encryptSecret(plain: string | undefined): string | undefined {
  if (!plain) return plain
  if (plain.startsWith(CIPHER_PREFIX)) return plain
  const ss = getSafeStorage()
  if (!ss || !ss.isEncryptionAvailable()) return plain
  const buf = ss.encryptString(plain)
  return `${CIPHER_PREFIX}${buf.toString('base64')}`
}

export function decryptSecret(cipher: string | undefined): string | undefined {
  if (!cipher) return cipher
  if (!cipher.startsWith(CIPHER_PREFIX)) return cipher
  const ss = getSafeStorage()
  if (!ss || !ss.isEncryptionAvailable()) return cipher
  try {
    const buf = Buffer.from(cipher.slice(CIPHER_PREFIX.length), 'base64')
    return ss.decryptString(buf)
  } catch {
    // 解密失败不抛错，避免整份配置无法读取；UI 里 AI 请求会报 key 无效。
    return cipher
  }
}
