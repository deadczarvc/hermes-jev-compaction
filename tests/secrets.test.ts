import { describe, expect, it } from 'vitest';
import { buildJevRequest, redactField, redactForEgress, redactJson, redactSecrets } from '../src/index.js';

// Sample values are built at run time: no key-shaped literal sits in the repository (push protection, sweeps).
const body = (n: number) => 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0'.repeat(4).slice(0, n);
const samples: Array<[string, string]> = [
  ['sk-proj', `sk-${'proj'}-${body(40)}`],
  ['sk-ant', `sk-${'ant'}-api03-${body(40)}`],
  ['sk', `sk-${body(32)}`],
  ['github-pat', `github${'_pat_'}${body(40)}`],
  ['gh-token', `gh${'p_'}${body(36)}`],
  ['hf', `hf${'_'}${body(34)}`],
  ['google-api', `AI${'za'}${body(35)}`],
  ['aws-akia', `AK${'IA'}${'ABCDEFGHIJKLMNOP'}`],
  ['jwt', `ey${'J'}${body(20)}.${body(24)}.${body(30)}`],
  ['sakana', `fish${'_'}${body(30)}`],
  ['bearer', `Authorization: Bearer ${body(40)}`],
];

describe('redactSecrets', () => {
  for (const [family, value] of samples) {
    it(`masks a ${family} value and keeps the text around it`, () => {
      const out = redactSecrets(`before ${value} after`);
      expect(out).not.toContain(value.slice(-12));
      expect(out).toContain('[REDACTED:');
      expect(out.startsWith('before ')).toBe(true);
      expect(out.endsWith(' after')).toBe(true);
    });
  }

  it('masks a private key block', () => {
    const pem = `-----BEGIN ${'RSA PRIVATE'} KEY-----\n${body(64)}\n-----END ${'RSA PRIVATE'} KEY-----`;
    expect(redactSecrets(pem)).toBe('[REDACTED:private-key]');
  });

  it('leaves placeholders, field names and ordinary facts alone', () => {
    const text = [
      `api_key: sk-${'x'.repeat(24)}`,
      'TYPESAFE_API_KEY is read from the environment',
      'HTTP 404 from /oauth, pid 40211, commit 9f3c2a1b',
      'task-0035042d842444bd',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('masks the password of a URL and keeps the user and host', () => {
    const out = redactSecrets(`DATABASE_URL=postgres://admin:${body(16)}@db.internal:5432/app`);
    expect(out).not.toContain(body(16));
    expect(out).toContain('postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app');
  });

  it('leaves assignments and flags to the egress layer', () => {
    const text = `OPENAI_API_KEY=${body(24)} --token ${body(20)}`;
    expect(redactSecrets(text)).toBe(text);
  });
});

// Egress rules adapted from fast-jev-compaction#98 (socialadsmentor): what leaves the machine for Jev is masked harder
// than a saved copy, which an agent reads back and should not lose ordinary values from.
describe('redactForEgress', () => {
  it('masks the value of a key-like assignment and keeps the name', () => {
    for (const [line, kept] of [
      [`export OPENAI_API_KEY=${body(24)}`, 'export OPENAI_API_KEY='],
      [`{"apiKey": "${body(24)}"}`, '{"apiKey": "'],
      [`password: ${body(12)}`, 'password: '],
      [`client_secret = '${body(30)}'`, "client_secret = '"],
    ] as const) {
      const out = redactForEgress(line);
      expect(out).toContain(`${kept}[REDACTED:assignment]`);
      expect(out).not.toContain(body(12));
    }
  });

  it('masks the value of a credential flag', () => {
    const out = redactForEgress(`curl --api-key ${body(20)} https://x.example`);
    expect(out).toBe('curl --api-key [REDACTED:flag] https://x.example');
  });

  it('replaces a value it is told about wherever it appears', () => {
    const key = `ts_${body(28)}`;
    expect(redactForEgress(`the key ${key} and ${key}.`, [key])).toBe('the key [REDACTED:known] and [REDACTED:known].');
  });

  it('leaves code, references, paths and placeholders alone', () => {
    const text = [
      'const apiKey = process.env.TYPESAFE_API_KEY;',
      'token = $GITHUB_TOKEN',
      'key: ./certs/server.pem',
      'secret: true',
      `api_key: sk-${'x'.repeat(24)}`,
      'auth: config.auth.provider',
      'primary key (id) from the table',
    ].join('\n');
    expect(redactForEgress(text)).toBe(text);
  });

  it('applies the secret families too', () => {
    expect(redactForEgress(`gh${'p_'}${body(36)}`)).toBe('[REDACTED:gh-token]');
  });
});

describe('redactJson', () => {
  it('masks every string of a tool input, keeps keys and other types, and does not touch the input', () => {
    const secret = `sk-${'ant'}-api03-${body(40)}`;
    const input = { messages: [{ text: `use ${secret}`, n: 3, ok: true, none: null }] };
    const copy = structuredClone(input);
    expect(redactJson(input)).toEqual({ messages: [{ text: 'use [REDACTED:sk-ant]', n: 3, ok: true, none: null }] });
    expect(input).toEqual(copy);
  });
});

describe('families found by the egress review', () => {
  const cases: Array<[string, string, string]> = [
    ['a private key cut before its END', `-----BEGIN ${'PRIVATE'} KEY-----\n${body(64)}\n${body(64)}`, '[REDACTED:private-key]'],
    ['a PGP private key block', `-----BEGIN PGP ${'PRIVATE'} KEY BLOCK-----\n\n${body(64)}\n-----END PGP ${'PRIVATE'} KEY BLOCK-----`, '[REDACTED:private-key]'],
    ['a Telegram token in its bot URL', `https://api.telegram.org/bot1234567890:AA${body(35)}/sendMessage`, 'https://api.telegram.org/bot[REDACTED:telegram]/sendMessage'],
    ['a Stripe live key', `charged with sk${'_live_'}${body(24)}`, 'charged with [REDACTED:stripe]'],
    ['a Slack webhook', `https://hooks.slack.com/services/T0ABC123/B0DEF456/${body(24)}`, 'https://[REDACTED:slack-webhook]'],
    ['a URL password with an empty user', `redis://:${body(16)}@cache.internal:6379`, 'redis://:[REDACTED:url-credentials]@cache.internal:6379'],
  ];
  for (const [what, text, masked] of cases) {
    it(`masks ${what}`, () => expect(redactSecrets(text)).toBe(masked));
  }

  it('leaves ports, queries, references and prefix-like words inside names alone', () => {
    const text = [
      'http://localhost:8080/login?next=/a@b',
      'postgres://admin:${DB_PASS}@db/app',
      `chunk_${'0123456789abcdef'.repeat(2)} link_${body(24)}`,
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('stays linear on many unterminated BEGIN lines and eyJ runs', () => {
    const text = `-----BEGIN ${'PRIVATE'} KEY----- x\n`.repeat(2_000) + `eyJ${body(16)}`.repeat(50_000);
    const started = Date.now();
    redactSecrets(text);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('egress rules found by the review', () => {
  const masked: Array<[string, string]> = [
    [`export DB_PASSWORD="${body(16)}"`, 'export DB_PASSWORD="[REDACTED:assignment]"'],
    [`{"dbPassword": "${body(14)}"}`, '{"dbPassword": "[REDACTED:assignment]"}'],
    [`{"accessToken": "${body(40)}"}`, '{"accessToken": "[REDACTED:assignment]"}'],
    [`"SecretAccessKey": "${body(20)}"`, '"SecretAccessKey": "[REDACTED:assignment]"'],
    [`"SessionToken": "${body(60)}"`, '"SessionToken": "[REDACTED:assignment]"'],
    [`PGPASSWORD=${body(16)} psql`, 'PGPASSWORD=[REDACTED:assignment] psql'],
    [`DB_PASSWORD=$uper${body(8)}!2024`, 'DB_PASSWORD=[REDACTED:assignment]'],
    [`password:\n  ${body(16)}`, 'password:\n  [REDACTED:assignment]'],
    [`curl -u admin:${body(16)} https://x.example`, 'curl -u admin:[REDACTED:flag] https://x.example'],
    [`mysql -uroot -p${body(12)} app`, 'mysql -uroot -p[REDACTED:flag] app'],
    [`Cookie: sessionid=${body(32)}`, 'Cookie: sessionid=[REDACTED:cookie]'],
    [`machine api.example.com login me password ${body(16)}`, 'machine api.example.com login me password [REDACTED:netrc]'],
    [`old key was ab_${body(44)} rotated`, 'old key was [REDACTED:prefixed] rotated'],
  ];
  for (const [line, out] of masked) {
    it(`masks ${line.slice(0, 24)}…`, () => expect(redactForEgress(line)).toBe(out));
  }

  it('leaves references, URLs, Windows paths and env names alone', () => {
    const text = [
      'token = ${GITHUB_TOKEN}',
      'secret: %APP_SECRET%',
      'auth: https://login.example.com/oauth',
      'key: C:\\certs\\server.pem',
      'token: GITHUB_TOKEN_NAME',
      'mkdir -p build && mysql --version',
      `git log -p ${'abcdef0'}`,
    ].join('\n');
    expect(redactForEgress(text)).toBe(text);
  });
});

describe('third review round', () => {
  const P = 'Xk9mP2vL7qR4tYu8';
  const familyCases: Array<[string, string, string]> = [
    ['an npm token', `npm${'_'}${body(36)}`, '[REDACTED:npm]'],
    ['a PyPI token', `pypi-AgE${body(60)}`, '[REDACTED:pypi]'],
    ['a Stripe webhook secret', `whsec${'_'}${body(32)}`, '[REDACTED:stripe-webhook]'],
    ['a Shopify token', `shpat${'_'}${'0123456789abcdef'.repeat(2)}`, '[REDACTED:shopify]'],
    ['an age key', `AGE-SECRET-KEY-1${'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'.repeat(2)}`, '[REDACTED:age-key]'],
    ['an Azure SAS signature', `https://a.blob.core.windows.net/c?sv=2024&sig=${body(30)}%3D`, 'https://a.blob.core.windows.net/c?sv=2024&sig=[REDACTED:azure-sas]'],
    ['an Azure account key', `DefaultEndpointsProtocol=https;AccountKey=${body(40)}==;EndpointSuffix=x`, 'DefaultEndpointsProtocol=https;AccountKey=[REDACTED:azure-key];EndpointSuffix=x'],
    ['a key after a JSON escape', `{"out":"line\\nhf${'_'}${body(34)}"}`, '{"out":"line\\n[REDACTED:hf]"}'],
    ['an indented key body cut short', `key: |\n  -----BEGIN ${'PRIVATE'} KEY-----\n  ${body(64)}\n  ${body(40)}`, 'key: |\n  [REDACTED:private-key]'],
    ['a lowercase bearer token', `authorization: bearer ${body(32)}`, 'authorization: bearer [REDACTED:bearer]'],
  ];
  for (const [what, text, out] of familyCases) {
    it(`masks ${what} in a saved copy`, () => expect(redactSecrets(text)).toBe(out));
  }

  it('leaves a lone PEM header, auth-params and type names in a saved copy alone', () => {
    const text = [
      `if (pem.startsWith('-----BEGIN ${'PRIVATE'} KEY-----'))`,
      'const parseKey = (s: string) => s;',
      'WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      'Token identifierOrKeywordToken = scanner.next();',
      'Basic authentication is disabled',
      'complete -c fish -a "(__fish_complete_directories_and_files_please)"',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  const egressCases: Array<[string, string]> = [
    [`export DB_PASSWORD='Xk9;mP2#vL7qR4'`, `export DB_PASSWORD='[REDACTED:assignment]'`],
    ['"password": "correct horse battery staple"', '"password": "[REDACTED:assignment]"'],
    [`DB_PASS=${P}`, 'DB_PASS=[REDACTED:assignment]'],
    [`SMTP_PASS: ${P}`, 'SMTP_PASS: [REDACTED:assignment]'],
    [`ssh_passphrase=${P}`, 'ssh_passphrase=[REDACTED:assignment]'],
    [`$env:DB_PASS = "${P}"`, '$env:DB_PASS = "[REDACTED:assignment]"'],
    [`{"masterKey": "${P}"}`, '{"masterKey": "[REDACTED:assignment]"}'],
    [`token: |\n  ${P}`, 'token: |\n  [REDACTED:assignment]'],
    [`Authorization: Basic ${body(24)}==`, 'Authorization: Basic [REDACTED:authorization]'],
    [`Authorization: Bot ${body(40)}`, 'Authorization: Bot [REDACTED:authorization]'],
    [`Authorization: ApiKey ${body(30)}`, 'Authorization: ApiKey [REDACTED:authorization]'],
    [`Authorization: lin_api_${body(16)}`, 'Authorization: [REDACTED:authorization]'],
    [`docker login -u bob -p ${P} registry.example.com`, 'docker login -u bob -p [REDACTED:flag] registry.example.com'],
    [`sshpass -p ${P} ssh bob@host`, 'sshpass -p [REDACTED:flag] ssh bob@host'],
    [`redis-cli -h host -a ${P} ping`, 'redis-cli -h host -a [REDACTED:flag] ping'],
    [`openssl pkcs12 -export -in c.pem -passout pass:${P}`, 'openssl pkcs12 -export -in c.pem -passout pass:[REDACTED:assignment]'],
    [`keytool -list -keystore k.jks -storepass ${P}`, 'keytool -list -keystore k.jks -storepass [REDACTED:flag]'],
    [`ldapsearch -x -D cn=admin -w ${P}`, 'ldapsearch -x -D cn=admin -w [REDACTED:flag]'],
    [`cmdkey /generic:srv /user:bob /pass:${P}`, 'cmdkey /generic:srv /user:bob /pass:[REDACTED:assignment]'],
    [`ConvertTo-SecureString "${P}" -AsPlainText -Force`, 'ConvertTo-SecureString "[REDACTED:flag]" -AsPlainText -Force'],
    [`tool deploy --access-token ${P}`, 'tool deploy --access-token [REDACTED:flag]'],
    [`curl -H "Cookie: theme=dark; sessionid=${body(24)}" https://x`, 'curl -H "Cookie: theme=dark; sessionid=[REDACTED:cookie]" https://x'],
    [`curl -b "session=${body(24)}" https://x`, 'curl -b "session=[REDACTED:cookie]" https://x'],
  ];
  for (const [line, out] of egressCases) {
    it(`masks ${line.slice(0, 28)}… on the way out`, () => expect(redactForEgress(line)).toBe(out));
  }

  it('leaves MCP tool names, YAML structure, kwargs and generics alone on the way out', () => {
    const text = [
      'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch',
      'env:\n  NPM_TOKEN:\n    description: the registry token',
      'client = Client(api_key=api_key, token=access_token)',
      'def f(password: Optional[str] = None): ...',
      'key: production',
      'auth: required',
    ].join('\n');
    expect(redactForEgress(text)).toBe(text);
  });

  it('masks by field name and keeps tool names', () => {
    expect(redactField('password', P)).toBe('[REDACTED:assignment]');
    expect(redactField('DB_PASS', P)).toBe('[REDACTED:assignment]');
    expect(redactField('apiKey', P)).toBe('[REDACTED:assignment]');
    expect(redactField('key', 'user:123:profile')).toBe('user:123:profile');
    expect(redactField('password', '${DB_PASSWORD}')).toBe('${DB_PASSWORD}');
    expect(redactField('tool', 'mcp__db__connect')).toBe('mcp__db__connect');
    expect(redactJson({ host: 'db', user: 'bob', password: 'Xk9;mP2#vL7qR4' })).toEqual({ host: 'db', user: 'bob', password: '[REDACTED:assignment]' });
  });

  it('stays linear on a long single line with many curl and mysql words', () => {
    const text = 'curl mysql redis-cli ldapsearch docker login '.repeat(4_000);
    const started = Date.now();
    redactForEgress(text);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// --- P0 round 4: the architect's acceptance table (side/p1w/p0r4.cases.ts, appended verbatim; do not edit) ---
// Sources: six Hermes reviewers 2026-10-03 (side/p0r3/*.json). `kept` = the text reaches Jev unchanged;
// `masked` = the secret part is gone and a [REDACTED:…] marker stands in its place. Values are built at run time.
describe('P0 round 4 — code and schema stay readable', () => {
  const keptText: string[] = [
    'const token = accessToken;',
    'const token = refreshToken;',
    'interface Lexer { token: SyntaxToken; password: string; secret: SecretType; }',
    'private_key: certs/server.pem',
    'PRIVATE_KEY=/home/Михаило/keys/id_ed25519',
    'python -b manage.py DATABASE_URL=postgres://db/app',
    'https://cdn.example.com/a.js?sig=abcdef0123456789abcd',
    `blob_${'0123456789abcdef'.repeat(8)}`,
  ];
  for (const line of keptText) {
    it(`keeps ${line.slice(0, 32)}…`, () => expect(redactForEgress(line)).toBe(line));
  }

  it('keeps the two code writes distinguishable', () => {
    expect(redactForEgress('const token = accessToken;')).not.toBe(redactForEgress('const token = refreshToken;'));
  });

  const keptFields: Array<[string, string]> = [
    ['primary_key', 'customerId'],
    ['foreign_key', 'parentId'],
    ['partition_key', 'userId'],
    ['sort_key', 'createdAt'],
    ['cache_key', 'build-v1'],
    ['private_key', 'certs/server.pem'],
    ['token', '${{ secrets.GH_TOKEN }}'],
    ['auth', 'required'],
  ];
  for (const [name, value] of keptFields) {
    it(`keeps the field ${name}`, () => expect(redactField(name, value)).toBe(value));
  }
});

describe('P0 round 4 — secrets on common forms are masked', () => {
  const P = `Xk9mP2vL7qR4${body(10)}`;
  const base64 = (s: string) => Buffer.from(s).toString('base64');
  const masked = (out: string, secret: string) => {
    expect(out).not.toContain(secret.slice(-10));
    expect(out).toContain('[REDACTED');
  };

  const textCases: Array<[string, string, string]> = [
    ['a quoted env literal with underscores', 'export DB_PASSWORD="river_violet_orbit_copper"; ./deploy', 'violet_orbit_copper'],
    ['an ODBC braced password', `Driver={ODBC Driver 18 for SQL Server};Server=db;UID=bob;PWD={${body(18)}};Encrypt=yes`, body(18)],
    ['a docker config auth', `{"auths":{"registry.example":{"auth":"${base64(`probe:${body(18)}`)}"}}}`, base64(`probe:${body(18)}`)],
    ['a SecretString JSON field', `{"SecretString":"${P}"}`, P],
    ['a Cookie JSON field', `"Cookie": "session=${body(24)}"`, body(24)],
    ['aws --secret-string', `aws secretsmanager put-secret-value --secret-id app --secret-string ${P}`, P],
    ['aws --secret-string quoted', `aws secretsmanager put-secret-value --secret-id app --secret-string "${P}"`, P],
    ['aws --secret-access-key', `aws configure set --secret-access-key ${P}`, P],
    ['az keyvault --value', `az keyvault secret set --vault-name app --name db --value ${P}`, P],
    ['aws ssm --value', `aws ssm put-parameter --name /app/db --value ${P} --type SecureString`, P],
    ['gh secret set --body', `gh secret set APP_TOKEN --body ${P}`, P],
    ['a dotenv passphrase with spaces', 'DB_PASSWORD=correct horse battery staple', 'battery staple'],
    ['escaped JSON in curl -d', `curl -d "{\\"password\\":\\"${P}\\"}" https://x.example`, P],
    ['an npmrc _authToken', `//registry.npmjs.org/:_authToken=${body(40)}`, body(40)],
    ['an npmrc _auth', `//registry.npmjs.org/:_auth=${base64(`bob:${body(18)}`)}`, base64(`bob:${body(18)}`)],
    ['a gcloud access token', `ya29.${body(40)}`, body(40)],
    ['a Discord webhook', `DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456789012345678/${body(60)}`, body(60)],
  ];
  for (const [label, line, secret] of textCases) {
    it(`masks ${label}`, () => masked(redactForEgress(line), secret));
  }

  it('keeps the comment after a dotenv passphrase', () => {
    const out = redactForEgress('DB_PASSWORD=correct horse # rotated weekly');
    expect(out).not.toContain('horse');
    expect(out).toContain('# rotated weekly');
  });

  const fieldCases: Array<[string, string]> = [
    ['encryptionKey', base64(body(32))],
    ['masterKey', P],
    ['signingKey', P],
    ['privateKey', P],
    ['accountKey', base64(body(40))],
    ['SecretString', P],
    ['_authToken', body(40)],
    ['Cookie', `session=${body(24)}`],
    ['auth', base64(`probe:${body(18)}`)],
    ['password', 'river.violet.orbit.copper'],
  ];
  for (const [name, value] of fieldCases) {
    it(`masks the field ${name}`, () => expect(redactField(name, value)).not.toContain(value.slice(-10)));
  }

  it('masks a structured secret field in the request body', () => {
    const key = base64(body(32));
    const request = buildJevRequest({ apiKey: 'k_test' }, { crypto: { encryptionKey: key }, headers: { Cookie: `session=${body(24)}` } }, {});
    expect(request.body).not.toContain(key.slice(-12));
    expect(request.body).not.toContain(body(24));
  });

  it('stays linear on a 2 MB single-line input', () => {
    const big = `curl -sS ${'--data-urlencode q=abc '.repeat(90_000)}`;
    const started = Date.now();
    redactForEgress(big);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
