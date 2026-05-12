import { api, ApiError, getToken, setToken, clearToken } from './api.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  LEAGUES,
  formatDateTime,
  formatNumber,
  initials,
  statusClass,
  statusLabel,
  scoreLine,
  predictionStatus,
  routeName,
  routeParts,
  clampText
} from './utils.js';

const e = React.createElement;
const mountNode = document.getElementById('root');
const root = mountNode ? createRoot(mountNode) : null;

// ─── Global state (plain object) ──────────────────────────────────────────────
const state = {
  me: null,
  matches: [],
  leaderboard: [],
  predictions: [],
  walletHistory: [],
  notifications: [],
  detail: null,
  chat: [],
  admin: null,
  betDrafts: {},
  filters: { league: 'all', status: 'all', date: '', q: '' },
  leaderboardPeriod: 'all-time',
  toast: null,
  stream: null,
  busy: false
};

// Subscriber pattern – replaces render() calls
let _subs = [];
function subscribe(fn) {
  _subs.push(fn);
  return () => { _subs = _subs.filter(f => f !== fn); };
}
function notify() { _subs.forEach(fn => fn()); }

// ─── Constants ────────────────────────────────────────────────────────────────
const MARKET_TYPE_LABELS = {
  all: 'Tất cả', moneyline: 'Cả trận', handicap: 'Handicap',
  total: 'Tài / Xỉu', double_chance: 'Kép', player_prop: 'Cầu thủ',
  generic: 'Khác', other: 'Khác'
};
const MARKET_TYPE_ORDER = ['moneyline', 'handicap', 'total', 'double_chance', 'player_prop', 'generic', 'other'];

// ─── Toast ────────────────────────────────────────────────────────────────────
function setToast(message, tone = 'info') {
  state.toast = { message, tone };
  window.clearTimeout(setToast.timer);
  setToast.timer = window.setTimeout(() => { state.toast = null; notify(); }, 3500);
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function marketTypeKey(market) { return market?.marketType || 'other'; }
function marketTypeLabel(type) { return MARKET_TYPE_LABELS[type] || MARKET_TYPE_LABELS.other; }

function buildMarketSections(markets) {
  const buckets = new Map();
  for (const market of markets || []) {
    const key = marketTypeKey(market);
    if (!buckets.has(key)) buckets.set(key, { key, label: marketTypeLabel(key), markets: [] });
    buckets.get(key).markets.push(market);
  }
  return [...buckets.values()]
    .sort((a, b) => {
      const li = MARKET_TYPE_ORDER.indexOf(a.key);
      const ri = MARKET_TYPE_ORDER.indexOf(b.key);
      return (li === -1 ? 99 : li) - (ri === -1 ? 99 : ri);
    })
    .map(s => ({
      ...s,
      providers: [...new Set(s.markets.map(m => m.provider || m.providerId || 'ESPN'))]
    }));
}

function findFirstPick(markets) {
  for (const market of markets || []) {
    if (market.disabled || !Array.isArray(market.options) || !market.options.length) continue;
    return { marketKey: market.key, optionKey: market.options[0].key, market, option: market.options[0] };
  }
  return null;
}

function findDraftPick(matchId, markets) {
  const draft = state.betDrafts[String(matchId)];
  if (!draft) return null;
  for (const market of markets || []) {
    if (market.key !== draft.marketKey || market.disabled) continue;
    const option = market.options?.find(o => o.key === draft.optionKey);
    if (option) return { marketKey: market.key, optionKey: option.key, market, option };
  }
  return null;
}

function oddsValue(value) {
  const d = Number(value);
  return Number.isFinite(d) && d > 1 ? `x${d.toFixed(2)}` : '-';
}

function isMatchLive(match) {
  return Boolean(match?.isLive || match?.status === 'in');
}

function isMatchFinal(match) {
  return Boolean(match?.isFinal || match?.status === 'post');
}

function isUpcomingMatch(match) {
  return !isMatchLive(match) && !isMatchFinal(match) && !match?.locked;
}

function betStatusTone(status) {
  if (status === 'won') return 'good';
  if (status === 'lost') return 'bad';
  return '';
}

function matchResultSummary(match) {
  if (!match) return { score: 'TBD', state: 'No result', tone: 'pending' };
  if (isMatchLive(match)) {
    return { score: scoreLine(match), state: statusLabel(match), tone: 'live' };
  }
  if (isMatchFinal(match)) {
    return { score: scoreLine(match), state: 'FT', tone: 'final' };
  }
  return { score: formatDateTime(match.kickoffTime), state: statusLabel(match), tone: 'pending' };
}

function groupMatchesByLeague(matches, maxLeagues = 8) {
  const groups = new Map();
  for (const match of matches || []) {
    const key = match.league || 'other';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: match.leagueLabel || match.league || 'Other',
        matches: []
      });
    }
    const group = groups.get(key);
    group.matches.push(match);
  }
  return [...groups.values()].slice(0, maxLeagues);
}

function betProjection(stake, odds) {
  const bet = Number(stake || 0);
  const d = Number(odds);
  if (!Number.isFinite(bet) || bet <= 0 || !Number.isFinite(d) || d <= 1)
    return 'Chọn kèo để xem trả về';
  const payout = Math.round(bet * d);
  return `Đặt ${formatNumber(bet)} nhận ${formatNumber(payout)}, lời ${formatNumber(Math.max(0, payout - bet))}`;
}

// ─── Data fetching ────────────────────────────────────────────────────────────
async function loadSession() {
  if (!getToken()) return;
  try {
    const data = await api('/api/auth/me');
    state.me = data.user;
    await refreshPrivateData();
  } catch {
    clearToken();
    state.me = null;
  }
}

async function refreshPublicData() {
  const params = new URLSearchParams();
  if (state.filters.league !== 'all') params.set('league', state.filters.league);
  if (state.filters.status !== 'all') params.set('status', state.filters.status);
  if (state.filters.date) params.set('date', state.filters.date);
  if (state.filters.q) params.set('q', state.filters.q);
  const [m, lb] = await Promise.all([
    api(`/api/matches?${params}`),
    api(`/api/leaderboard?period=${encodeURIComponent(state.leaderboardPeriod)}`)
  ]);
  state.matches = m.matches || [];
  state.leaderboard = lb.leaderboard || [];
}

