import { afterEach, describe, expect, it } from 'vitest'
import {
  configureSecretStore,
  decryptSecret,
  encryptSecret,
  isSecretStorageAvailable,
  type SecretStore,
} from '../../src/server/secrets'

/**
 * API-key storage. This is the one server module that handles secrets, and its
 * contract has two branches: encrypt through the injected OS store when there is
 * one, and degrade to plaintext without ever throwing. Both are asserted here,
 * including the "the config must stay readable" rule for a key that can no
 * longer be decrypted.
 */
function store(
  options: { available?: boolean; failDecrypt?: boolean; failEncrypt?: boolean } = {},
): SecretStore {
  return {
    isEncryptionAvailable: () => options.available !== false,
    encryptString: (plain) => {
      if (options.failEncrypt) throw new Error('keychain locked')
      return Buffer.from(`sealed:${plain}`, 'utf-8')
    },
    decryptString: (cipher) => {
      if (options.failDecrypt) throw new Error('keychain locked')
      const text = cipher.toString('utf-8')
      if (!text.startsWith('sealed:')) throw new Error('not ours')
      return text.slice('sealed:'.length)
    },
  }
}

afterEach(() => {
  configureSecretStore(null)
})

describe('without a secret store', () => {
  it('passes plaintext through both ways and never mangles it', () => {
    expect(isSecretStorageAvailable()).toBe(false)
    expect(encryptSecret('sk-test-key')).toBe('sk-test-key')
    expect(decryptSecret('sk-test-key')).toBe('sk-test-key')
  })

  it('leaves absent values absent', () => {
    expect(encryptSecret(undefined)).toBeUndefined()
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret(undefined)).toBeUndefined()
    expect(decryptSecret('')).toBe('')
  })

  it('returns a stored ciphertext unchanged rather than an empty key', () => {
    // Reading a config written by the desktop app from the dev server must not
    // destroy the only copy of the key.
    expect(decryptSecret('enc:v1:QUJD')).toBe('enc:v1:QUJD')
  })
})

describe('with a secret store', () => {
  it('round-trips a key and hides it in the stored form', () => {
    configureSecretStore(store())
    expect(isSecretStorageAvailable()).toBe(true)

    const stored = encryptSecret('sk-1234567890')
    expect(stored).toMatch(/^enc:v1:/)
    expect(stored).not.toContain('sk-1234567890')
    expect(decryptSecret(stored)).toBe('sk-1234567890')
  })

  it('does not double-wrap an already encrypted value', () => {
    configureSecretStore(store())
    const once = encryptSecret('sk-abc')!
    expect(encryptSecret(once)).toBe(once)
  })

  it('leaves legacy plaintext readable', () => {
    // Configs written before encryption existed carry no prefix.
    configureSecretStore(store())
    expect(decryptSecret('legacy-plain-key')).toBe('legacy-plain-key')
  })

  it('falls back to the ciphertext when the key can no longer be decrypted', () => {
    // A locked keychain must not take the whole config down with it: the caller
    // gets a value that later fails as an invalid key instead of a read error.
    configureSecretStore(store({ failDecrypt: true }))
    expect(decryptSecret('enc:v1:c2VhbGVkOnNrLTE=')).toBe('enc:v1:c2VhbGVkOnNrLTE=')
  })

  it('stores plaintext when the store reports encryption unavailable', () => {
    configureSecretStore(store({ available: false }))
    expect(isSecretStorageAvailable()).toBe(false)
    expect(encryptSecret('sk-plain')).toBe('sk-plain')
  })

  it('stores plaintext when encryption fails, rather than losing the key', () => {
    configureSecretStore(store({ failEncrypt: true }))
    expect(encryptSecret('sk-keep-me')).toBe('sk-keep-me')
  })

  it('treats a throwing availability check as unavailable', () => {
    configureSecretStore({
      isEncryptionAvailable: () => {
        throw new Error('no keyring')
      },
      encryptString: () => Buffer.from(''),
      decryptString: () => '',
    })
    expect(isSecretStorageAvailable()).toBe(false)
    expect(encryptSecret('sk-x')).toBe('sk-x')
  })
})
