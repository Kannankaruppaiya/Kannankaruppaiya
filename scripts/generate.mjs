#!/usr/bin/env node
// Builds profile/dark.svg and profile/light.svg from the GitHub GraphQL API.
// Run: GH_TOKEN=<token> node scripts/generate.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const LOGIN = process.env.PROFILE_LOGIN || 'Kannankaruppaiya';
const TOKEN = process.env.GH_TOKEN;
const TZ = 'Asia/Kolkata';
if (!TOKEN) throw new Error('GH_TOKEN is required');

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-card' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const MAIN = `query($login: String!) {
  user(login: $login) {
    name login createdAt avatarUrl
    followers { totalCount }
    pullRequests { totalCount }
    contributionsCollection {
      contributionYears restrictedContributionsCount
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount weekday } } }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount
      nodes {
        name description isPrivate stargazerCount forkCount pushedAt
        primaryLanguage { name color }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
      }
    }
  }
}`;

// ---------- data ----------
const { user } = await gql(MAIN, { login: LOGIN });
const cc = user.contributionsCollection;

const yearFields = cc.contributionYears
  .map((y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") { totalCommitContributions restrictedContributionsCount }`)
  .join('\n');
const years = (await gql(`query($login: String!) { user(login: $login) { ${yearFields} } }`, { login: LOGIN })).user;
const allTimeCommits = Object.values(years).reduce((s, y) => s + y.totalCommitContributions + y.restrictedContributionsCount, 0);

const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const weeks = cc.contributionCalendar.weeks;
const days = weeks.flatMap((w) => w.contributionDays).filter((d) => d.date <= today);

let longest = 0, run = 0;
for (const d of days) { run = d.contributionCount > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++;
  else if (i === days.length - 1) continue; // today not yet contributed doesn't break the streak
  else break;
}
const bestDay = days.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), days[0]);

const byWeekday = Array(7).fill(0);
for (const d of days) byWeekday[d.weekday] += d.contributionCount;

const repos = user.repositories.nodes;
const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);

const langMap = new Map();
for (const r of repos) for (const e of r.languages.edges) {
  const cur = langMap.get(e.node.name) || { name: e.node.name, color: e.node.color || '#8b949e', size: 0 };
  cur.size += e.size;
  langMap.set(e.node.name, cur);
}
const langTotal = [...langMap.values()].reduce((s, l) => s + l.size, 0) || 1;
let langs = [...langMap.values()].sort((a, b) => b.size - a.size);
if (langs.length > 8) {
  const rest = langs.slice(7).reduce((s, l) => s + l.size, 0);
  langs = [...langs.slice(0, 7), { name: 'Other', color: '#8b949e', size: rest }];
}
langs = langs.map((l) => ({ ...l, pct: (l.size / langTotal) * 100 }));

const topRepos = repos
  .filter((r) => !r.isPrivate)
  .sort((a, b) => b.stargazerCount - a.stargazerCount || b.pushedAt.localeCompare(a.pushedAt))
  .slice(0, 4);