async function refreshPublicDataQuiet() {
  try {
    await refreshPublicData();
    notify();
  } catch { /* keep alive */ }
}

async function refreshPrivateData() {
  if (!state.me) return;
  const [p, w, n] = await Promise.all([
    api('/api/predictions/me'),
    api('/api/wallet/history'),
    api('/api/notifications?limit=20')
  ]);
  state.predictions = p.predictions || [];
  state.walletHistory = w.history || [];
  state.notifications = n.notifications || [];
}

async function loadRouteData() {
  const [name, id] = routeParts();
  state.detail = null;
  state.chat = [];
  if (name === 'match' && id) {
    const detail = await api(`/api/matches/${encodeURIComponent(id)}`);
    state.detail = detail.match;
    state.chat = detail.chat || [];
  }
  if (name === 'profile' && state.me) await refreshPrivateData();
  if (name === 'admin' && state.me?.role === 'admin') await loadAdminData();
}

async function loadAdminData() {
  const [u, tx, cfg, m, p] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/transactions'),
    api('/api/admin/config'),
    api('/api/admin/matches'),
    api('/api/admin/predictions?status=pending')
  ]);
  state.admin = {
    users: u.users || [],
    transactions: tx.transactions || [],
    settings: cfg.settings || {},
    matches: m.matches || [],
    predictions: p.predictions || []
  };
}

function openStream() {
  if (state.stream) { state.stream.close(); state.stream = null; }
  const token = getToken();
  if (!token) return;
  const stream = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  stream.addEventListener('matches.updated', refreshFromStream);
  stream.addEventListener('leaderboard.updated', refreshFromStream);
  stream.addEventListener('wallet.updated', refreshFromStream);
  stream.addEventListener('chat.message', refreshFromStream);
  stream.addEventListener('chat.deleted', refreshFromStream);
  stream.onerror = () => {};
  state.stream = stream;
}

async function refreshFromStream() {
  try {
    await refreshPublicData();
    if (state.me) await refreshPrivateData();
    if (routeName() === 'match') await loadRouteData();
    if (routeName() === 'admin' && state.me?.role === 'admin') await loadAdminData();
    notify();
  } catch { /* fast path */ }
}

// ─── Task runner ──────────────────────────────────────────────────────────────
async function runTask(task, successMessage, showSuccess = true) {
  state.busy = true;
  notify();
  try {
    await task();
    if (showSuccess) setToast(successMessage, 'good');
  } catch (err) {
    setToast(err instanceof ApiError ? err.message : 'Action failed', 'bad');
  } finally {
    state.busy = false;
    notify();
  }
}

// ─── Route binding ────────────────────────────────────────────────────────────
function bindEvents() {
  window.addEventListener('hashchange', async () => {
    await loadRouteData().catch(err => setToast(err.message, 'bad'));
    notify();
  });
}

// =============================================================================
// React Components
// =============================================================================

function ToastBar() {
  if (!state.toast) return null;
  return e('div', { className: `toast ${state.toast.tone}` }, state.toast.message);
}

