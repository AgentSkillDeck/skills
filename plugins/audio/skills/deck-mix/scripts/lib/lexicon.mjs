// Respell lexicon: how a term is said, for words a voice engine misreads
// (CLI flags, product names, acronyms). Only the engine sees the respelling;
// captions, timeline.json and CREDITS keep the written text. QA checks the
// take against the respelled text, since that is what was asked to be said.
//
// Layers, later wins: the bundled assets/lexicon.json (`terms` for every
// engine, plus a section per engine, e.g. `qwen3`, for respellings measured on
// that engine only), the user's
// ~/.agentskilldeck/lexicon.json (AGENTSKILLDECK_LEXICON overrides the path),
// then the script's front matter:
//   lexicon:
//     kubectl: cube control
//     "--force-with-lease": force with lease
// Matching is whole-term and case-insensitive; a term may hold spaces,
// dashes or dots. Longer terms are replaced first.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_LEXICON = fileURLToPath(new URL('../assets/lexicon.json', import.meta.url));

const unquote = (s) => String(s).trim().replace(/^(["'])(.*)\1$/, '$2');

function readJson(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
// A lexicon file: {terms: {...}, <engine>: {...}} or a flat {term: respelling}.
const entries = (j, engine) => ({ ...(j.terms ?? (Object.values(j).every((v) => typeof v !== 'object') ? j : {})), ...(engine && typeof j[engine] === 'object' ? j[engine] : {}) });

export function userLexiconPath({ env = process.env, home = homedir() } = {}) {
  return env.AGENTSKILLDECK_LEXICON || join(home, '.agentskilldeck', 'lexicon.json');
}

// {term: respelling} with every layer merged; keys normalised to lower case.
// engine: 'qwen3' adds the bundled entries measured on Qwen3 only.
export function loadLexicon({ meta = {}, env = process.env, home = homedir(), bundled = BUNDLED_LEXICON, engine } = {}) {
  const out = {};
  const add = (obj) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const term = unquote(k);
      if (!term || k.startsWith('_') || typeof v === 'object') continue;
      out[term.toLowerCase()] = unquote(v);
    }
  };
  add(entries(readJson(bundled), engine));
  add(entries(readJson(userLexiconPath({ env, home })), engine));
  if (meta.lexicon && typeof meta.lexicon === 'object') add(meta.lexicon);
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex for the whole lexicon (cached per lexicon object).
const compiled = new WeakMap();
function matcher(lexicon) {
  if (!compiled.has(lexicon)) {
    const terms = Object.keys(lexicon).sort((a, b) => b.length - a.length);
    // A term is whole when no letter, digit, dash or underscore touches either side.
    compiled.set(lexicon, terms.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${terms.map(esc).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu') : null);
  }
  return compiled.get(lexicon);
}

// text with every lexicon term replaced by its respelling.
export function respell(text, lexicon) {
  const re = lexicon && matcher(lexicon);
  if (!re) return text;
  return String(text).replace(re, (m) => lexicon[m.toLowerCase()] ?? m).replace(/\s{2,}/g, ' ');
}
