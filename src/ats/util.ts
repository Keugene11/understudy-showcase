import type { FormField, StandardKey } from "./types";

export const UA = "Mozilla/5.0 (compatible; UnderstudyBot/1.0; +https://understudy.live)";

export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  // A board that's throttling answers 200 with an HTML page (Workday, ten tenants at once on 19 Sep). Say so,
  // rather than "Unexpected token '<'" reaching the person as the reason their application failed.
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${new URL(url).hostname} answered with a web page instead of data (likely rate-limited)`);
  }
}

export async function getText(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", bull: "•" };

/**
 * The character for a numeric entity. A page can write any number there ("&#9999999;"), and String.fromCodePoint
 * throws RangeError past U+10FFFF, which took the whole read down: out of range and lone surrogates become U+FFFD.
 */
export function fromCodePointSafe(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
}

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? fromCodePointSafe(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Longest HTML the text readers look at: a description or a page is far below this. */
export const MAX_HTML = 2_000_000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * `s.replace(re, repl)` for the tag-shaped patterns below, in linear time. /<(script|style)[\s\S]*?<\/\1>/g and
 * /<[^>]+>/g rescan to the end of the input from every opening that never closes, so 20k unclosed "<script" took
 * seconds a pass (security audit, 21 Oct). Same matches: `open` (global) finds where a match can start and `close`
 * names its terminator, searched from the end of the opening; the span runs through the terminator. An opening
 * with nothing to close it stays as text, and that terminator is never searched for again past where it was missing.
 */
export function sweep(s: string, open: RegExp, close: (m: RegExpExecArray) => string, repl: string): string {
  const known = new Map<string, { from: number; at: number }>();
  let out = "";
  let last = 0;
  open.lastIndex = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const term = close(m);
    const from = m.index + m[0].length;
    const k = known.get(term);
    let at: number;
    if (k && from >= k.from && (k.at === -1 || k.at >= from)) at = k.at;
    else {
      const re = new RegExp(escapeRe(term), "gi");
      re.lastIndex = from;
      at = re.exec(s)?.index ?? -1;
      known.set(term, { from, at });
    }
    if (at === -1) {
      open.lastIndex = m.index + 1;
      continue;
    }
    out += s.slice(last, m.index) + repl;
    last = at + term.length;
    open.lastIndex = last;
  }
  return out + s.slice(last);
}

/** s.replace(/<(tags)[\s\S]*?<\/\1>/gi, repl): whole elements, contents included. */
export const stripElements = (s: string, tags: string[], repl: string) => sweep(s, new RegExp(`<(${tags.join("|")})`, "gi"), (m) => `</${m[1].toLowerCase()}>`, repl);
/** s.replace(/<!--[\s\S]*?-->/g, repl) */
export const stripComments = (s: string, repl: string) => sweep(s, /<!--/g, () => "-->", repl);
/** s.replace(/<(x)[^>]*>/gi, repl) given open = /<(x)/gi; open = /<[^>]/g gives s.replace(/<[^>]+>/g, repl). */
export const stripTags = (s: string, open: RegExp, repl: string) => sweep(s, open, () => ">", repl);

/** HTML → readable plain text that keeps list structure (for LLM prompts and the job page). */
export function htmlToText(html: string): string {
  let s = html.slice(0, MAX_HTML);
  if (/&lt;\w/.test(s)) s = decodeEntities(s); // Greenhouse double-encodes content
  s = stripTags(stripElements(s, ["script", "style"], ""), /<li/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|ul|ol|section|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  s = stripTags(stripTags(s, /<h[1-6]/gi, "\n\n"), /<[^>]/g, "");
  return decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const isRemote = (...parts: (string | null | undefined)[]) => parts.some((p) => !!p && /remote|anywhere|distributed|work from home|wfh/i.test(p));

/** Guess a standard profile field from a label (used by every adapter and the extension). */
export function standardFromLabel(label: string, type?: string): StandardKey | undefined {
  // Accents fold first: "Résumé" (Rippling) lost its é to the strip below and read "r sum ", so no résumé was ever attached there.
  const l = label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (type === "file") {
    if (/cover/.test(l)) return "cover_letter";
    if (/resume|cv/.test(l)) return "resume";
    return undefined;
  }
  if (/^(legal )?first name$|^given name$/.test(l)) return "first_name";
  if (/^(legal )?last name$|^family name$|^surname$/.test(l)) return "last_name";
  if (/^preferred (first )?name$/.test(l)) return "preferred_name";
  if (/^(full |legal |your )?name$|^full legal name$/.test(l)) return "full_name";
  if (/^((please )?(provide|enter) your )?e ?mail( address)?$/.test(l)) return "email";
  if (/^((please )?(provide|enter) your )?(mobile |cell |best )?(phone|telephone|mobile)( number)?$/.test(l)) return "phone";
  if (/linkedin/.test(l) && l.length < 40) return "linkedin";
  if (/github/.test(l) && l.length < 40) return "github";
  if (/portfolio/.test(l) && l.length < 40) return "portfolio";
  if (/twitter|^x( profile)?$/.test(l) && l.length < 30) return "twitter";
  if (/^(personal )?(website|web site|site|blog)( url)?$|^other website$/.test(l)) return "website";
  if (/^(current )?(company|employer|organization)$/.test(l)) return "current_company";
  if (/^(current )?(job )?title$/.test(l)) return "current_title";
  if (/^(current )?location( city)?$|^city$|^where are you (currently )?(located|based)$/.test(l)) return "location";
  if (/^(phone )?country$|^country of residence$/.test(l)) return "country";
  return undefined;
}

export function field(f: Omit<FormField, "standard"> & { standard?: FormField["standard"] }): FormField {
  const label = htmlToText(f.label).replace(/\s*[*✱]\s*$/, "").trim();
  return { ...f, label, standard: f.standard ?? (f.group === "eeo" ? undefined : standardFromLabel(label, f.type)) };
}

/** "Posted 3 Days Ago" / "Posted Today" → ISO date. */
export function relativePosted(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const day = 864e5;
  if (t.includes("today")) return new Date().toISOString();
  if (t.includes("yesterday")) return new Date(Date.now() - day).toISOString();
  const m = t.match(/(\d+)\+?\s*day/);
  if (m) return new Date(Date.now() - Number(m[1]) * day).toISOString();
  return null;
}

export function salaryText(min?: number | null, max?: number | null, currency?: string | null, interval?: string | null) {
  if (!min && !max) return "";
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const cur = !currency || currency === "USD" ? "$" : `${currency} `;
  const range = min && max && min !== max ? `${cur}${fmt(min)}–${cur}${fmt(max)}` : `${cur}${fmt((min || max)!)}`;
  const per = interval ? ` / ${interval.replace(/^per[-_ ]?/i, "").replace(/-/g, " ").toLowerCase()}` : "";
  return range + per;
}