// ─── Top bar ──────────────────────────────────────────────────────────────────
function TopBar() {
  const page = routeName();
  const liveCount = state.matches.filter(m => m.isLive || m.status === 'in').length;

  const handleLogout = () => {
    clearToken();
    state.me = null;
    state.predictions = [];
    state.walletHistory = [];
    state.betDrafts = {};
    if (state.stream) state.stream.close();
    window.location.hash = '#/home';
    notify();
  };

  const handleRefresh = () => runTask(async () => {
    await refreshPublicData();
    if (state.me) await refreshPrivateData();
    await loadRouteData();
  }, 'Refreshed');

  const navItems = [
    ['home', 'Home', '#/home'],
    ['leaderboard', 'Leaderboard', '#/leaderboard'],
    ...(state.me ? [['profile', 'Profile', '#/profile']] : []),
    ...(state.me?.role === 'admin' ? [['admin', 'Admin', '#/admin']] : [])
  ];

  return e('header', { className: 'topbar' },
    e('a', { className: 'brand', href: '#/home', 'aria-label': 'Worldcup Pick home' },
      e('span', { className: 'brand-mark' }, 'WP'),
      e('span', null,
        e('strong', null, 'Worldcup Pick'),
        e('small', null, 'Virtual points only')
      )
    ),
    e('nav', { className: 'nav' },
      navItems.map(([key, label, href]) =>
        e('a', { key, className: page === key ? 'active' : undefined, href }, label)
      )
    ),
    e('div', { className: 'top-actions' },
      state.busy ? e('span', { className: 'mini-loader' }) : null,
      e('span', { className: 'chip live-dot' }, `${formatNumber(liveCount)} live`),
      state.me ? e('span', { className: 'chip' }, `${formatNumber(state.me.points)} pts`) : null,
      e('button', { className: 'icon-button', onClick: handleRefresh, title: 'Refresh' }, '\u21bb'),
      state.me
        ? e('button', { className: 'ghost-button', onClick: handleLogout }, 'Logout')
        : e(React.Fragment, null,
            e('a', { className: 'ghost-button', href: '#/register' }, '\u0110\u0103ng k\u00fd'),
            e('a', { className: 'primary-link', href: '#/login' }, 'Login')
          )
    )
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
function App() {
  const [, forceUpdate] = React.useState(0);
  React.useEffect(() => subscribe(() => forceUpdate(v => v + 1)), []);

  const page = routeName();
  const pageMap = {
    auth: LoginPage, login: LoginPage,
    register: RegisterPage,
    leaderboard: LeaderboardPage,
    profile: ProfilePage,
    match: MatchPage,
    admin: AdminPage
  };
  const PageComp = pageMap[page] || HomePage;

  return e('div', { className: 'shell' },
    e(TopBar, null),
    e('main', { className: 'app', 'aria-live': 'polite' },
      e(PageComp, null)
    )
  );
}

// ─── Home page ────────────────────────────────────────────────────────────────
function HomePage() {
  const [expandedLeagueKey, setExpandedLeagueKey] = React.useState('');
  const isFocusedLeague = state.filters.league !== 'all';
  const live = state.matches.filter(isMatchLive).slice(0, 4);
  const upcomingAll = state.matches
    .filter(isUpcomingMatch)
    .sort((a, b) => new Date(a.kickoffTime || 0) - new Date(b.kickoffTime || 0));
  const hotAll = [...state.matches]
    .sort((a, b) => Number(b.hotScore || 0) - Number(a.hotScore || 0));
  const upcomingByLeague = groupMatchesByLeague(upcomingAll, 8);
  const hotByLeague = groupMatchesByLeague(hotAll, 8);

  const handleFilterChange = async (key, value) => {
    state.filters[key] = value;
    await runTask(refreshPublicData, '', false);
  };

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'hero' },
      e('div', null,
        e('p', { className: 'eyebrow' }, 'ESPN public scoreboard'),
        e('h1', null, 'Pick football lines with friends, using virtual points only.'),
        e('p', { className: 'hero-copy' },
          'No payment, no cash-out, no real-money flow. Bets are locked before kickoff and settled from match result.'
        )
      ),
      e('div', { className: 'hero-stats' },
        e('span', null, e('b', null, formatNumber(state.matches.length)), ' matches'),
        e('span', null, e('b', null, formatNumber(state.leaderboard.length)), ' players'),
        e('span', null, e('b', null, state.me ? formatNumber(state.me.points) : '0'), ' my points')
      )
    ),
    e('section', { className: 'toolbar' },
      e('select', { value: state.filters.league, onChange: ev => handleFilterChange('league', ev.target.value) },
        LEAGUES.map(l => e('option', { key: l.value, value: l.value }, l.label))
      ),
      e('select', { value: state.filters.status, onChange: ev => handleFilterChange('status', ev.target.value) },
        e('option', { value: 'all' }, 'All status'),
        e('option', { value: 'live' }, 'Live'),
        e('option', { value: 'upcoming' }, 'Upcoming'),
        e('option', { value: 'final' }, 'Final')
      ),
      e('input', {
        type: 'date',
        value: state.filters.date,
        onChange: ev => handleFilterChange('date', ev.target.value)
      }),
      e('input', {
        type: 'search',
        placeholder: 'Search team',
        value: state.filters.q,
        onChange: ev => handleFilterChange('q', ev.target.value)
      }),
      e('button', {
        className: 'secondary-button',
        onClick: () => runTask(refreshPublicData, 'Refreshed')
      }, 'Refresh')
    ),
    e('section', { className: 'grid two' },
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Live scores'), e('span', null, formatNumber(live.length))),
        e(MatchList, { matches: live })
      ),
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Leaderboard'), e('a', { href: '#/leaderboard' }, 'View all')),
        e(LeaderboardMini, null)
      )
    ),
    e('section', { className: 'grid two' },
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Upcoming by league'), e('span', null, formatNumber(upcomingAll.length))),
        e(LeagueMatchSections, {
          sectionId: 'upcoming',
          groups: upcomingByLeague,
          previewCount: 2,
          expandedLeagueKey,
          onToggleExpand: setExpandedLeagueKey,
          forceShowAll: isFocusedLeague,
          forceCompact: isFocusedLeague,
          emptyText: 'No upcoming matches.'
        })
      ),
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Hot by league'), e('span', null, formatNumber(hotAll.length))),
        e(LeagueMatchSections, {
          sectionId: 'hot',
          groups: hotByLeague,
          previewCount: 2,
          expandedLeagueKey,
          onToggleExpand: setExpandedLeagueKey,
          forceShowAll: isFocusedLeague,
          forceCompact: isFocusedLeague,
          emptyText: 'No hot matches.'
        })
      )
    )
  );
}

function LeagueMatchSections({
  sectionId,
  groups,
  previewCount = 2,
  expandedLeagueKey,
  onToggleExpand,
  forceShowAll = false,
  forceCompact = false,
  emptyText
}) {
  if (!groups.length) return e('div', { className: 'empty' }, emptyText || 'No matches found.');
  return e('div', { className: 'league-sections' },
    groups.map(group => {
      const key = `${sectionId}:${group.key}`;
      const expanded = forceShowAll || expandedLeagueKey === key;
      const visibleMatches = forceShowAll ? group.matches : (expanded ? group.matches : group.matches.slice(0, previewCount));
      return e('section', { key: group.key, className: `league-section${expanded ? ' expanded' : ''}` },
        e('div', { className: 'section-head league-head' },
          e('h3', null, group.label),
          e('div', { className: 'league-head-actions' },
            e('span', null, `${formatNumber(group.matches.length)} matches`),
            !forceShowAll && group.matches.length > previewCount
              ? e('button', {
                  type: 'button',
                  className: 'ghost-button league-toggle',
                  onClick: () => onToggleExpand(expanded ? '' : key)
                }, expanded ? 'Thu gọn' : 'Xem tất cả')
              : null
          )
        ),
        e(MatchList, { matches: visibleMatches, compact: forceCompact || !expanded })
      );
    })
  );
}

function MatchList({ matches, compact = false }) {
  if (!matches.length) return e('div', { className: 'empty' }, 'No matches found.');
  return e('div', { className: `match-list${compact ? ' compact-match-list' : ''}` },
    matches.map(match => e(MatchCard, { key: match.id, match }))
  );
}

function MatchCard({ match }) {
  return e('a', { className: 'match-card', href: `#/match/${match.id}` },
    e('span', { className: `badge ${statusClass(match)}` }, statusLabel(match)),
    e('div', { className: 'match-league' }, match.leagueLabel || match.league),
    e('div', { className: 'teams' },
      e(TeamDisplay, { name: match.homeTeam, logo: match.homeLogo }),
      e('strong', { className: 'score' }, scoreLine(match)),
      e(TeamDisplay, { name: match.awayTeam, logo: match.awayLogo })
    ),
    e('div', { className: 'match-meta' },
      e('span', null, formatDateTime(match.kickoffTime)),
      e('span', null, match.locked ? 'Locked' : 'Open')
    ),
    match.userPrediction
      ? e('div', { className: 'prediction-pill' }, predictionStatus(match.userPrediction))
      : null
  );
}

