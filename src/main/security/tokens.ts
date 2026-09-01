import { safeStorage } from 'electron'

/**
 * Token vault. Plaintext GitLab PATs exist only in memory here and in the
 * client that uses them; at rest they are safeStorage ciphertext (OS keychain
 * on macOS, libsecret on Linux, DPAPI on Windows). The plaintext token never
 * crosses IPC: tRPC procedures receive a token string only transiently (add /
 * re-auth) and no procedure ever returns one.
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function encryptToken(plaintext: string): string {
  if (!isEncryptionAvailable()) {
    throw new Error(
      'Secure token storage is unavailable on this system (safeStorage reports encryption is not available). rivju refuses to store tokens in plaintext.',
    )
  }
  const buffer = safeStorage.encryptString(plaintext)
  return buffer.toString('base64')
}

export function decryptToken(ciphertextBase64: string): string {
  if (!isEncryptionAvailable()) {
    throw new Error(
      'Secure token storage is unavailable on this system, so stored tokens cannot be decrypted.',
    )
  }
  return safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64'))
}
