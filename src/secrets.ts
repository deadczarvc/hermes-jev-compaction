// Secret values masked in two places: a tool output saved to a file (hooks/fast-jev.ts) and everything sent to Jev
// (`stateGroups` masks the history before it is cut to fit, `buildJevRequest` masks the body once more). The session
// transcript keeps the original; neither the saved copy nor the scoring request may become one more place a key lives.
// Families are value-based: a value, not a field name, is a secret. A match whose body is one repeated character is a
// placeholder (`sk-xxxxxxxx…`) and is left alone. Name rules live in the egress layer. Saved copies gain only families
// whose shape cannot be ordinary text (`ya29.`, Discord webhooks); azure SAS `sig=` is narrower than before.
type Family = readonly [name: string, pattern: RegExp, keep?: number, skip?: (value: string) => boolean];

/** The whole string is a reference, not a value: `${VAR}`, `${{ … }}`, `$VAR`, `%VAR%`, `<name>`, `{{ … }}`. */
function isReference(value: string): boolean {
  return /^(?:\$\{\{[^{}]{0,240}\}\}|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%|<[^<>\r\n]{1,80}>|\{\{[^{}]{0,240}\}\})$/.test(value);
}

/** A long random tail: digits and letters mixed, not an id, a pure hex digest, or a snake_case name. */
function looksOpaque(s: string): boolean {
  if (/^[0-9a-f]+$/i.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return false;
  const digits = (s.match(/[0-9]/g) ?? []).length;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (digits < 4 || letters < 8) return false;
  return !(digits / s.length < 0.2 && (/^[a-z]+(?:[_-][a-z0-9]+)+$/.test(s) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)));
}

const SEGMENT = /^[\p{L}\p{N}_.@-]+$/u;

/** Relative path of two or more segments, or absolute (`/`, `~/`, `C:\` / `C:/`). No `+` or `=`, no opaque segment ≥ 20. */
function isPath(value: string): boolean {
  if (!value || /[+=\s]/.test(value)) return false;
  let rest = value;
  let absolute = false;
  if (/^[A-Za-z]:[\\/]/.test(rest)) {
    absolute = true;
    rest = rest.slice(3);
  } else if (rest.startsWith('~/') || rest.startsWith('~\\')) {
    absolute = true;
    rest = rest.slice(2);
  } else if (rest.startsWith('/') || rest.startsWith('\\')) {
    absolute = true;
    rest = rest.replace(/^[\\/]+/, '');
  } else if (/^\.{1,2}[\\/]/.test(rest)) {
    rest = rest.replace(/^\.{1,2}[\\/]/, '');
  }
  const segments = rest.split(/[\\/]+/).filter(Boolean);
  if (!absolute && segments.length < 2) return false;
  if (segments.length === 0) return absolute;
  for (const seg of segments) {
    if (!SEGMENT.test(seg)) return false;
    if (seg.length >= 20 && looksOpaque(seg)) return false;
  }
  return true;
}