function TeamDisplay({ name, logo }) {
  return e('span', { className: 'team' },
    logo ? e('img', { src: logo, alt: '' }) : e('span', { className: 'avatar' }, initials(name)),
    e('span', null, name)
  );
}

function LeaderboardMini() {
  if (!state.leaderboard.length) return e('div', { className: 'empty' }, 'No players yet.');
  return e('div', { className: 'rank-list' },
    state.leaderboard.slice(0, 6).map(row =>
      e('div', { key: row.id, className: 'rank-row' },
        e('b', null, `#${row.rank}`),
        e('span', { className: 'avatar' }, initials(row.username)),
        e('span', null, row.username),
        e('strong', null, `${formatNumber(row.points)} pts`)
      )
    )
  );
}

// ─── Leaderboard page ─────────────────────────────────────────────────────────
function LeaderboardPage() {
  const handlePeriod = period => runTask(async () => {
    state.leaderboardPeriod = period;
    await refreshPublicData();
  }, 'Leaderboard updated');

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'page-head' },
      e('div', null, e('p', { className: 'eyebrow' }, 'Competition'), e('h1', null, 'Leaderboard')),
      e('div', { className: 'segmented' },
        ['all-time', 'week', 'month'].map(period =>
          e('button', {
            key: period,
            className: state.leaderboardPeriod === period ? 'active' : undefined,
            onClick: () => handlePeriod(period)
          }, period)
        )
      )
    ),
    e('section', { className: 'panel' },
      e('div', { className: 'table-wrap' },
        e('table', null,
          e('thead', null,
            e('tr', null,
              e('th', null, 'Rank'), e('th', null, 'User'), e('th', null, 'Points'),
              e('th', null, 'Accuracy'), e('th', null, 'Matches')
            )
          ),
          e('tbody', null,
            state.leaderboard.map(row =>
              e('tr', { key: row.id },
                e('td', null, `#${row.rank}`),
                e('td', null,
                  e('span', { className: 'cell-user' },
                    e('span', { className: 'avatar' }, initials(row.username)),
                    row.username
                  )
                ),
                e('td', null, formatNumber(state.leaderboardPeriod === 'all-time' ? row.points : row.periodPoints)),
                e('td', null, `${row.accuracy}%`),
                e('td', null, formatNumber(row.predictions))
              )
            )
          )
        )
      )
    )
  );
}

// ─── Match page ───────────────────────────────────────────────────────────────
function MatchPage() {
  const [, id] = routeParts();
  const match = state.detail || state.matches.find(m => String(m.id) === String(id));
  if (!match) return e(React.Fragment, null, e(ToastBar, null), e('div', { className: 'empty page-empty' }, 'Match not found.'));

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'match-hero' },
      e('div', null,
        e('p', { className: 'eyebrow' }, match.leagueLabel || match.league),
        e('h1', null, `${match.homeTeam} vs ${match.awayTeam}`),
        e('p', null, formatDateTime(match.kickoffTime), match.venue ? ` - ${match.venue}` : '')
      ),
      e('div', { className: 'big-score' },
        e('span', null, formatNumber(match.homeScore)),
        e('b', null, match.status === 'pre' && !match.isLive ? 'vs' : '-'),
        e('span', null, formatNumber(match.awayScore))
      ),
      e('span', { className: `badge ${statusClass(match)}` }, statusLabel(match))
    ),
    e('section', { className: 'grid two' },
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' },
          e('h2', null, 'B\u1ea3ng c\u01b0\u1ee3c'),
          e('span', null, match.locked ? 'Kh\u00f3a' : 'M\u1edf')
        ),
        e(BetSection, { match, key: match.id })
      ),
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' },
          e('h2', null, 'Chat ph\u00f2ng'),
          e('span', null, formatNumber(state.chat.length))
        ),
        e(ChatBox, { match })
      )
    )
  );
}

// ─── Bet section ──────────────────────────────────────────────────────────────
function BetSection({ match }) {
  if (!state.me) {
    return e('div', { className: 'empty' },
      '\u0110\u0103ng nh\u1eadp \u0111\u1ec3 \u0111\u1eb7t k\u00e8o. ',
      e('a', { href: '#/login' }, '\u0110\u0103ng nh\u1eadp')
    );
  }
  const placed = match.userPredictions || (match.userPrediction ? [match.userPrediction] : []);
  return e(React.Fragment, null,
    e(PlacedBets, { predictions: placed }),
    match.locked
      ? e('div', { className: 'empty' }, 'C\u1eeda c\u01b0\u1ee3c \u0111\u00e3 \u0111\u00f3ng.')
      : e(BetForm, { match, key: match.id })
  );
}

function PlacedBets({ predictions }) {
  if (!predictions.length) return null;
  return e('div', { className: 'placed-bets' },
    predictions.map((pred, i) =>
      e('div', { key: i, className: 'placed-bet' },
        e('div', null,
          e('b', null, pred.market?.title || 'K\u00e8o c\u0169'),
          e('span', null,
            `${pred.market?.label || `${pred.predictedHomeScore}-${pred.predictedAwayScore}`} @ ${oddsValue(pred.market?.odds)}`
          )
        ),
        e('strong', null, predictionStatus(pred))
      )
    )
  );
}

