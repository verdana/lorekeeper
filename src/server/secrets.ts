/**
 * Encryption of sensitive config (API keys).
 *
 * The store is *injected* by the process that has one: the Electron main process
 * calls `configureSecretStore(safeStorage)`, which maps to macOS Keychain /
 * Windows DPAPI / Linux libsecret. Everywhere else (the dev server, plain Node,
 * tests) nothing is injected and keys are stored as plaintext — an explicit
 * choice rather than a side effect of a failed module load.
 *
 * Two rules this module must never break:
 *   - it never throws: a config that cannot be decrypted must still load, with
 *     the ciphertext passed through so the AI request reports an invalid key
 *     instead of the whole settings file failing to read;
 *   - it never destroys a value: text without the `enc:v1:` prefix is legacy
 *     plaintext and is returned untouched, in both directions.
 *
 * Ciphertext format: enc:v1:<base64>
 */

const CIPHER_PREFIX = 'enc:v1:'

/** The subset of Electron's `safeStorage` this module needs. */
export interface SecretStore {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

let secretStore: SecretStore | null = null

/** Point the secret layer at an OS-backed store, or at nothing (`null`). */
export function configureSecretStore(store: SecretStore | null): void {
  secretStore = store
}

/** True when secrets written now would actually be encrypted. */
export function isSecretStorageAvailable(): boolean {
  try {
    return secretStore?.isEncryptionAvailable() === true
  } catch {
    return false
  }
}

export function encryptSecret(plain: string | undefined): string | undefined {
  if (!plain) return plain
  if (plain.startsWith(CIPHER_PREFIX)) return plain
  if (!isSecretStorageAvailable()) return plain
  try {
    return `${CIPHER_PREFIX}${secretStore?.encryptString(plain).toString('base64')}`
  } catch {
    // An OS store that fails mid-flight must not cost the author their key:
    // storing it as plaintext is the same fallback as having no store at all.
    return plain
  }
}

export function decryptSecret(cipher: string | undefined): string | undefined {
  if (!cipher) return cipher
  if (!cipher.startsWith(CIPHER_PREFIX)) return cipher
  if (!isSecretStorageAvailable()) return cipher
  try {
    const buf = Buffer.from(cipher.slice(CIPHER_PREFIX.length), 'base64')
    return secretStore?.decryptString(buf) ?? cipher
  } catch {
    // 解密失败不抛错，避免整份配置无法读取；UI 里 AI 请求会报 key 无效。
    return cipher
  }
}
