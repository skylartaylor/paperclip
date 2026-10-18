// The Claude `setup-token` parsers. They read the interactive login output of
// Claude Code. `parseSetupTokenPrompt` returns the authorization URL and the
// browser-code prompt, or null. `parseSetupTokenCredential` returns the minted
// OAuth token from the success screen, or null.
//
// Security (shape validation): the prompt parser accepts an authorization URL
// only when it matches one of the two observed origin-and-path pairs, carries
// each required query key one time with a valid decoded value, and pins the
// `redirect_uri` value to the one observed callback. It rejects a look-alike
// host, userinfo, an explicit port, a fragment, a duplicate key, an unexpected
// added key, an invalid value, and an API-key-shaped value in the raw URL or in
// any decoded query value. Different Claude CLI versions render the URL two ways:
// a single OSC 8 hyperlink, or plain text with a hard line wrap and no
// hyperlink. The parser reassembles the wrapped plain-text URL from the physical
// lines and validates only the final reassembled string, so the login works on
// every CLI version that keeps this flow shape. It binds the browser-code prompt
// to the dedicated line after the URL block; a repeated URL line, a code-like
// value on the wrong line, or an unrelated line cannot form a prompt.
//
// The token parser reads one complete token block below its
// heading. Footer prose is presentation, not a credential delimiter. Both parsers
// are pure functions and never log input or include it in thrown errors.

export interface SetupTokenPrompt {
  // The validated authorization URL, exactly as the terminal emitted it.
  url: string;
  // The canonical browser-code prompt. The parser returns the constant
  // {@link SETUP_TOKEN_PROMPT}, so the output is never a caller-controlled value.
  prompt: string;
}

// The canonical browser-code prompt text. The Claude login UI prints this line
// to ask the user to paste the code from the browser. The parser returns this
// exact constant on a match.
export const SETUP_TOKEN_PROMPT = "Paste code here if prompted";

// The two accepted authorization URLs, each the exact origin plus path. The
// parser accepts an origin-and-path pair only when it equals one of these two
// strings. It does not accept the cross-product of the two hosts and the two
// paths. `claude` 2.1.19 emits the first URL; `claude` 2.1.205 and 2.1.226 emit
// the second URL.
export const SETUP_TOKEN_AUTH_URLS = [
  "https://claude.ai/oauth/authorize",
  "https://claude.com/cai/oauth/authorize",
] as const;

// The lowercase host prefix of each accepted authorization URL. The parser
// requires the raw URL candidate to start with one of these exact lowercase
// prefixes before it parses the URL. This rejects a mixed-case host spelling, a
// punycode host, and an explicit default `:443` port, because none of them start
// with the exact lowercase `https://<host>/` prefix.
const SETUP_TOKEN_AUTH_URL_PREFIXES = [
  "https://claude.ai/",
  "https://claude.com/",
] as const;

// The one accepted `redirect_uri` value. The parser parses the decoded
// `redirect_uri` value on its own and pins it to this exact callback, with no
// userinfo, no port, no query, and no fragment. The 2.1.226 live capture grounds
// this host; the contract keeps a single pin until sanitized 2.1.19 evidence
// proves another real callback.
export const SETUP_TOKEN_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

// The required query keys of the authorization URL. The parser requires each key
// one time with a valid decoded value. It rejects a missing key, a duplicate
// key, and an invalid value.
export const SETUP_TOKEN_URL_QUERY_KEYS = [
  "client_id",
  "code",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
] as const;

// The set form of the required query keys. The parser uses it to sort a key into
// a required key or an added key.
const SETUP_TOKEN_CORE_KEY_SET = new Set<string>(SETUP_TOKEN_URL_QUERY_KEYS);

// The value validators for the required query keys. Each pattern binds the whole
// decoded value. The parser rejects a value that does not match.
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
// The `code` value of the `claude` 2.1.19 authorization request is a short
// opaque token. A real 2.1.19 capture measured a 4-character value, so the
// minimum length is one character. The character class and the 1024-character
// maximum bound the value.
const CODE_RE = /^[A-Za-z0-9._~-]{1,1024}$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,256}$/;
// One `scope` token. The `scope` value is one to eight space-separated tokens.
const SCOPE_TOKEN_RE = /^[A-Za-z0-9:._-]{1,64}$/;

// The name of an added query key. An added key is any key that is not a required
// key. The parser accepts at most four added keys, each with a name that matches
// this pattern.
const ADDED_KEY_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// The decoded value of an added query key. The parser accepts at most 256
// printable ASCII characters.
const ADDED_VALUE_RE = /^[\x20-\x7E]{0,256}$/;