// ─── Bet form ─────────────────────────────────────────────────────────────────
function BetForm({ match }) {
  const markets = Array.isArray(match.markets) ? match.markets : [];
  const walletPoints = Math.max(0, Number(state.me?.walletBalance || state.me?.points || 0));
  const draft = state.betDrafts[String(match.id)] || {};

  const [selectedPick, setSelectedPick] = React.useState(
    () => findDraftPick(match.id, markets) || findFirstPick(markets)
  );
  const [stake, setStake] = React.useState(
    () => Math.max(1, Number(draft.stake || 100))
  );
  const [marketFilter, setMarketFilter] = React.useState('all');

  if (!markets.length) {
    return e('div', { className: 'empty' }, 'Ch\u01b0a c\u00f3 odds t\u1eeb ESPN cho tr\u1eadn n\u00e0y.');
  }

  const sections = buildMarketSections(markets);
  const visibleSections = marketFilter === 'all' ? sections : sections.filter(s => s.key === marketFilter);

  const handlePickChange = (marketKey, optionKey, market, option) => {
    const pick = { marketKey, optionKey, market, option };
    setSelectedPick(pick);
    state.betDrafts[String(match.id)] = { ...(state.betDrafts[String(match.id)] || {}), marketKey, optionKey };
  };

  const handleStakeChange = value => {
    const next = Math.max(1, Number(value) || 1);
    setStake(next);
    state.betDrafts[String(match.id)] = { ...(state.betDrafts[String(match.id)] || {}), stake: next };
  };

  const handleSubmit = async ev => {
    ev.preventDefault();
    if (!selectedPick) return;
    await runTask(async () => {
      await api('/api/predictions', {
        method: 'POST',
        body: {
          matchId: match.id,
          marketKey: selectedPick.marketKey,
          optionKey: selectedPick.optionKey,
          betPoints: stake
        }
      });
      delete state.betDrafts[String(match.id)];
      await refreshPrivateData();
      await refreshPublicData();
      await loadRouteData();
    }, 'Bet saved');
  };

  const filterTabs = [
    { key: 'all', label: 'T\u1ea5t c\u1ea3', count: sections.reduce((t, s) => t + s.markets.length, 0) },
    ...sections.map(s => ({ key: s.key, label: s.label, count: s.markets.length }))
  ];

  return e('form', { className: 'bet-form', onSubmit: handleSubmit },
    e('div', { className: 'bet-meta' },
      e('span', { className: 'chip' }, `${formatNumber(walletPoints)} điểm hiện có`),
      e('span', { className: 'chip' }, `${formatNumber(markets.length)} kèo`),
      e('span', { className: 'chip' }, 'Điểm ảo')
    ),
    e('div', { className: 'bet-preview' },
      e('div', null,
        e('b', null, selectedPick?.market?.title || 'Ch\u01b0a ch\u1ecdn k\u00e8o'),
        e('span', null, selectedPick?.option?.label || 'Ch\u1ecdn field b\u00ean d\u01b0\u1edbi')
      ),
      e('div', { className: 'bet-preview-stats' },
        e('strong', null, oddsValue(selectedPick?.option?.odds)),
        e('span', null, betProjection(stake, selectedPick?.option?.odds))
      )
    ),
    e('div', { className: 'market-tabs', role: 'tablist' },
      filterTabs.map(f =>
        e('button', {
          key: f.key,
          type: 'button',
          className: `market-tab${marketFilter === f.key ? ' active' : ''}`,
          'aria-pressed': String(marketFilter === f.key),
          onClick: () => setMarketFilter(f.key)
        },
          e('span', null, f.label),
          e('small', null, formatNumber(f.count))
        )
      )
    ),
    e('div', { className: 'market-board' },
      visibleSections.map((section, idx) =>
        e(MarketSection, {
          key: section.key,
          section,
          open: idx === 0,
          selectedPick,
          onPickChange: handlePickChange
        })
      )
    ),
    e('div', { className: 'stake-row' },
      e('label', null,
        '\u0110i\u1ec3m c\u01b0\u1ee3c',
        e('input', {
          name: 'betPoints',
          type: 'number',
          min: 1,
          value: stake,
          onChange: ev => handleStakeChange(ev.target.value)
        })
      ),
      e('div', { className: 'stake-pills' },
        [25, 50, 100].map(a =>
          e('button', { key: a, type: 'button', className: 'chip', onClick: () => handleStakeChange(a) }, formatNumber(a))
        ),
        e('button', { type: 'button', className: 'chip', onClick: () => handleStakeChange(walletPoints || 1) }, 'All in')
      ),
      e('button', { className: 'primary-button', type: 'submit', disabled: !selectedPick }, '\u0110\u1eb7t k\u00e8o')
    ),
    e('div', { className: 'market-note' },
      'x1.76 ngh\u0129a l\u00e0 c\u01b0\u1ee3c 100, nh\u1eadn 176. +340 ho\u1eb7c 5/7 ch\u1ec9 l\u00e0 ki\u1ec3u ghi odds kh\u00e1c, app \u0111\u1ed5i h\u1ebft sang x \u0111\u1ec3 d\u1ec5 \u0111\u1ecdc.'
    )
  );
}

function MarketSection({ section, open, selectedPick, onPickChange }) {
  return e('details', { className: 'market-group', open },
    e('summary', null,
      e('div', null,
        e('b', null, section.label),
        e('span', null, `${formatNumber(section.markets.length)} k\u00e8o \u00b7 ${formatNumber(section.providers.length)} nh\u00e0 cung c\u1ea5p`)
      ),
      e('span', { className: 'group-arrow' }, '\u2304')
    ),
    e('div', { className: 'market-group-body' },
      section.markets.map(market =>
        e(MarketItem, { key: market.key, market, selectedPick, onPickChange })
      )
    )
  );
}

function MarketItem({ market, selectedPick, onPickChange }) {
  if (market.disabled) {
    return e('div', { className: 'market disabled' },
      e('div', { className: 'market-title' }, e('b', null, market.title), e('span', null, 'Ch\u01b0a m\u1edf')),
      e('p', null, market.description)
    );
  }
  return e('div', { className: 'market' },
    e('div', { className: 'market-title' }, e('b', null, market.title), e('span', null, market.description)),
    e('div', { className: 'market-options' },
      market.options.map(option =>
        e('label', { key: option.key, className: 'market-option' },
          e('input', {
            type: 'radio',
            name: 'pick',
            value: `${market.key}|${option.key}`,
            checked: selectedPick?.marketKey === market.key && selectedPick?.optionKey === option.key,
            onChange: () => onPickChange(market.key, option.key, market, option)
          }),
          e('span', null, option.label),
          e('b', null, oddsValue(option.odds))
        )
      )
    )
  );
}

