import type {
  AuthType,
  EdgeMailerOptions,
  SmtpTlsPolicy,
  XOAuth2AccessTokenProvider,
} from './smtp/mailer.ts'

export type ProviderProfileName =
  | 'custom'
  | 'google-workspace'
  | 'microsoft-365'
  | 'ses'
  | 'yandex'

export type ProviderProfile = {
  name: ProviderProfileName
  host: string
  port: number
  secure: boolean
  startTls: boolean
  tlsPolicy: SmtpTlsPolicy
  authType: AuthType[]
  notes: string[]
}

export type ProviderProfileOptions = {
  username?: string
  password?: string
  accessToken?: XOAuth2AccessTokenProvider
  region?: string
  host?: string
  port?: number
  secure?: boolean
  startTls?: boolean
  tlsPolicy?: SmtpTlsPolicy
  authType?: AuthType | AuthType[]
}

export function googleWorkspaceProfile(
  options: ProviderProfileOptions = {},
): EdgeMailerOptions & { provider: ProviderProfile } {
  return profileOptions(
    {
      name: 'google-workspace',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      startTls: true,
      tlsPolicy: 'require-starttls',
      authType: ['xoauth2'],
      notes: [
        'Prefer Gmail API for agent-native Google Workspace sends when available.',
        'SMTP XOAUTH2 access tokens need the https://mail.google.com/ scope.',
      ],
    },
    options,
  )
}

export function microsoft365Profile(
  options: ProviderProfileOptions = {},
): EdgeMailerOptions & { provider: ProviderProfile } {
  return profileOptions(
    {
      name: 'microsoft-365',
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      startTls: true,
      tlsPolicy: 'require-starttls',
      authType: ['xoauth2', 'login'],
      notes: [
        'Prefer Microsoft Graph sendMail when tenant policy allows.',
        'SMTP AUTH may be disabled by tenant or mailbox policy.',
      ],
    },
    options,
  )
}

export function sesSmtpProfile(
  options: ProviderProfileOptions = {},
): EdgeMailerOptions & { provider: ProviderProfile } {
  const region = options.region || 'us-east-1'
  return profileOptions(
    {
      name: 'ses',
      host: `email-smtp.${region}.amazonaws.com`,
      port: 587,
      secure: false,
      startTls: true,
      tlsPolicy: 'require-starttls',
      authType: ['plain', 'login'],
      notes: [
        'SES SMTP credentials are distinct from AWS access keys.',
        'Provider-managed DKIM is usually preferred for verified SES identities.',
      ],
    },
    options,
  )
}

export function yandexSmtpProfile(
  options: ProviderProfileOptions = {},
): EdgeMailerOptions & { provider: ProviderProfile } {
  return profileOptions(
    {
      name: 'yandex',
      host: 'smtp.yandex.com',
      port: 465,
      secure: true,
      startTls: false,
      tlsPolicy: 'require-tls',
      authType: ['xoauth2', 'plain', 'login'],
      notes: [
        'Yandex SMTP/XOAUTH2 is useful where a mailbox REST send API is not the preferred path.',
        'Review provider sending policy and rate limits before automated sends.',
      ],
    },
    options,
  )
}

export function customSmtpProfile(
  options: ProviderProfileOptions & { host: string },
): EdgeMailerOptions & { provider: ProviderProfile } {
  return profileOptions(
    {
      name: 'custom',
      host: options.host,
      port: options.port ?? 587,
      secure: options.secure ?? false,
      startTls: options.startTls ?? true,
      tlsPolicy: options.tlsPolicy ?? 'opportunistic',
      authType: normalizeAuthTypes(options.authType) || ['plain', 'login'],
      notes: [
        'Use capability probing to confirm STARTTLS, AUTH, SIZE, and DSN support.',
      ],
    },
    options,
  )
}

function profileOptions(
  profile: ProviderProfile,
  options: ProviderProfileOptions,
): EdgeMailerOptions & { provider: ProviderProfile } {
  const authType = normalizeAuthTypes(options.authType) || profile.authType
  return {
    host: options.host || profile.host,
    port: options.port ?? profile.port,
    secure: options.secure ?? profile.secure,
    startTls: options.startTls ?? profile.startTls,
    tlsPolicy: options.tlsPolicy ?? profile.tlsPolicy,
    authType,
    credentials: credentials(options),
    provider: {
      ...profile,
      host: options.host || profile.host,
      port: options.port ?? profile.port,
      secure: options.secure ?? profile.secure,
      startTls: options.startTls ?? profile.startTls,
      tlsPolicy: options.tlsPolicy ?? profile.tlsPolicy,
      authType,
    },
  }
}

function normalizeAuthTypes(
  authType: AuthType | AuthType[] | undefined,
): AuthType[] | undefined {
  if (!authType) {
    return undefined
  }
  return Array.isArray(authType) ? authType : [authType]
}

function credentials(options: ProviderProfileOptions) {
  if (!options.username) {
    return undefined
  }
  if (options.accessToken) {
    return {
      username: options.username,
      accessToken: options.accessToken,
    }
  }
  if (options.password) {
    return {
      username: options.username,
      password: options.password,
    }
  }
  return undefined
}