// An API-key prefix. The Claude setup token and API key start with `sk-ant-`.
// The parser rejects the raw URL candidate and any decoded query value that
// holds this prefix, so a secret cannot ride inside the authorization URL.
const API_KEY_RE = /sk-ant-/i;

// The maximum number of added query keys. The parser accepts at most four added
// keys, so the URL holds at most twelve keys in total.
const MAX_ADDED_KEYS = 4;

// The maximum number of `scope` tokens.
const MAX_SCOPE_TOKENS = 8;

// The maximum length of the whole `scope` value.
const MAX_SCOPE_LENGTH = 512;

// The maximum length of the reassembled authorization URL. The parser rejects a
// candidate longer than this cap.
const MAX_URL_LENGTH = 2048;

// The characters that a URL can hold. A physical line that reassembles into the
// wrapped URL holds only these characters after a trim.
const URL_CHARS_ONLY_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

// Cursor handling is column-aware: a move to the next character in a word
// contributes no space, while a forward move contributes its actual width.
// eslint-disable-next-line no-control-regex
const CSI_ONE_RE = /^\x1b\[([0-?]*)([ -/]*)([@-~])/;
const MAX_CURSOR_PADDING = 200;

// An OSC 8 hyperlink. The terminal emits the URL through an OSC 8 hyperlink plus
// wrapped display text. The hyperlink carries the true, unwrapped URL in its URI
// field, while the display text may wrap across lines. The parser replaces the
// whole hyperlink (open sequence, display text, close sequence) with the URI, so
// it reads the unwrapped URL and drops the wrapped display text. The URI field
// is the first capture group. The terminator of each OSC sequence is the String
// Terminator (ESC `\`) or the BEL byte.
// eslint-disable-next-line no-control-regex
const OSC8_HYPERLINK_RE =
  /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;[^;\x1b\x07]*;(?:\x1b\\|\x07)/g;

// Any remaining OSC sequence. A partial output chunk can hold an OSC 8 open
// sequence without its close sequence. The parser removes each leftover OSC
// sequence after it replaces the complete hyperlinks.
// eslint-disable-next-line no-control-regex
const OSC_ANY_RE = /\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g;

// Trailing punctuation that prose commonly puts right after a URL. The parser
// strips only these characters when it compares a line to a repeated URL. It
// never strips these from the candidate before validation, because the validator
// rejects any trailing punctuation on its own.
const TRAILING_PUNCTUATION_RE = /[)\].,;:!]+$/;

// The line that introduces the URL. The Claude login UI prints this phrase right
// before the URL. The parser anchors the URL search on this phrase, so a URL far
// from the login context cannot bind.
const URL_PREAMBLE_RE = /the url below to sign in/i;

// The browser-code prompt on a dedicated line. The line starts with the exact
// prompt phrase. The line can end with the input caret `>` and masked echo `*`
// characters and spaces. The pattern rejects the phrase when other prose shares
// the line.
const PROMPT_LINE_RE = /^Paste code here if prompted\b[\s>*]*$/;