// ─── Chat box ─────────────────────────────────────────────────────────────────
function ChatBox({ match }) {
  const [message, setMessage] = React.useState('');

  const handleSubmit = async ev => {
    ev.preventDefault();
    if (!message.trim()) return;
    await runTask(async () => {
      await api('/api/chat/send', { method: 'POST', body: { matchId: match.id, message } });
      setMessage('');
      await loadRouteData();
    }, 'Message sent');
  };

  return e(React.Fragment, null,
    e('div', { className: 'chat-list' },
      state.chat.length
        ? state.chat.map(msg =>
            e('div', { key: msg.id, className: 'chat-message' },
              e('span', { className: 'avatar' }, initials(msg.user?.username || 'User')),
              e('div', null,
                e('b', null, msg.user?.username || 'User'),
                e('p', null, msg.message)
              )
            )
          )
        : e('div', { className: 'empty' }, 'No messages yet.')
    ),
    state.me
      ? e('form', { className: 'chat-form', onSubmit: handleSubmit },
          e('input', {
            value: message,
            maxLength: 280,
            placeholder: 'Type message',
            required: true,
            onChange: ev => setMessage(ev.target.value)
          }),
          e('button', { className: 'secondary-button', type: 'submit' }, 'Send')
        )
      : e('div', { className: 'empty' }, 'Login to chat.')
  );
}

// ─── Profile page ─────────────────────────────────────────────────────────────
function ProfilePage() {
  if (!state.me) return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'panel' },
      e('div', { className: 'empty' }, 'Login to view profile. ', e('a', { href: '#/login' }, 'Login'))
    )
  );

  const rank = state.leaderboard.find(r => String(r.id) === String(state.me.id));

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'page-head' },
      e('div', null, e('p', { className: 'eyebrow' }, 'Profile'), e('h1', null, state.me.username)),
      e('span', { className: 'avatar xl' }, initials(state.me.username))
    ),
    e('section', { className: 'stats-grid' },
      e('div', { className: 'stat' }, e('span', null, 'Points'), e('b', null, formatNumber(state.me.points))),
      e('div', { className: 'stat' }, e('span', null, 'Rank'), e('b', null, rank ? `#${rank.rank}` : '-')),
      e('div', { className: 'stat' }, e('span', null, 'Bets'), e('b', null, formatNumber(state.predictions.length))),
      e('div', { className: 'stat' }, e('span', null, 'Transactions'), e('b', null, formatNumber(state.walletHistory.length)))
    ),
    e('section', { className: 'grid two' },
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Bet history')),
        e(PredictionsHistory, null)
      ),
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Wallet history')),
        e(WalletHistory, null)
      )
    )
  );
}

function PredictionsHistory() {
  if (!state.predictions.length) return e('div', { className: 'empty' }, 'No bets yet.');
  return e('div', { className: 'stack-list' },
    state.predictions.slice(0, 30).map((pred, i) => {
      const result = matchResultSummary(pred.match);
      return e('div', { key: i, className: `history-row pred-${pred.status}` },
        e('div', null,
          e('b', null, pred.match ? `${pred.match.homeTeam} vs ${pred.match.awayTeam}` : `Match #${pred.matchId}`),
          e('div', { className: 'history-meta' },
            e('span', { className: `score-result score-${result.tone}` }, result.score),
            e('span', { className: `match-state match-state-${result.tone}` }, result.state),
            e('span', null,
              `${pred.market?.title || 'K\u00e8o c\u0169'} | ${pred.market?.label || `${pred.predictedHomeScore}-${pred.predictedAwayScore}`} | ${oddsValue(pred.market?.odds)}`
            )
          )
        ),
        e('div', { className: 'pred-actions' },
          e('span', { className: `status-badge status-${pred.status}` }, pred.status.toUpperCase()),
          e('strong', { className: betStatusTone(pred.status) },
            `${formatNumber(pred.rewardPoints)} pts`
          )
        )
      );
    })
  );
}

function WalletHistory() {
  if (!state.walletHistory.length) return e('div', { className: 'empty' }, 'No transactions yet.');
  return e('div', { className: 'stack-list' },
    state.walletHistory.slice(0, 12).map((tx, i) => {
      const title = tx.type === 'admin_add' ? 'Admin cộng điểm' : 'Admin trừ điểm';
      return e('div', { key: i, className: 'history-row' },
        e('div', null, e('b', null, title), e('span', null, clampText(tx.note || 'Admin adjustment'))),
        e('strong', { className: Number(tx.amount) >= 0 ? 'good' : 'bad' },
          `${Number(tx.amount) >= 0 ? '+' : ''}${formatNumber(tx.amount)}`
        )
      );
    })
  );
}