let avatar = '';
try {
  const u = new URL(user.avatarUrl);
  u.searchParams.set('s', '160');
  const res = await fetch(u);
  avatar = `data:${res.headers.get('content-type') || 'image/png'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
} catch { /* render without avatar */ }

// ---------- rendering ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
const dateLabel = (iso, opts) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

const THEMES = {
  dark: {
    bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#e6edf3', muted: '#8b949e',
    accent: '#a78bfa', heat: ['#1f2530', '#3b2f6b', '#5b43b0', '#8b6cf0', '#c4b5fd'],
  },
  light: {
    bg: '#ffffff', panel: '#f6f8fa', border: '#d0d7de', text: '#1f2328', muted: '#656d76',
    accent: '#6d28d9', heat: ['#ebedf0', '#ddd6fe', '#a78bfa', '#7c3aed', '#4c1d95'],
  },
};

const nonZero = days.map((d) => d.contributionCount).filter((c) => c > 0).sort((a, b) => a - b);
const q = (p) => nonZero[Math.floor((nonZero.length - 1) * p)] || 0;
const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
const level = (c) => (c === 0 ? 0 : c <= q1 ? 1 : c <= q2 ? 2 : c <= q3 ? 3 : 4);

function render(t) {
  const W = 920, P = 32, inner = W - P * 2;
  const out = [];
  const text = (x, y, s, { size = 13, fill = t.text, weight = 400, anchor = 'start', extra = '' } = {}) =>
    out.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${esc(s)}</text>`);
  const title = (x, y, s) => {
    out.push(`<rect x="${x}" y="${y - 11}" width="3" height="14" rx="1.5" fill="${t.accent}"/>`);
    text(x + 11, y, s, { size: 14, weight: 600 });
  };

  // header
  if (avatar) {
    out.push(`<clipPath id="av"><circle cx="${P + 36}" cy="${P + 36}" r="36"/></clipPath>`);
    out.push(`<image href="${avatar}" x="${P}" y="${P}" width="72" height="72" clip-path="url(#av)"/>`);
    out.push(`<circle cx="${P + 36}" cy="${P + 36}" r="36" fill="none" stroke="${t.border}" stroke-width="2"/>`);
  }
  const hx = avatar ? P + 92 : P;
  text(hx, P + 32, user.name || user.login, { size: 26, weight: 700 });
  text(hx, P + 58, `@${user.login}  ·  Joined ${new Date(user.createdAt).getFullYear()}  ·  ${fmt(user.followers.totalCount)} followers`, { size: 14, fill: t.muted });
  text(W - P, P + 34, (cc.contributionCalendar.totalContributions + cc.restrictedContributionsCount).toLocaleString('en-US'), { size: 32, weight: 700, fill: t.accent, anchor: 'end' });
  text(W - P, P + 58, 'contributions in the last year', { size: 13, fill: t.muted, anchor: 'end' });
  out.push(`<line x1="${P}" y1="128" x2="${W - P}" y2="128" stroke="${t.border}"/>`);

  // stat tiles
  const stats = [
    [fmt(allTimeCommits), 'All-time commits'],
    [fmt(user.pullRequests.totalCount), 'Pull requests'],
    [fmt(user.repositories.totalCount), 'Repositories'],
    [fmt(stars), 'Stars earned'],
    [`${current}d`, 'Current streak'],
    [`${longest}d`, 'Longest streak'],
  ];
  const gap = 12, tw = (inner - gap * (stats.length - 1)) / stats.length;
  stats.forEach(([v, l], i) => {
    const x = P + i * (tw + gap);
    out.push(`<rect x="${x}" y="148" width="${tw}" height="76" rx="10" fill="${t.panel}" stroke="${t.border}"/>`);
    text(x + 16, 182, v, { size: 22, weight: 700 });
    text(x + 16, 206, l, { size: 12, fill: t.muted });
  });

  // heatmap
  title(P, 262, 'Contribution activity');
  const cell = 12, step = 15, gx = P + 30, gy = 296;
  let lastLabelX = -100, lastMonth = '';
  weeks.forEach((w, wi) => {
    const x = gx + wi * step;
    const m = w.contributionDays[0].date.slice(0, 7);
    if (m !== lastMonth && x - lastLabelX > 30) {
      text(x, gy - 8, dateLabel(w.contributionDays[0].date, { month: 'short' }), { size: 10, fill: t.muted });
      lastLabelX = x;
    }
    lastMonth = m;
    for (const d of w.contributionDays) {
      if (d.date > today) continue;
      out.push(`<rect x="${x}" y="${gy + d.weekday * step}" width="${cell}" height="${cell}" rx="3" fill="${t.heat[level(d.contributionCount)]}"><title>${d.contributionCount} on ${d.date}</title></rect>`);
    }
  });
  [['Mon', 1], ['Wed', 3], ['Fri', 5]].forEach(([l, r]) => text(P, gy + r * step + 10, l, { size: 10, fill: t.muted }));
  const ly = gy + 7 * step + 16;
  text(P, ly, `Best day: ${bestDay.contributionCount} contributions on ${dateLabel(bestDay.date, { day: 'numeric', month: 'short', year: 'numeric' })}`, { size: 11, fill: t.muted });
  const lx = W - P - 5 * step - 30;
  text(lx - 6, ly, 'Less', { size: 11, fill: t.muted, anchor: 'end' });
  t.heat.forEach((c, i) => out.push(`<rect x="${lx + i * step}" y="${ly - 10}" width="${cell}" height="${cell}" rx="3" fill="${c}"/>`));
  text(lx + 5 * step + 3, ly, 'More', { size: 11, fill: t.muted });

  // languages (left column)
  const cy = ly + 44, colW = 420;
  title(P, cy, 'Languages');
  out.push(`<clipPath id="lb"><rect x="${P}" y="${cy + 18}" width="${colW}" height="10" rx="5"/></clipPath><g clip-path="url(#lb)">`);
  let bx = P;
  for (const l of langs) {
    const w = (l.pct / 100) * colW;
    out.push(`<rect x="${bx}" y="${cy + 18}" width="${w + 0.5}" height="10" fill="${l.color}"/>`);
    bx += w;
  }
  out.push('</g>');
  langs.forEach((l, i) => {
    const x = P + (i % 2) * 215, y = cy + 54 + Math.floor(i / 2) * 24;
    out.push(`<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>`);
    text(x + 16, y, trunc(l.name, 16), { size: 13 });
    text(x + 200, y, `${l.pct.toFixed(1)}%`, { size: 12, fill: t.muted, anchor: 'end' });
  });

  // weekday activity (right column)
  const rx = P + colW + 36, rw = W - P - rx;
  title(rx, cy, 'Activity by weekday');
  const maxWd = Math.max(...byWeekday, 1), barH = 84, slot = rw / 7, baseY = cy + 122;
  byWeekday.forEach((v, i) => {
    const h = Math.max(3, (v / maxWd) * barH), x = rx + i * slot + (slot - 28) / 2;
    const top = v === maxWd;
    out.push(`<rect x="${x}" y="${baseY - h}" width="28" height="${h}" rx="5" fill="${t.accent}" fill-opacity="${top ? 1 : 0.4}"/>`);
    text(x + 14, baseY - h - 6, fmt(v), { size: 11, fill: top ? t.text : t.muted, anchor: 'middle', weight: top ? 600 : 400 });
    text(x + 14, baseY + 18, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i], { size: 11, fill: t.muted, anchor: 'middle' });
  });

  // top repositories
  let y = baseY + 60;
  if (topRepos.length) {
    title(P, y, 'Top repositories');
    const cw = (inner - 16) / 2, ch = 78;
    topRepos.forEach((r, i) => {
      const x = P + (i % 2) * (cw + 16), cy2 = y + 18 + Math.floor(i / 2) * (ch + 12);
      out.push(`<rect x="${x}" y="${cy2}" width="${cw}" height="${ch}" rx="10" fill="${t.panel}" stroke="${t.border}"/>`);
      text(x + 16, cy2 + 26, trunc(r.name, 40), { size: 14, weight: 600, fill: t.accent });
      text(x + 16, cy2 + 46, trunc(r.description || 'No description', 60), { size: 12, fill: t.muted });
      let mx = x + 16;
      if (r.primaryLanguage) {
        out.push(`<circle cx="${mx + 4}" cy="${cy2 + 62}" r="4" fill="${r.primaryLanguage.color || t.muted}"/>`);
        text(mx + 13, cy2 + 66, r.primaryLanguage.name, { size: 11, fill: t.muted });
        mx += 24 + r.primaryLanguage.name.length * 6.5;
      }
      text(mx, cy2 + 66, `★ ${r.stargazerCount}    ⑂ ${r.forkCount}`, { size: 11, fill: t.muted });
    });
    y += 18 + Math.ceil(topRepos.length / 2) * (ch + 12) - 12;
  }

  const updated = new Date().toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
  text(W - P, y + 30, `Updated ${updated}`, { size: 10, fill: t.muted, anchor: 'end' });
  const H = y + 46;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${t.bg}" stroke="${t.border}"/>
${out.join('\n')}
</svg>
`;
}

await mkdir('profile', { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) await writeFile(`profile/${name}.svg`, render(theme));
console.log(`Wrote profile/dark.svg and profile/light.svg (${days.length} days, ${repos.length} repos, ${langs.length} languages)`);