// The copy hint that `claude` 2.1.291 prints between the URL block and the
// prompt. The parser skips this exact line and binds no value from it.
const COPY_HINT_LINE_RE = /^Hold\s+Shift\s+while\s+selecting\s+to\s+use\s+your\s+terminal['’]s\s+native\s+copy\.?$/i;

// The maximum number of characters between the end of the URL preamble line and
// the start of the URL. The Claude UI prints the URL right after the preamble.
// The parser accepts a URL start only inside this window, so a URL far from the
// preamble cannot bind.
const MAX_PREAMBLE_TO_URL_GAP = 512;

// The maximum number of consecutive physical lines that the parser joins to
// reassemble a wrapped plain-text URL. The `claude` 2.1.19 CLI wraps the URL at
// the terminal width with no space at the wrap, so the parser joins a bounded
// run of URL-character-only lines.
const MAX_URL_LINES = 16;

// The result of a URL search: the validated URL and the index of the physical
// line that holds the last fragment of the URL.
interface SetupTokenUrlMatch {
  url: string;
  endLine: number;
}

/**
 * Column-aware normalization adapted from michaltakac/paperclip-claude-auth,
 * src/setup-token/parse.ts at b52843396b511e8bc6ce3d906ba73f5ed111f308.
 * Keeps this adapter's stricter OSC URL and credential validation.
 *
 * MIT License
 *
 * Copyright (c) 2026 Michal Takáč
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
function stripTerminalControls(text: string): string {
  const source = text.replace(OSC8_HYPERLINK_RE, "$1").replace(OSC_ANY_RE, "");
  let out = "";
  let column = 0;
  let i = 0;
  const pad = (count: number) => {
    const n = Math.min(MAX_CURSOR_PADDING, Math.max(0, count));
    out += " ".repeat(n);
    column += n;
  };
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\x1b") {
      const csi = CSI_ONE_RE.exec(source.slice(i));
      if (csi) {
        const params = csi[1] ?? "";
        if (/^\d*$/.test(params)) {
          const count = Math.max(1, Number.parseInt(params || "1", 10));
          if (csi[3] === "G") pad(Math.max(0, count - 1 - column));
          else if (csi[3] === "C") pad(count);
        }
        i += csi[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      out += "\n";
      column = 0;
      i += char === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    out += char;
    column += 1;
    i += 1;
  }
  return out;
}

/**
 * Returns true when `value` is a valid `scope` value: one to eight
 * space-separated tokens, a total length of at most {@link MAX_SCOPE_LENGTH},
 * and each token a match of {@link SCOPE_TOKEN_RE}. A double space forms an empty
 * token, which fails the token pattern, so a malformed value fails closed.
 */
function isValidScope(value: string): boolean {
  if (value.length < 1 || value.length > MAX_SCOPE_LENGTH) return false;
  const tokens = value.split(" ");
  if (tokens.length < 1 || tokens.length > MAX_SCOPE_TOKENS) return false;
  return tokens.every((token) => SCOPE_TOKEN_RE.test(token));
}

/**
 * Returns true when `value` is the one accepted `redirect_uri`. The function
 * parses the decoded value on its own and pins it to {@link
 * SETUP_TOKEN_REDIRECT_URI}, with the `https:` protocol, no userinfo, no port,
 * no query, and no fragment. It never broadens to an arbitrary HTTPS URL.
 */
function isValidRedirectUri(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.port !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  return `${parsed.origin}${parsed.pathname}` === SETUP_TOKEN_REDIRECT_URI;
}

/**
 * Returns true when the query of `parsed` matches the contract. It requires each
 * required key one time with a valid decoded value. It rejects a duplicate for
 * any key. It accepts at most {@link MAX_ADDED_KEYS} added keys, each with a
 * valid name, one value, and a decoded value of at most 256 printable ASCII
 * characters. It rejects an API-key prefix in any decoded value.
 */
function hasValidQuery(parsed: URL): boolean {
  // Collect the values of each key, so the parser can reject a duplicate key and
  // read the one decoded value of each key.
  const byKey = new Map<string, string[]>();
  for (const [key, value] of parsed.searchParams) {
    const values = byKey.get(key);
    if (values) values.push(value);
    else byKey.set(key, [value]);
  }

  // Reject a duplicate for any key. After this test each key holds one value.
  for (const values of byKey.values()) {
    if (values.length !== 1) return false;
  }

  // Reject an API-key prefix in any decoded key and any decoded value. The
  // `URLSearchParams` decoder turns a percent-encoded name into its literal
  // form, so a secret-shaped value can hide in a query name (for example,
  // `sk%2Dant%2Dredacted` decodes to `sk-ant-redacted`). The parser rejects the
  // prefix in the name and in the value, before it classifies an added key. The
  // raw-candidate check stays in place as defense in depth.
  for (const [key, values] of byKey) {
    if (API_KEY_RE.test(key)) return false;
    if (API_KEY_RE.test(values[0])) return false;
  }

  // Require each required key.
  for (const key of SETUP_TOKEN_URL_QUERY_KEYS) {
    if (!byKey.has(key)) return false;
  }

  // Bound the added keys and validate each one.
  const addedKeys = [...byKey.keys()].filter((key) => !SETUP_TOKEN_CORE_KEY_SET.has(key));
  if (addedKeys.length > MAX_ADDED_KEYS) return false;
  for (const key of addedKeys) {
    if (!ADDED_KEY_NAME_RE.test(key)) return false;
    if (!ADDED_VALUE_RE.test(byKey.get(key)![0])) return false;
  }

  // Validate each required value.
  if (!CLIENT_ID_RE.test(byKey.get("client_id")![0])) return false;
  if (!CODE_RE.test(byKey.get("code")![0])) return false;
  if (!CODE_CHALLENGE_RE.test(byKey.get("code_challenge")![0])) return false;
  if (byKey.get("code_challenge_method")![0] !== "S256") return false;
  if (byKey.get("response_type")![0] !== "code") return false;
  if (!STATE_RE.test(byKey.get("state")![0])) return false;
  if (!isValidScope(byKey.get("scope")![0])) return false;
  if (!isValidRedirectUri(byKey.get("redirect_uri")![0])) return false;
  return true;
}

/**
 * Returns `candidate` when it is a valid authorization URL, or null. The final
 * validator applies to every candidate, from an OSC 8 URI or from a plain-text
 * reassembly. It requires the length cap {@link MAX_URL_LENGTH}, an exact
 * lowercase host prefix, no API-key prefix in the raw candidate, the `https:`
 * protocol, empty userinfo, empty port, no fragment, one of the two accepted
 * origin-and-path pairs, and a valid query.
 */
function validateAuthUrl(candidate: string): string | null {
  if (candidate.length > MAX_URL_LENGTH) return null;
  if (!SETUP_TOKEN_AUTH_URL_PREFIXES.some((prefix) => candidate.startsWith(prefix))) return null;
  if (API_KEY_RE.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.port !== "" || parsed.hash !== "") return null;
  const pair = `${parsed.origin}${parsed.pathname}`;
  if (!SETUP_TOKEN_AUTH_URLS.includes(pair as (typeof SETUP_TOKEN_AUTH_URLS)[number])) return null;
  if (!hasValidQuery(parsed)) return null;
  return candidate;
}

/**
 * Reassembles a wrapped plain-text URL from the physical lines and validates it.
 * The parser starts at `startLine`, then joins at most {@link MAX_URL_LINES}
 * consecutive URL-character-only physical lines into at most {@link
 * MAX_URL_LENGTH} characters. It validates the joined string after each join and
 * returns the first joined string that passes {@link validateAuthUrl}. A CLI that
 * emits the whole URL on one line passes on the first join. A CLI that wraps the
 * URL passes once the parser joins the last fragment. Returns null when no bounded
 * join validates.
 */
function reassembleUrl(lines: string[], startLine: number): SetupTokenUrlMatch | null {
  let joined = "";
  for (let offset = 0; offset < MAX_URL_LINES && startLine + offset < lines.length; offset += 1) {
    const trimmed = lines[startLine + offset].trim();
    if (trimmed.length === 0 || !URL_CHARS_ONLY_RE.test(trimmed)) break;
    joined += trimmed;
    if (joined.length > MAX_URL_LENGTH) break;
    const url = validateAuthUrl(joined);
    if (url) return { url, endLine: startLine + offset };
  }
  return null;
}

/**
 * Returns the canonical browser-code prompt when `lines` holds it on a dedicated
 * line after the URL block. The parser reads the non-blank lines after the URL
 * end line. The Claude UI can emit one full URL line per wrapped display row, so
 * it repeats the same full authorization URL on a few consecutive lines. The
 * parser skips a line that repeats `url`. The `claude` 2.1.291 UI also prints a
 * copy hint before the prompt, so the parser skips a line that matches {@link
 * COPY_HINT_LINE_RE}. The parser then binds the prompt on the first non-blank
 * line that is not a repeat and not the copy hint. That line must match the
 * exact prompt shape. Returns null when that line is not the prompt.
 */
function findBrowserCodePrompt(lines: string[], endLine: number, url: string): string | null {
  for (let i = endLine + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    // Skip a line that repeats the full URL. Strip the trailing prose
    // punctuation first, the same way the repeated-URL comparison needs, so a
    // repeated URL with a trailing punctuation mark still matches.
    if (trimmed.replace(TRAILING_PUNCTUATION_RE, "") === url) continue;
    if (COPY_HINT_LINE_RE.test(trimmed)) continue;
    return PROMPT_LINE_RE.test(trimmed) ? SETUP_TOKEN_PROMPT : null;
  }
  return null;
}

/**
 * Parses Claude `setup-token` login output. Removes the terminal control
 * sequences first, so colored and hyperlinked output reads the same as plain
 * output. The parser finds the URL preamble, then a physical line that starts the
 * authorization URL within {@link MAX_PREAMBLE_TO_URL_GAP} characters of the
 * preamble, then reassembles the wrapped URL and validates the final string, then
 * binds the browser-code prompt on the dedicated line after the URL block. So the
 * URL binds to the login context and the prompt binds to the URL. Returns the
 * authorization URL and the browser-code prompt when both are present and valid.
 * Returns null for any other input, including a non-string input, an absent
 * preamble, a URL with a wrong host, path, query, or fragment, an API-key-shaped
 * URL, and a missing or misplaced prompt. Never throws on input, and never puts
 * any input byte into a log or an error. This phase returns no token.
 */
export function parseSetupTokenPrompt(text: string): SetupTokenPrompt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = stripTerminalControls(text);
  const preamble = URL_PREAMBLE_RE.exec(clean);
  if (!preamble) return null;
  const afterPreamble = preamble.index + preamble[0].length;
  // The region after the preamble. The URL must start inside the start window.
  const region = clean.slice(afterPreamble);
  const lines = region.split("\n");

  // Walk the physical lines and track the character offset of each line start.
  // The URL must start within MAX_PREAMBLE_TO_URL_GAP characters of the preamble.
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineStart = offset;
    offset += lines[i].length + 1;
    if (lineStart > MAX_PREAMBLE_TO_URL_GAP) break;
    const trimmed = lines[i].trim();
    if (!SETUP_TOKEN_AUTH_URL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;
    const match = reassembleUrl(lines, i);
    if (!match) continue;
    const prompt = findBrowserCodePrompt(lines, match.endLine, match.url);
    if (prompt) return { url: match.url, prompt };
  }
  return null;
}