// ─── Admin page ───────────────────────────────────────────────────────────────
function AdminPage() {
  if (!state.me) return e(React.Fragment, null, e(ToastBar, null), e('div', { className: 'empty page-empty' }, 'Login required.'));
  if (state.me.role !== 'admin') return e(React.Fragment, null, e(ToastBar, null), e('div', { className: 'empty page-empty' }, 'Admin only.'));
  if (!state.admin) return e(React.Fragment, null, e(ToastBar, null), e('div', { className: 'empty page-empty' }, 'Loading admin data.'));

  const handleSync = () => runTask(async () => {
    await api('/api/admin/sync', { method: 'POST', body: { mode: 'fixtures' } });
    await refreshPublicData();
    await loadAdminData();
  }, 'ESPN synced');

  const handleBan = (userId, action) => runTask(async () => {
    await api(`/api/admin/users/${userId}/${action}`, { method: 'PATCH', body: {} });
    await loadAdminData();
    await refreshPublicData();
  }, 'User updated');

  const handleResetUser = userId => runTask(async () => {
    await api(`/api/admin/users/${userId}/reset`, { method: 'POST', body: {} });
    await loadAdminData();
    await refreshPublicData();
  }, 'Wallet reset');

  const handleDeleteUser = (userId, username) => {
    if (!window.confirm(`Delete account "${username}"? This removes user, bets, wallet history, chat messages, and notifications.`)) return;
    runTask(async () => {
      await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      await loadAdminData();
      await refreshPublicData();
      if (state.me) await refreshPrivateData();
    }, 'User deleted');
  };

  const handleRoleChange = (userId, role) => runTask(async () => {
    await api(`/api/admin/users/${userId}/role`, { method: 'PATCH', body: { role } });
    await loadAdminData();
    await refreshPublicData();
  }, 'Role updated');

  const handleSettle = (predictionId, outcome) => runTask(async () => {
    await api(`/api/admin/predictions/${predictionId}/settle`, { method: 'POST', body: { outcome } });
    await loadAdminData();
    await refreshPrivateData();
  }, 'Prediction settled');

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'page-head' },
      e('div', null, e('p', { className: 'eyebrow' }, 'Control room'), e('h1', null, 'Admin dashboard')),
      e('button', { className: 'primary-button', onClick: handleSync }, 'Force ESPN sync')
    ),
    e(AdminPointsForm, null),
    e('section', { className: 'panel' },
      e('div', { className: 'section-head' }, e('h2', null, 'Users'), e('span', null, formatNumber(state.admin.users.length))),
      e('div', { className: 'table-wrap' },
        e('table', null,
          e('thead', null,
            e('tr', null,
              e('th', null, 'User'), e('th', null, 'Role'), e('th', null, 'Points'),
              e('th', null, 'Status'), e('th', null, 'Actions')
            )
          ),
          e('tbody', null,
            state.admin.users.map(user =>
              e('tr', { key: user.id },
                e('td', null, user.username),
                e('td', null,
                  e('select', {
                    className: 'role-select',
                    value: user.role,
                    disabled: String(user.id) === String(state.me.id),
                    onChange: ev => handleRoleChange(user.id, ev.target.value)
                  },
                    e('option', { value: 'user' }, 'user'),
                    e('option', { value: 'admin' }, 'admin')
                  )
                ),
                e('td', null, formatNumber(user.points)),
                e('td', null, user.banned ? 'Banned' : 'Active'),
                e('td', { className: 'actions' },
                  e('button', { className: 'ghost-button', onClick: () => handleBan(user.id, user.banned ? 'unban' : 'ban') },
                    user.banned ? 'Unban' : 'Ban'
                  ),
                  e('button', { className: 'ghost-button danger', onClick: () => handleResetUser(user.id) }, 'Reset'),
                  String(user.id) !== String(state.me.id)
                    ? e('button', { className: 'ghost-button danger', onClick: () => handleDeleteUser(user.id, user.username) }, 'Delete')
                    : null
                )
              )
            )
          )
        )
      )
    ),
    e('section', { className: 'panel' },
      e('div', { className: 'section-head' }, e('h2', null, 'Recent transactions')),
      state.admin.transactions.length
        ? e('div', { className: 'stack-list' },
            state.admin.transactions.slice(0, 20).map((tx, i) =>
              e('div', { key: i, className: 'history-row' },
                e('div', null, e('b', null, `User #${tx.userId} - ${tx.type}`), e('span', null, tx.note)),
                e('strong', { className: Number(tx.amount) >= 0 ? 'good' : 'bad' },
                  `${Number(tx.amount) >= 0 ? '+' : ''}${formatNumber(tx.amount)}`
                )
              )
            )
          )
        : e('div', { className: 'empty' }, 'No transactions.')
    ),
    e('section', { className: 'panel' },
      e('div', { className: 'section-head' }, e('h2', null, 'Pending bets'), e('span', null, formatNumber(state.admin.predictions.length))),
      state.admin.predictions.length
        ? e('div', { className: 'stack-list' },
            state.admin.predictions.map((pred, i) =>
              e('div', { key: i, className: 'history-row' },
                e('div', null,
                  e('b', null, `${pred.user?.username || `User #${pred.userId}`} - ${pred.market?.title || 'Bet'}`),
                  e('span', null,
                    `${pred.match ? `${pred.match.homeTeam} vs ${pred.match.awayTeam}` : `Match #${pred.matchId}`} | ${pred.market?.label || ''} | ${oddsValue(pred.market?.odds)} | ${pred.status}`
                  )
                ),
                e('strong', null, `${formatNumber(pred.rewardPoints)} pts`),
                e('div', { className: 'actions' },
                  e('button', { className: 'ghost-button', onClick: () => handleSettle(pred.id, 'won') }, 'Won'),
                  e('button', { className: 'ghost-button', onClick: () => handleSettle(pred.id, 'lost') }, 'Lost'),
                  e('button', { className: 'ghost-button', onClick: () => handleSettle(pred.id, 'push') }, 'Push')
                )
              )
            )
          )
        : e('div', { className: 'empty' }, 'No pending bets.')
    )
  );
}

function AdminPointsForm() {
  const users = state.admin?.users || [];
  const [userId, setUserId] = React.useState(() => String(users[0]?.id || ''));
  const [mode, setMode] = React.useState('add');
  const [amount, setAmount] = React.useState(100);
  const [note, setNote] = React.useState('');

  const handleSubmit = async ev => {
    ev.preventDefault();
    const finalAmount = Number(amount) * (mode === 'deduct' ? -1 : 1);
    await runTask(async () => {
      await api(`/api/admin/users/${userId}/points`, { method: 'POST', body: { amount: finalAmount, note } });
      setAmount(100);
      setNote('');
      await loadAdminData();
      await refreshPublicData();
    }, 'Points updated');
  };

  return e('section', { className: 'panel' },
    e('div', { className: 'section-head' }, e('h2', null, 'Point adjustment')),
    e('form', { className: 'form-grid', onSubmit: handleSubmit },
      e('label', null, 'User',
        e('select', { value: userId, onChange: ev => setUserId(ev.target.value), required: true },
          users.map(u => e('option', { key: u.id, value: String(u.id) }, `${u.username} (${formatNumber(u.points)} pts)`))
        )
      ),
      e('label', null, 'Mode',
        e('select', { value: mode, onChange: ev => setMode(ev.target.value) },
          e('option', { value: 'add' }, 'Add'),
          e('option', { value: 'deduct' }, 'Deduct')
        )
      ),
      e('label', null, 'Amount',
        e('input', { type: 'number', min: 1, value: amount, required: true, onChange: ev => setAmount(ev.target.value) })
      ),
      e('label', null, 'Note',
        e('input', { maxLength: 120, placeholder: 'Admin adjustment', value: note, onChange: ev => setNote(ev.target.value) })
      ),
      e('button', { className: 'secondary-button', type: 'submit' }, 'Update points')
    )
  );
}