/** Values after `key =` that are code, references or structure, not credentials (fast-jev-compaction#98, narrowed). */
function looksLikeCode(value: string): boolean {
  return (
    /^(?:true|false|null|undefined|none)$/i.test(value) ||
    isReference(value) ||
    isPath(value) ||
    /^[\w.$]+\(/.test(value) ||
    /^[A-Za-z_][\w.]*\[/.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[|&?]*[{[]?$/.test(value) ||
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) ||
    /^[a-z]+(?:_[a-z]+)+$/.test(value) ||
    /^[\w.-]+:$/.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^[{[(]/.test(value)
  );
}

function isPlaceholder(value: string): boolean {
  const body = value.replace(/^[A-Za-z]+[_-](?:[a-z0-9]+-)?/, '');
  return new Set(body).size < 2;
}

/** A programming name (`accessToken`, `SecretType`), not a token with digits. */
function isBareIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z_$]*$/.test(value);
}

function atCodeBoundary(text: string, end: number): boolean {
  return end >= text.length || /[;,)}\]\n\r]/.test(text[end] ?? '');
}

const KEY_WORDS = new Set(['password', 'passwd', 'pwd', 'pass', 'passphrase', 'secret', 'token', 'apikey', 'credential', 'credentials']);
const KEY_COMPOUND = ['sharedaccesskey', 'secretaccesskey', 'encryptionkey', 'privatekey', 'signingkey', 'accountkey', 'accesskey', 'masterkey', 'secretkey', 'apikey'];
const EXACT_NAME = new Set([...KEY_COMPOUND, 'clientsecret', 'secretstring', 'secretbinary', 'cookie', 'setcookie', 'authorization', 'proxyauthorization']);
const NOT_A_KEY = new Set(['primary', 'foreign', 'partition', 'sort', 'cache', 'idempotency', 'public']);
const GLUED = ['passphrase', 'password', 'passwd', 'secret', 'token', 'apikey', 'credential', 'credentials'];

function splitSegments(name: string): string[] {
  const out: string[] = [];
  for (const part of name.split(/[_-]+/)) {
    if (!part) continue;
    out.push(...(part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [part]));
  }
  return out;
}

/** Base64 of 16+ characters, not a plain word (`required`). */
function isBase64Secret(value: string): boolean {
  if (value.length < 16 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return /[0-9+/]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

/**
 * A field or variable that holds a secret. The last segment is a keyword, or the name is (or ends with) one of the
 * listed compounds (`api_key`, `encryptionKey`, `SecretString`, `Cookie`). `cache_key` and `token_type` are not.
 * Bare `auth` counts only when the value is base64. A leading `_` is ignored (`_authToken`).
 */
function isSecretName(name: string, value?: string): boolean {
  if (/^_?auth$/i.test(name)) return value !== undefined && isBase64Secret(value);
  const raw = name.replace(/^_+/, '');
  if (!raw) return false;
  const segs = splitSegments(raw);
  const last = segs[segs.length - 1]?.toLowerCase() ?? '';
  if (KEY_WORDS.has(last)) return true;
  if (last === 'key' && NOT_A_KEY.has(segs[segs.length - 2]?.toLowerCase() ?? '')) return false;
  const norm = raw.replace(/[_-]/g, '').toLowerCase();
  if (EXACT_NAME.has(norm)) return true;
  if (KEY_COMPOUND.some((s) => norm.endsWith(s) && norm.length > s.length)) return true;
  if (segs.length === 1 && GLUED.some((k) => norm.endsWith(k) && norm.length > k.length)) return true;
  if (last === 'cookie' || last === 'authorization' || last === 'secretstring' || last === 'secretbinary') return true;
  const prev = segs[segs.length - 2]?.toLowerCase();
  return (prev === 'set' && last === 'cookie') || (prev === 'proxy' && last === 'authorization');
}

/** No word character before a prefix, but a JSON escape (`\n`, `\t`, `\r`) right before it still counts as a start. */
const START = String.raw`(?:(?<=\\[nrt])|(?<![A-Za-z0-9_]))`;
const after = (prefix: string, tail: string, flags = 'g'): RegExp => new RegExp(`${START}${prefix}${tail}`, flags);

const FAMILIES: ReadonlyArray<Family> = [
  // A whole block first (bounded, so many BEGINs without an END stay linear), then a block cut short before its END:
  // a header followed by real base64 body lines (indented, as in YAML, too). A lone header is code that names it.
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16000}?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:\r?\n|\\n)(?:[ \t]*[A-Za-z0-9+/=]{16,}(?:\r?\n|\\n|$)){1,250}[A-Za-z0-9+/=]*/g],
  ['putty-key', /(Private-Lines:\s*\d+(?:\r?\n|\\n))(?:[A-Za-z0-9+/=]{16,}(?:\r?\n|\\n|$)){1,250}/g, 1],
  ['age-key', /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g],
  ['jwt', after('eyJ', String.raw`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)],
  ['sk-proj', /sk-proj-[A-Za-z0-9_-]{30,}/g],
  ['sk-ant', /sk-ant-[A-Za-z0-9_-]{30,}/g],
  ['sk-or-v1', /sk-or-v1-[A-Za-z0-9]{30,}/g],
  ['sk', /(?<![A-Za-z0-9-])sk-[A-Za-z0-9_.-]{16,}/g],
  ['stripe', after('(?:sk|rk)_(?:live|test)_', '[A-Za-z0-9]{16,}')],
  ['stripe-webhook', after('whsec_', '[A-Za-z0-9+/=]{24,}')],
  ['github-pat', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['glpat', /glpat-[A-Za-z0-9_-]{20,}/g],
  ['gh-token', /gh[opsu]_[A-Za-z0-9]{30,}/g],
  ['npm', after('npm_', '[A-Za-z0-9]{36}')],
  ['pypi', after('pypi-AgE', '[A-Za-z0-9_-]{50,}')],
  ['shopify', after('shp(?:at|ca|pa|ss)_', '[a-fA-F0-9]{32}')],
  ['hf', after('hf_', '[A-Za-z0-9]{30,}')],
  ['nia', after('nk_', '[A-Za-z0-9]{20,}')],
  ['google-api', /AIza[0-9A-Za-z_-]{30,}/g],
  ['google-access', /(?<![A-Za-z0-9_])ya29\.[0-9A-Za-z_-]{20,}/g],
  ['slack', /xox[abpr]-[0-9A-Za-z-]{20,}/g],
  ['slack-webhook', /hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]{20,}/g],
  ['discord-webhook', /discord(?:app)?\.com\/api\/webhooks\/[0-9]{5,}\/[A-Za-z0-9_-]{20,}/g],
  ['aws-akia', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g],
  ['aws-secret', /(aws_secret_access_key[\"'\s=:]+)[A-Za-z0-9/+=]{30,}/gi, 1],
  ['azure-key', /(\b(?:Account|SharedAccess)Key=)[A-Za-z0-9+/=]{20,}/g, 1],
  ['pplx', after('pplx-', '[A-Za-z0-9]{20,}')],
  ['xai', after('xai-', '[A-Za-z0-9]{20,}')],
  ['groq', after('gsk_', '[A-Za-z0-9]{20,}')],
  ['sakana', after('fish_', '[A-Za-z0-9_]{20,}')],
  ['keenable', after('keen_', '[A-Za-z0-9_]{20,}')],
  ['sendgrid', /SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
  ['telegram', /(?<![0-9])\d{8,12}:AA[A-Za-z0-9_-]{30,}/g],
  // `WWW-Authenticate: Bearer resource_metadata="…"` carries an auth-param, not a token.
  ['bearer', /(\b[Bb]earer\s+)(?![A-Za-z0-9._~+/-]*=")[A-Za-z0-9._~+/-]{20,}=*/g, 1],
  // `scheme://user:password@host`, the user may be empty (`redis://:pass@host`); user, host and port stay
  // (fast-jev-compaction#98). `?` and `#` cannot sit unencoded in userinfo, so a query is never taken for a password.
  ['url-credentials', /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/@:]{0,64}:)[^\s@/?#]{6,}(?=@)/gi, 1, isReference],
];

/** `sig=` is an Azure SAS signature only with `sv=` in the same query, or on `*.core.windows.net`. */
function maskAzureSas(text: string): string {
  return text.replace(/([?&]sig=)([^&\s"'#]{16,})/g, (match, label: string, value: string, offset: number, whole: string) => {
    if (value.includes('[REDACTED') || isPlaceholder(value)) return match;
    const before = whole.slice(Math.max(0, offset - 800), offset);
    const afterSig = whole.slice(offset, Math.min(whole.length, offset + label.length + value.length + 800));
    const hostAt = before.lastIndexOf('.core.windows.net');
    const windows = hostAt >= 0 && !/[\s]/.test(before.slice(hostAt));
    const q = before.lastIndexOf('?');
    const same = q >= 0 && !/[\s#]/.test(before.slice(q));
    const query = same ? before.slice(q) + afterSig.split(/[\s#]/)[0] : '';
    if (!windows && !/(?:^|[?&])sv=/.test(query)) return match;
    return `${label}[REDACTED:azure-sas]`;
  });
}

// Name- and context-based rules, too loose for a saved copy an agent reads back (`cache_key=…` is often a plain value)
// and right for what leaves the machine. Adapted from fast-jev-compaction#98 (socialadsmentor). Every repetition and
// every lazy run is bounded: unbounded ones backtrack quadratically on long single-line inputs.
const FLAG = String.raw`--(?:[a-z0-9]+-){0,2}(?:passphrase|password|passwd|pass|secret|token|api-key|apikey)(?:-[a-z0-9]+){0,3}`;
const EGRESS: ReadonlyArray<Family> = [
  ['authorization', /(\b(?:Proxy-)?Authorization[\"']?\s*[:=]\s*[\"']?(?:[A-Za-z-]{2,12}\s+)?)[^\s\"']{12,}/gi, 1, isReference],
  // `--secret-string`, `--secret-access-key`: the keyword may take up to two prefix segments and three suffix segments.
  ['flag', new RegExp(String.raw`(${FLAG}(?:=|[ \t]+)[\"']?)[^\s\"'\`]{6,}`, 'gi'), 1, looksLikeCode],
  ['flag', /(\baz[ \t]+keyvault[ \t]+secret[ \t]+set\b[^\n]{0,500}?[ \t]--value(?:=|[ \t]+)[\"']?)[^\s\"']{6,}/gi, 1, looksLikeCode],
  ['flag', /(\baws[ \t]+ssm[ \t]+put-parameter\b[^\n]{0,500}?[ \t]--value(?:=|[ \t]+)[\"']?)[^\s\"']{6,}/gi, 1, looksLikeCode],
  ['flag', /(\bgh[ \t]+secret[ \t]+set\b[^\n]{0,500}?[ \t](?:--body|-b)(?:=|[ \t]+)[\"']?)[^\s\"']{6,}/gi, 1, looksLikeCode],
  ['odbc', /((?<![A-Za-z0-9_])(?:PWD|Password)=\{)[^}\r\n]{4,}/gi, 1],
  ['flag', /(\bcurl\b[^\n]{0,256}?\s(?:-u|--user)\s+[\"']?[^\s:\"']{1,64}:)[^\s@\"']{6,}/g, 1, isReference],
  ['flag', /(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n]{0,256}?\s-p)(?!\s)[^\s\"']{4,}/g, 1, isReference],
  ['flag', /(\b(?:docker|podman|nerdctl)\s+login\b[^\n]{0,256}?\s(?:-p|--password)\s+[\"']?)[^\s\"']{6,}/g, 1, isReference],
  ['flag', /(\bsshpass\s+-p\s*[\"']?)[^\s\"']{4,}/g, 1, isReference],
  ['flag', /(\bredis-cli\b[^\n]{0,256}?\s-a\s+[\"']?)[^\s\"']{4,}/g, 1, isReference],
  ['flag', /(\s-pass(?:in|out)?\s+[\"']?pass:)[^\s\"']{4,}/g, 1, isReference],
  ['flag', /(\s-(?:store|key|src|dest|srcstore|deststore)pass\s+[\"']?)[^\s\"']{4,}/g, 1, isReference],
  ['flag', /(\bldap\w*\b[^\n]{0,256}?\s-w\s+[\"']?)[^\s\"']{4,}/g, 1, isReference],
  ['flag', /(\/pass:[\"']?)[^\s\"'/]{4,}/gi, 1, isReference],
  ['flag', /(\bConvertTo-SecureString\s+(?:-String\s+)?[\"'])[^\"'\r\n]{4,}/gi, 1, isReference],
  ['netrc', /(\bmachine\s+\S+\s+login\s+\S+\s+password\s+)\S{6,}/g, 1],
  ['prefixed', new RegExp(`${START}[A-Za-z]{2,10}_[A-Za-z0-9_.-]{40,}`, 'g'), 0, (m) => {
    const tail = m.slice(m.indexOf('_') + 1);
    // MCP tool names (`mcp__<uuid>__tool`) and file names are identifiers, not keys.
    return m.startsWith('mcp_') || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(m) || /\.[a-z]{1,5}$/.test(tail) || !looksOpaque(tail.replace(/\./g, ''));
  }],
];

function apply(text: string, families: ReadonlyArray<Family>): string {
  let out = text;
  for (const [name, pattern, keep, skip] of families) {
    out = out.replace(pattern, (match: string, label?: string) => {
      const kept = keep && typeof label === 'string' ? label : '';
      const value = match.slice(kept.length);
      if (isPlaceholder(value) || value.includes('[REDACTED') || skip?.(value)) return match;
      return `${kept}[REDACTED:${name}]`;
    });
  }
  return out;
}

/** `"` `'` `\"` `\'` and a short run of backslashes before a quote, as curl -d writes JSON. */
function quoteToken(text: string, i: number): { len: number; q: string; slashes: number } | null {
  let j = i;
  while (j < text.length && text[j] === '\\' && j - i < 4) j++;
  const q = text[j];
  if (q !== '"' && q !== "'") return null;
  return { len: j - i + 1, q, slashes: j - i };
}

interface Piece { value: string; at: number; quoted: boolean; dotenv: boolean }

/** The value after a name, or null when what follows is not an assignment. `{…}` is left to the ODBC rule. */
function parseAssignment(text: string, nameAt: number, name: string): Piece | null {
  let p = nameAt + name.length;
  const closed = quoteToken(text, p);
  if (closed) p += closed.len;
  let before = 0;
  while (before < 4 && (text[p] === ' ' || text[p] === '\t')) { p++; before++; }
  const sep = text[p];
  if (sep !== ':' && sep !== '=') return null;
  p++;
  if (text[p] === '{') return null;
  const yaml = /^[ \t]*[|>]?[+-]?[ \t]*\r?\n[ \t]+/.exec(text.slice(p));
  let afterSep = 0;
  if (yaml) p += yaml[0].length;
  else while (afterSep < 4 && (text[p] === ' ' || text[p] === '\t')) { p++; afterSep++; }
  const lineStart = text.lastIndexOf('\n', nameAt - 1) + 1;
  const dotenv = sep === '=' && before === 0 && afterSep === 0 && !yaml
    && /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/.test(name)
    && /^(?:export[ \t]+)?$/.test(text.slice(lineStart, nameAt));
  const quote = quoteToken(text, p);
  if (quote) {
    const start = p + quote.len;
    const marker = '\\'.repeat(quote.slashes) + quote.q;
    const end = text.indexOf(marker, start);
    const nl = text.indexOf('\n', start);
    if (end < 0 || (nl >= 0 && nl < end)) return null;
    return { value: text.slice(start, end), at: start, quoted: true, dotenv: false };
  }
  if (dotenv) {
    const rest = text.slice(p);
    const lineEnd = rest.search(/\r?\n/);
    const limit = lineEnd >= 0 ? lineEnd : rest.length;
    const commentAt = rest.indexOf(' #');
    const end = commentAt >= 0 && commentAt < limit ? commentAt : limit;
    return { value: rest.slice(0, end), at: p, quoted: false, dotenv: true };
  }
  // `${VAR}` and `${{ … }}` contain `}`, which otherwise ends a bare value and leaves the brace behind.
  const lineEnd = text.indexOf('\n', p);
  const limit = lineEnd >= 0 ? lineEnd : text.length;
  const wrapped = wrappedReference(text, p, limit);
  if (wrapped > p) return { value: text.slice(p, wrapped), at: p, quoted: false, dotenv: false };
  let end = p;
  while (end < limit && !/[\s"'`,;)\]}\\<>]/.test(text.charAt(end))) end++;
  return { value: text.slice(p, end), at: p, quoted: false, dotenv: false };
}

/** End offset of a `${…}`, `${{ … }}`, `{{ … }}`, `%VAR%` or `<name>` starting at `p`, else `p`. */
function wrappedReference(text: string, p: number, limit: number): number {
  let marker = '';
  let from = p;
  if (text.startsWith('${{', p)) {
    marker = '}}';
    from = p + 3;
  } else if (text.startsWith('${', p) || text.startsWith('{{', p)) {
    marker = text.startsWith('${', p) ? '}' : '}}';
    from = p + 2;
  } else if (text[p] === '%' || text[p] === '<') {
    marker = text[p] === '%' ? '%' : '>';
    from = p + 1;
  }
  if (!marker) return p;
  const at = text.indexOf(marker, from);
  return at >= 0 && at < limit ? at + marker.length : p;
}

/**
 * Assignments whose name holds a secret. A quoted value is a literal (masked even when it looks like a name) unless
 * it is a reference or a path. A dotenv line (`export NAME=…` at the start, `=` tight) masks the rest of the line
 * up to ` #`. Other unquoted values that are code (`token = accessToken;`) stay.
 */
function maskAssignments(text: string): string {
  const re = /(?:(?<=\\[nrt])|(?<![A-Za-z0-9_]))(_?[A-Za-z][A-Za-z0-9_-]{0,64})/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1] ?? '';
    const nameAt = m.index;
    if (nameAt < last || !/pass|pwd|secret|token|key|auth|cookie|credential/i.test(name)) continue;
    if (/^(?:_?(?:set-)?cookie|(?:proxy-)?authorization)$/i.test(name)) continue;
    const piece = parseAssignment(text, nameAt, name);
    if (!piece || piece.at < last || piece.value.includes('[REDACTED') || isPlaceholder(piece.value)) continue;
    if (piece.value.length < (piece.quoted || piece.dotenv ? 6 : 8)) continue;
    if (!isSecretName(name, piece.value)) continue;
    if (piece.quoted || piece.dotenv) {
      if (isReference(piece.value) || isPath(piece.value)) continue;
    } else if (looksLikeCode(piece.value) || (atCodeBoundary(text, piece.at + piece.value.length) && isBareIdentifier(piece.value))) {
      continue;
    }
    out += text.slice(last, piece.at);
    out += '[REDACTED:assignment]';
    last = piece.at + piece.value.length;
    re.lastIndex = last;
  }
  return out + text.slice(last);
}

function maskCookiePairs(pairs: string): string {
  return pairs.replace(/([A-Za-z0-9_.-]+=)([^;\s]{8,})/g, (pair, name: string, value: string) =>
    value.includes('[REDACTED') || isPlaceholder(value) ? pair : `${name}[REDACTED:cookie]`);
}

/** Cookie headers and JSON fields, plus `curl -b` / `--cookie` only — a bare `-b` is not a cookie. */
function cookies(text: string): string {
  const header = /((?:\\*["'])?(?:Set-)?Cookie(?:\\*["'])?[ \t]*[:=][ \t]*(?:\\*["'])?)([^\r\n"']{0,4096})/gi;
  const curl = /(\bcurl\b[^\n]{0,2048}?\s(?:-b|--cookie)(?:=|[ \t]+)["']?)([^\r\n"']{0,4096})/gi;
  return text.replace(header, (_m, head: string, pairs: string) => head + maskCookiePairs(pairs))
    .replace(curl, (_m, head: string, pairs: string) => head + maskCookiePairs(pairs));
}

/** `text` with the secret values of known families replaced by `[REDACTED:<family>]`. */
export function redactSecrets(text: string): string {
  return maskAzureSas(apply(text, FAMILIES));
}

/** `redactSecrets` plus name-based rules and exact values the caller holds (its own API key), for what is sent out. */
export function redactForEgress(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED:known]');
  }
  return cookies(apply(maskAssignments(maskAzureSas(apply(out, FAMILIES))), EGRESS));
}

/**
 * One string value of a JSON object on its way out, masked with its field name in view. A JSON string is a literal:
 * under a secret name the whole value goes, unless it is a reference or a path. `tool` holds a tool name, an
 * identifier Jev scores by, and stays. Cookie fields lose each pair of 8 characters or more.
 */
export function redactField(key: string, value: string, known: readonly string[] = []): string {
  if (key === 'tool') return value;
  const masked = redactForEgress(value, known);
  if (masked !== value) return masked;
  if (!isSecretName(key, value) || value.length < 6 || isReference(value) || isPath(value) || isPlaceholder(value)) return value;
  if (/^(?:set-)?cookie$/i.test(key)) {
    const pairs = maskCookiePairs(value);
    if (pairs !== value) return pairs;
  }
  return '[REDACTED:assignment]';
}

/** A copy of a JSON value (a tool input) with keys and string values masked; `toJSON` is honored as in JSON.stringify. */
export function redactJson(value: unknown, known: readonly string[] = [], key = ''): unknown {
  const v = value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (typeof v === 'string') return redactField(key, v, known);
  if (Array.isArray(v)) return v.map((x) => redactJson(x, known, key));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactForEgress(k, known), redactJson(x, known, k)]));
  }
  return v;
}