// --- The success token parser ------------------------------------------------

// The literal prefix of the Claude setup-token OAuth token. The success screen
// prints a token that starts with this exact prefix. The opaque tail follows.
export const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";

// The line that introduces the token. The success screen prints this exact line
// right before the token block. The token parser binds the token to this anchor.
export const SETUP_TOKEN_BEFORE_ANCHOR = "Your OAuth token (valid for 1 year):";

// Historical footer retained for characterization fixtures. Credential parsing
// deliberately does not depend on this presentation text.
export const SETUP_TOKEN_AFTER_ANCHOR =
  "Store this token securely. You won't be able to see it again.";

// One physical line of the token. The terminal wraps the token at the
// pseudo-terminal width, so one physical line holds one fragment of the token
// character class. The token character class is `[A-Za-z0-9_-]`; the opaque tail
// can contain `-`, so a line fragment can contain `-`.
const TOKEN_FRAGMENT_RE = /^[A-Za-z0-9_-]+$/;

// The full token shape after the parser joins the wrapped fragments. The token
// starts with the exact prefix and continues over the token character class. The
// minimum tail length rejects a bare prefix and a short, noisy candidate. A real
// opaque tail is far longer than this floor.
const FULL_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

/**
 * Returns the index of the one line that equals `anchor` after a trim. Returns
 * null when no line matches. Returns null when more than one line matches, so a
 * duplicate success block fails closed.
 */
