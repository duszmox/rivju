const packageJson = require('./package.json')

const nightly = /-nightly\.\d{8}\.\d+$/.test(packageJson.version)
const channel = nightly ? 'nightly' : 'latest'
const signingRequired = process.env.RIVJU_REQUIRE_SIGNING === '1'

function requireEnvironment(names, platform) {
  if (!signingRequired) return
  const missing = names.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `${platform} release signing is missing: ${missing.join(', ')}`,
    )
  }
}

if (process.platform === 'darwin') {
  requireEnvironment(
    [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
    ],
    'macOS',
  )
}

const azureSignOptions =
  signingRequired && process.platform === 'win32'
    ? (() => {
        requireEnvironment(
          [
            'AZURE_TENANT_ID',
            'AZURE_CLIENT_ID',
            'AZURE_CLIENT_SECRET',
            'AZURE_TRUSTED_SIGNING_ENDPOINT',
            'AZURE_TRUSTED_SIGNING_ACCOUNT',
            'AZURE_TRUSTED_SIGNING_PROFILE',
            'WINDOWS_PUBLISHER_NAME',
          ],
          'Windows',
        )
        return {
          endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
          codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
          certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_PROFILE,
          publisherName: process.env.WINDOWS_PUBLISHER_NAME,
        }
      })()
    : undefined

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: nightly ? 'app.rivju.desktop.nightly' : 'app.rivju.desktop',
  productName: nightly ? 'rivju Nightly' : 'rivju',
  artifactName: `rivju-\${version}-\${os}-\${arch}.\${ext}`,
  extraMetadata: {
    rivjuChannel: nightly ? 'nightly' : 'stable',
  },
  directories: {
    output: 'release',
  },
  files: ['out/**'],
  asarUnpack: ['**/*.node', 'node_modules/@anthropic-ai/claude-agent-sdk-*/**'],
  extraResources: [{ from: 'drizzle', to: 'drizzle' }],
  publish: [
    {
      provider: 'github',
      owner: 'duszmox',
      repo: 'rivju',
      releaseType: nightly ? 'prerelease' : 'release',
      ...(nightly ? { channel } : {}),
    },
  ],
  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    identity: signingRequired ? undefined : null,
    notarize: signingRequired,
  },
  dmg: {
    title: `${nightly ? 'rivju Nightly' : 'rivju'} ${packageJson.version}`,
  },
  win: {
    icon: 'build/icon.png',
    target: ['nsis'],
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  nsis: {
    differentialPackage: true,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    icon: 'build/icon.png',
    target: ['AppImage'],
    category: 'Development',
    executableName: nightly ? 'rivju-nightly' : 'rivju',
  },
}