// ─── Auth pages ───────────────────────────────────────────────────────────────
function LoginPage() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(true);

  const handleSubmit = async ev => {
    ev.preventDefault();
    await runTask(async () => {
      const data = await api('/api/auth/login', { method: 'POST', body: { email, password, remember } });
      setToken(data.token);
      state.me = data.user;
      state.betDrafts = {};
      await refreshPrivateData();
      await refreshPublicData();
      openStream();
      window.location.hash = '#/home';
    }, 'Logged in');
  };

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'auth-solo' },
      e('div', { className: 'panel auth-panel' },
        e('div', { className: 'section-head' }, e('h2', null, '\u0110\u0103ng nh\u1eadp')),
        e('form', { className: 'form-grid', onSubmit: handleSubmit },
          e('label', null, 'Email ho\u1eb7c t\u00ean \u0111\u0103ng nh\u1eadp',
            e('input', { type: 'text', autoComplete: 'username', required: true, value: email, onChange: ev => setEmail(ev.target.value) })
          ),
          e('label', null, 'M\u1eadt kh\u1ea9u',
            e('input', { type: 'password', required: true, value: password, onChange: ev => setPassword(ev.target.value) })
          ),
          e('label', { className: 'check' },
            e('input', { type: 'checkbox', checked: remember, onChange: ev => setRemember(ev.target.checked) }),
            ' Ghi nh\u1edb \u0111\u0103ng nh\u1eadp'
          ),
          e('button', { className: 'primary-button', type: 'submit' }, '\u0110\u0103ng nh\u1eadp')
        ),
        e('p', { className: 'auth-switch' },
          'Ch\u01b0a c\u00f3 t\u00e0i kho\u1ea3n? ',
          e('a', { href: '#/register' }, '\u0110\u0103ng k\u00fd ngay')
        )
      )
    )
  );
}

function RegisterPage() {
  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [avatar, setAvatar] = React.useState('');

  const handleSubmit = async ev => {
    ev.preventDefault();
    if (password !== confirmPassword) {
      setToast('M\u1eadt kh\u1ea9u nh\u1eadp l\u1ea1i kh\u00f4ng kh\u1edbp!', 'bad');
      notify();
      return;
    }
    await runTask(async () => {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: { username, email, password, avatar, remember: true }
      });
      setToken(data.token);
      state.me = data.user;
      state.betDrafts = {};
      await refreshPrivateData();
      await refreshPublicData();
      openStream();
      window.location.hash = '#/home';
    }, '\u0110\u0103ng k\u00fd th\u00e0nh c\u00f4ng!');
  };

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'auth-solo' },
      e('div', { className: 'panel auth-panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'T\u1ea1o t\u00e0i kho\u1ea3n')),
        e('form', { className: 'form-grid', onSubmit: handleSubmit },
          e('label', null, 'T\u00ean \u0111\u0103ng nh\u1eadp',
            e('input', { type: 'text', minLength: 2, autoComplete: 'username', required: true, value: username, onChange: ev => setUsername(ev.target.value) })
          ),
          e('label', null, 'Email',
            e('input', { type: 'email', autoComplete: 'email', required: true, value: email, onChange: ev => setEmail(ev.target.value) })
          ),
          e('label', null, 'M\u1eadt kh\u1ea9u',
            e('input', { type: 'password', minLength: 7, autoComplete: 'new-password', required: true, value: password, onChange: ev => setPassword(ev.target.value) })
          ),
          e('label', null, 'Nh\u1eadp l\u1ea1i m\u1eadt kh\u1ea9u',
            e('input', { type: 'password', minLength: 7, autoComplete: 'new-password', required: true, value: confirmPassword, onChange: ev => setConfirmPassword(ev.target.value) })
          ),
          e('label', null, 'Avatar URL (t\u00f9y ch\u1ecdn)',
            e('input', { type: 'url', value: avatar, onChange: ev => setAvatar(ev.target.value) })
          ),
          e('button', { className: 'primary-button', type: 'submit' }, 'T\u1ea1o t\u00e0i kho\u1ea3n')
        ),
        e('p', { className: 'auth-switch' },
          '\u0110\u00e3 c\u00f3 t\u00e0i kho\u1ea3n? ',
          e('a', { href: '#/login' }, '\u0110\u0103ng nh\u1eadp')
        )
      )
    )
  );
}

// ─── Notifications ────────────────────────────────────────────────────────────
function NotificationsSection() {
  return e('section', { className: 'panel' },
    e('div', { className: 'section-head' },
      e('h2', null, 'Notifications'),
      e('span', null, formatNumber(state.notifications.length))
    ),
    state.notifications.length
      ? e('div', { className: 'stack-list' },
          state.notifications.slice(0, 8).map((item, i) =>
            e('div', { key: i, className: 'history-row' },
              e('div', null, e('b', null, item.title), e('span', null, item.message))
            )
          )
        )
      : e('div', { className: 'empty' }, 'No notifications.')
  );
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  bindEvents();
  await loadSession();
  await refreshPublicData();
  await loadRouteData();
  openStream();
  root?.render(e(App, null));
  window.setInterval(refreshPublicDataQuiet, 30000);
}

boot().catch(err => {
  console.error(err);
  root?.render(e('div', { className: 'empty page-empty' }, 'App failed to start. Check console.'));
});