function singleAnchorIndex(lines: string[], anchor: string): number | null {
  let found: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().replace(/\s+/g, " ") !== anchor) continue;
    if (found !== null) return null;
    found = i;
  }
  return found;
}

/**
 * Read one complete token block beneath the unique success heading. Rejoin
 * wrapped fragments, keeping the adapter's strict prefix and alphabet checks.
 * A blank line or the first prose line terminates the block, as in the upstream
 * plugin. Footer wording is not part of the protocol.
 * Missing/duplicate headings, incomplete blocks, or prose within the block fail
 * closed. The runner invokes this only after the complete process stream exits.
 */
export function parseSetupTokenCredential(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const lines = stripTerminalControls(text).split("\n");
  const beforeIndex = singleAnchorIndex(lines, SETUP_TOKEN_BEFORE_ANCHOR);
  if (beforeIndex === null) return null;

  const fragments: string[] = [];
  let terminated = false;
  for (let i = beforeIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (fragments.length) { terminated = true; break; }
      continue;
    }
    if (!TOKEN_FRAGMENT_RE.test(trimmed)) {
      if (fragments.length === 0) return null;
      // The CLI can put footer prose immediately below the wrapped token, with
      // no intervening blank line. Never append that prose. Reject a later
      // fragment before the next blank line: prose inserted into a wrapped
      // credential must not turn its first half into a truncated credential.
      for (let j = i + 1; j < lines.length && lines[j].trim(); j += 1) {
        if (TOKEN_FRAGMENT_RE.test(lines[j].trim())) return null;
      }
      terminated = true;
      break;
    }
    fragments.push(trimmed);
  }
  if (!terminated || fragments.length === 0) return null;
  const token = fragments.join("");
  if (!FULL_TOKEN_RE.test(token)) return null;
  if (token.indexOf(SETUP_TOKEN_PREFIX, SETUP_TOKEN_PREFIX.length) !== -1) return null;
  return token;
}
