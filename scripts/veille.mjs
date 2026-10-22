// Veille technologique : récupère les derniers articles des flux suivis (et de Feedly si un jeton est fourni)
// et met à jour veille.json, lu par la section « Veille » du site. Aucune IA, aucune dépendance.
// Usage : node scripts/veille.mjs          (mise à jour)
//         node scripts/veille.mjs --test   (auto-vérification du parseur)
import fs from 'node:fs';
import assert from 'node:assert';

const FEEDS = [
  { source: 'CERT-FR', theme: 'cyber', url: 'https://www.cert.ssi.gouv.fr/feed/' },
  { source: 'Le Monde Informatique', theme: 'cyber', url: 'https://www.lemondeinformatique.fr/flux-rss/thematique/securite/rss.xml' },
  { source: 'ZATAZ', theme: 'cyber', url: 'https://www.zataz.com/feed/' },
  { source: 'IT-Connect', theme: 'admin', url: 'https://www.it-connect.fr/feed/' },
  { source: 'LeMagIT', theme: 'admin', url: 'https://www.lemagit.fr/rss/ContentSyndication.xml' },
];
const OUT = new URL('../veille.json', import.meta.url);
const PER_FEED = 3;      // articles max par source et par semaine
const KEEP = 60;         // taille de l'archive
const WINDOW = 8 * 864e5; // une semaine (+1 jour de marge)

// shortcut: seules les entités HTML courantes en français sont connues ; en ajouter ici si un flux en affiche une autre.
const ENTITIES = { eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', ugrave: 'ù', ucirc: 'û',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', Eacute: 'É', Agrave: 'À', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', hellip: '…', ndash: '–', mdash: '—', euro: '€', oelig: 'œ', middot: '·' };
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? m)
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
const text = s => decode(decode(s || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, names) => {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`));
    if (m) return m[1];
  }
  return '';
};
const cut = (s, n) => s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;

// shortcut: parseur RSS/Atom par expressions régulières, suffisant pour des flux bien formés ; passer à une vraie lib XML si un flux casse.
export function parse(xml) {
  return (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || []).map(it => {
    const atomLink = it.match(/<link[^>]*?href="([^"]+)"/);
    const date = new Date(text(tag(it, ['pubDate', 'published', 'updated', 'dc:date'])));
    return {
      title: text(tag(it, ['title'])),
      url: text(tag(it, ['link'])) || (atomLink ? decode(atomLink[1]) : ''),
      date: isNaN(date) ? null : date.toISOString().slice(0, 10),
      // retire la mention « Le post … est apparu en premier sur … » ajoutée par WordPress
      summary: cut(text(tag(it, ['description', 'summary', 'content'])).replace(/\s+(Le post|The post) .*$/, ''), 220),
    };
  }).filter(a => a.title && /^https?:\/\//.test(a.url) && a.date);
}

async function fromFeed(f, since) {
  const res = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (veille portfolio)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Certains flux ne sont pas en UTF-8 (ex. ISO-8859-15) : on lit l'encodage déclaré dans l'en-tête XML
  const buf = new Uint8Array(await res.arrayBuffer());
  const enc = (new TextDecoder('latin1').decode(buf.slice(0, 200)).match(/encoding="([^"]+)"/) || [])[1] || 'utf-8';
  return parse(new TextDecoder(enc).decode(buf))
    .filter(a => new Date(a.date) >= since)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, PER_FEED)
    .map(a => ({ ...a, source: f.source, theme: f.theme }));
}

// Feedly (optionnel) : FEEDLY_TOKEN = jeton d'accès, FEEDLY_STREAM = id du flux (ex. user/<id>/category/global.all)
async function fromFeedly(since) {
  const { FEEDLY_TOKEN: token, FEEDLY_STREAM: stream } = process.env;
  if (!token || !stream) return [];
  const url = `https://cloud.feedly.com/v3/streams/contents?count=20&newerThan=${since.getTime()}&streamId=${encodeURIComponent(stream)}`;
  const res = await fetch(url, { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Feedly HTTP ${res.status}`);
  return ((await res.json()).items || []).map(i => ({
    title: text(i.title),
    url: i.canonicalUrl || i.alternate?.[0]?.href || '',
    date: new Date(i.published).toISOString().slice(0, 10),
    summary: cut(text(i.summary?.content), 220),
    source: i.origin?.title || 'Feedly',
    theme: 'feedly',
  })).filter(a => a.title && a.url);
}

async function main() {
  const since = new Date(Date.now() - WINDOW);
  let old = [];
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* premier lancement */ }

  const fresh = [];
  for (const job of [...FEEDS.map(f => () => fromFeed(f, since)), () => fromFeedly(since)]) {
    try { fresh.push(...await job()); } catch (e) { console.warn('Flux ignoré :', e.message); }
  }

  const seen = new Set();
  const all = [...fresh, ...old]
    .filter(a => !seen.has(a.url) && seen.add(a.url))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, KEEP);
  fs.writeFileSync(OUT, JSON.stringify(all, null, 1) + '\n');
  console.log(`${fresh.length} article(s) cette semaine, ${all.length} dans l'archive.`);
}

function selfTest() {
  const rss = `<rss><channel><title>X</title><item><title><![CDATA[Faille &amp; correctif]]></title>
    <link>https://a.fr/1</link><pubDate>Mon, 19 Oct 2026 10:00:00 +0000</pubDate>
    <description>&lt;p&gt;Un &lt;b&gt;résumé&lt;/b&gt;&lt;/p&gt;</description></item>
    <item><title>Sans date</title><link>https://a.fr/2</link></item></channel></rss>`;
  const atom = `<feed><entry><title type="html">Titre Atom</title><link rel="alternate" href="https://b.fr/x?a=1&amp;b=2"/>
    <updated>2026-10-20T08:00:00Z</updated><summary>Résumé</summary></entry></feed>`;
  assert.deepStrictEqual(parse(rss), [{ title: 'Faille & correctif', url: 'https://a.fr/1', date: '2026-10-19', summary: 'Un résumé' }]);
  assert.deepStrictEqual(parse(atom), [{ title: 'Titre Atom', url: 'https://b.fr/x?a=1&b=2', date: '2026-10-20', summary: 'Résumé' }]);
  assert.strictEqual(text('S&amp;eacute;curit&eacute; &lt;i&gt;r&eacute;seau&lt;/i&gt;'), 'Sécurité réseau');
  console.log('OK');
}

process.argv.includes('--test') ? selfTest() : await main();
