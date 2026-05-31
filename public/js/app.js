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
  parlays: [],
  walletHistory: [],
  notifications: [],
  detail: null,
  chat: [],
  admin: null,
  betDrafts: {},
  betSlip: [],
  betSlipOpen: false,
  betSlipType: 'single', // 'single' or 'parlay'
  betSlipStakes: {},
  parlayStake: 100,
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
  const [meResp, p, w, n] = await Promise.all([
    api('/api/auth/me'),
    api('/api/predictions/me'),
    api('/api/wallet/history'),
    api('/api/notifications?limit=20')
  ]);
  if (meResp.user) {
    state.me = meResp.user;
  }
  state.predictions = p.predictions || [];
  state.parlays = p.parlays || [];
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
  if ((name === 'profile' || name === 'history') && state.me) await refreshPrivateData();
  if (name === 'admin' && state.me?.role === 'admin') await loadAdminData();
}

async function loadAdminData() {
  const [u, tx, cfg, m, p, gc] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/transactions'),
    api('/api/admin/config'),
    api('/api/admin/matches'),
    api('/api/admin/predictions?status=pending'),
    api('/api/admin/gift-codes')
  ]);
  state.admin = {
    users: u.users || [],
    transactions: tx.transactions || [],
    settings: cfg.settings || {},
    matches: m.matches || [],
    predictions: p.predictions || [],
    giftCodes: gc.giftCodes || []
  };
}

function openStream() {
  if (state.stream) { state.stream.close(); state.stream = null; }
  const token = getToken();
  if (!token) return;
  const stream = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  stream.addEventListener('matches.updated', ev => scheduleStreamRefresh(ev, ['public', 'matchRoute', 'admin']));
  stream.addEventListener('leaderboard.updated', ev => scheduleStreamRefresh(ev, ['public', 'private']));
  stream.addEventListener('wallet.updated', ev => scheduleStreamRefresh(ev, ['private']));
  stream.addEventListener('chat.message', ev => scheduleStreamRefresh(ev, ['matchRoute']));
  stream.addEventListener('chat.deleted', ev => scheduleStreamRefresh(ev, ['matchRoute']));
  stream.onerror = () => { };
  state.stream = stream;
}

const pendingStreamRefresh = new Set();
let streamRefreshTimer = null;

function scheduleStreamRefresh(_event, domains) {
  for (const domain of domains) pendingStreamRefresh.add(domain);
  window.clearTimeout(streamRefreshTimer);
  streamRefreshTimer = window.setTimeout(refreshFromStream, 150);
}

async function refreshFromStream() {
  const domains = new Set(pendingStreamRefresh);
  pendingStreamRefresh.clear();
  const page = routeName();
  try {
    if (domains.has('public')) await refreshPublicData();
    if (state.me && domains.has('private')) await refreshPrivateData();
    if (domains.has('matchRoute') && page === 'match') await loadRouteData();
    if (domains.has('admin') && page === 'admin' && state.me?.role === 'admin') await loadAdminData();
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
    setToast(err instanceof Error ? err.message : 'Action failed', 'bad');
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
    ...(state.me ? [['profile', 'Profile', '#/profile'], ['history', 'History', '#/history']] : []),
    ...(state.me?.role === 'admin' ? [['admin', 'Admin', '#/admin']] : [])
  ];

  return e('header', { className: 'topbar' },
    e('div', { className: 'topbar-inner' },
      e('a', { className: 'brand', href: '#/home', 'aria-label': 'Worldcup Pick home' },
        e('img', {
          src: 'https://media.baoquangninh.vn/upload/image/202604/medium/2497053_a4be41af2811a7673ae166f6edf32016.jpg',
          className: 'brand-mark',
          style: { width: '42px', height: '42px', objectFit: 'cover', borderRadius: '8px' }
        }),
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
    history: HistoryPage,
    match: MatchPage,
    admin: AdminPage
  };
  const PageComp = pageMap[page] || HomePage;

  return e('div', { className: 'shell' },
    e(TopBar, null),
    e('main', { className: 'app', 'aria-live': 'polite' },
      e(PageComp, null)
    ),
    e(BetSlipUI, null)
  );
}

// ─── Home page ────────────────────────────────────────────────────────────────
function HomePage() {
  const [expandedLeagueKey, setExpandedLeagueKey] = React.useState('');
  const isFocusedLeague = state.filters.league !== 'all';
  const { live, upcomingAll, hotAll, upcomingByLeague, hotByLeague } = React.useMemo(() => {
    const live = state.matches.filter(isMatchLive).slice(0, 4);
    const upcomingAll = state.matches
      .filter(isUpcomingMatch)
      .sort((a, b) => new Date(a.kickoffTime || 0) - new Date(b.kickoffTime || 0));
    const hotAll = [...state.matches]
      .sort((a, b) => Number(b.hotScore || 0) - Number(a.hotScore || 0));
    return {
      live,
      upcomingAll,
      hotAll,
      upcomingByLeague: groupMatchesByLeague(upcomingAll, 8),
      hotByLeague: groupMatchesByLeague(hotAll, 8)
    };
  }, [state.matches]);

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

function UserAvatar({ user, avatar, size = '' }) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const className = size ? ` ${size}` : '';
  const avatarUrl = String((avatar ?? user?.avatar) || '').trim();

  React.useEffect(() => {
    setImgFailed(false);
  }, [avatarUrl]);

  if (avatarUrl && !imgFailed) {
    return e('img', {
      className: `avatar-image${className}`,
      src: avatarUrl,
      alt: `${user?.username || 'User'} avatar`,
      onError: () => setImgFailed(true)
    });
  }
  return e('span', { className: `avatar${className}` }, initials(user?.username || 'User'));
}

function leaderboardAvatar(row) {
  if (row?.avatar) return row.avatar;
  if (state.me && String(state.me.id) === String(row?.id)) return String(state.me.avatar || '');
  return '';
}

function LeaderboardMini() {
  if (!state.leaderboard.length) return e('div', { className: 'empty' }, 'No players yet.');
  return e('div', { className: 'rank-list' },
    state.leaderboard.slice(0, 6).map(row =>
      e('div', { key: row.id, className: 'rank-row' },
        e('b', null, `#${row.rank}`),
        e(UserAvatar, { user: { username: row.username }, avatar: leaderboardAvatar(row) }),
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
                    e(UserAvatar, { user: { username: row.username }, avatar: leaderboardAvatar(row) }),
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
      : e(MarketBoard, { match, key: match.id })
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

// ─── Market Board (Replaces old BetForm) ──────────────────────────────────────
function MarketBoard({ match }) {
  const markets = Array.isArray(match.markets) ? match.markets : [];
  const [marketFilter, setMarketFilter] = React.useState('all');

  const sections = React.useMemo(() => buildMarketSections(markets), [markets]);
  const visibleSections = React.useMemo(
    () => marketFilter === 'all' ? sections : sections.filter(s => s.key === marketFilter),
    [marketFilter, sections]
  );

  const filterTabs = React.useMemo(() => [
    { key: 'all', label: 'T\u1ea5t c\u1ea3', count: sections.reduce((t, s) => t + s.markets.length, 0) },
    ...sections.map(s => ({ key: s.key, label: s.label, count: s.markets.length }))
  ], [sections]);

  if (!markets.length) {
    return e('div', { className: 'empty' }, 'Ch\u01b0a c\u00f3 odds t\u1eeb ESPN cho tr\u1eadn n\u00e0y.');
  }

  const handlePickChange = (marketKey, optionKey, market, option) => {
    // Remove if already selected
    const existingIdx = state.betSlip.findIndex(p => p.matchId === match.id && p.marketKey === marketKey && p.optionKey === optionKey);
    if (existingIdx >= 0) {
      state.betSlip.splice(existingIdx, 1);
    } else {
      // Find if there is already a pick for this match with the SAME marketType
      const existingTypeIdx = state.betSlip.findIndex(p => p.matchId === match.id && p.market.marketType === market.marketType);
      if (existingTypeIdx >= 0) {
        // Replace it (e.g., switching from 1X2 DraftKings to 1X2 Bet365)
        state.betSlip.splice(existingTypeIdx, 1);
      }

      state.betSlip.push({
        matchId: match.id,
        matchHome: match.homeTeam,
        matchAway: match.awayTeam,
        marketKey,
        optionKey,
        market,
        option
      });
      state.betSlipOpen = true; // Auto open bet slip
    }
    notify();
  };

  return e('div', { className: 'market-board-container' },
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
          matchId: match.id,
          onPickChange: handlePickChange
        })
      )
    )
  );
}

function MarketSection({ section, open, matchId, onPickChange }) {
  return e('details', { className: 'market-group', open },
    e('summary', { className: 'market-group-header' },
      e('div', null,
        e('b', null, section.label),
        e('span', null, `${formatNumber(section.markets.length)} k\u00e8o`)
      )
    ),
    e('div', { className: 'market-group-body' },
      section.markets.map(market =>
        e(MarketItem, { key: market.key, matchId, market, onPickChange })
      )
    )
  );
}

function MarketItem({ matchId, market, onPickChange }) {
  if (market.disabled) return null;
  return e('div', { className: 'market-item' },
    e('div', { className: 'market-item-header' },
      e('b', null, market.title),
      e('span', null, market.provider || 'ESPN')
    ),
    e('div', { className: 'market-options' },
      market.options.map(option => {
        const isSelected = state.betSlip.some(p => p.matchId === matchId && p.marketKey === market.key && p.optionKey === option.key);
        return e('button', {
          key: option.key,
          type: 'button',
          className: `market-option${isSelected ? ' selected' : ''}`,
          onClick: () => onPickChange(market.key, option.key, market, option)
        },
          e('b', null, option.label),
          e('strong', null, oddsValue(option.odds))
        );
      })
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
        ? state.chat.map(msg => {
          const timeStr = msg.createdAt ? new Date(msg.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
          return e('div', { key: msg.id, className: 'chat-message' },
            e(UserAvatar, { user: { username: msg.user?.username || 'User' }, avatar: msg.user?.avatar || '' }),
            e('div', { style: { width: '100%' } },
              e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
                e('b', null, msg.user?.username || 'User'),
                e('span', { style: { fontSize: '12px', color: 'var(--muted)' } }, timeStr)
              ),
              e('p', { style: { margin: 0 } }, msg.message)
            )
          );
        })
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

// ─── Bet Slip UI ──────────────────────────────────────────────────────────────
function BetSlipUI() {
  React.useEffect(() => {
    if (state.betSlip.length === 0 && state.betSlipOpen) {
      state.betSlipOpen = false;
      notify();
      return;
    }
    if (state.betSlip.length <= 1 && state.betSlipType === 'parlay') {
      state.betSlipType = 'single';
      notify();
    }
  }, [state.betSlip.length, state.betSlipOpen, state.betSlipType]);

  const betSlipOddsKey = state.betSlip.map(p => `${p.matchId}:${p.marketKey}:${p.optionKey}:${p.option?.odds}`).join('|');
  const combinedOdds = React.useMemo(() => {
    const picksByMatch = {};
    state.betSlip.forEach(p => {
      if (!picksByMatch[p.matchId]) picksByMatch[p.matchId] = [];
      picksByMatch[p.matchId].push(p);
    });

    const getSgpMultiplier = (n) => {
      if (n <= 1) return 1.0;
      if (n === 2) return 0.92;
      if (n === 3) return 0.76;
      if (n === 4) return 0.52;
      if (n === 5) return 0.34;
      if (n === 6) return 0.22;
      return Math.pow(0.66, n - 1);
    };

    return Object.values(picksByMatch).reduce((total, group) => {
      const groupOdds = group.reduce((odds, p) => odds * Number(p.option.odds || 1), 1) * getSgpMultiplier(group.length);
      return total * groupOdds;
    }, 1.0);
  }, [betSlipOddsKey]);

  if (state.betSlip.length === 0) return null;

  const walletPoints = Math.max(0, Number(state.me?.walletBalance || state.me?.points || 0));

  const toggleOpen = () => { state.betSlipOpen = !state.betSlipOpen; notify(); };
  const removePick = (idx) => { state.betSlip.splice(idx, 1); notify(); };

  const canParlay = state.betSlip.length > 1;

  const setType = (t) => { state.betSlipType = t; notify(); };

  const handlePlaceBet = async () => {
    if (!state.me) return setToast('Vui lòng đăng nhập', 'bad');

    if (state.betSlipType === 'parlay') {
      const stake = Number(state.parlayStake !== undefined ? state.parlayStake : 100);
      if (!Number.isFinite(stake) || stake < 1) return setToast('Giá trị không hợp lệ', 'bad');
      if (stake > walletPoints) return setToast('Không đủ điểm', 'bad');

      await runTask(async () => {
        await api('/api/parlays', {
          method: 'POST',
          body: {
            betPoints: stake,
            picks: state.betSlip.map(p => ({ matchId: p.matchId, marketKey: p.marketKey, optionKey: p.optionKey }))
          }
        });
        state.betSlip = [];
        state.betSlipOpen = false;
        await refreshPrivateData();
        await refreshPublicData();
        if (routeName() === 'match') await loadRouteData();
      }, 'Đặt Cược Xiên thành công!');
    } else {
      // Single bets
      await runTask(async () => {
        // Validate stakes
        for (const p of state.betSlip) {
          const pickKey = `${p.matchId}_${p.marketKey}_${p.optionKey}`;
          const rawStake = state.betSlipStakes[pickKey];
          const stake = Number(rawStake !== undefined ? rawStake : 100);
          if (!Number.isFinite(stake) || stake < 1) {
            throw new Error('Giá trị không hợp lệ');
          }
          if (stake > walletPoints) {
            throw new Error('Không đủ điểm');
          }
        }
        
        for (const p of state.betSlip) {
          const pickKey = `${p.matchId}_${p.marketKey}_${p.optionKey}`;
          const rawStake = state.betSlipStakes[pickKey];
          const stake = Number(rawStake !== undefined ? rawStake : 100);
          await api('/api/predictions', {
            method: 'POST',
            body: {
              matchId: p.matchId,
              marketKey: p.marketKey,
              optionKey: p.optionKey,
              betPoints: stake
            }
          });
        }
        state.betSlip = [];
        state.betSlipOpen = false;
        await refreshPrivateData();
        await refreshPublicData();
        if (routeName() === 'match') await loadRouteData();
      }, 'Đặt Cược Đơn thành công!');
    }
  };

  const handleStakeChange = (pickKey, val) => {
    state.betSlipStakes[pickKey] = val;
    notify();
  };

  const handleStakeAllIn = (pickKey) => {
    state.betSlipStakes[pickKey] = walletPoints;
    notify();
  };

  const handleParlayStakeChange = (val) => {
    state.parlayStake = val;
    notify();
  };

  const handleParlayAllIn = () => {
    state.parlayStake = walletPoints;
    notify();
  };

  return e(React.Fragment, null,
    e('button', { className: 'bet-slip-toggle', onClick: toggleOpen },
      '🛒',
      e('span', { className: 'bet-slip-badge' }, state.betSlip.length)
    ),
    e('div', { className: `bet-slip-drawer ${state.betSlipOpen ? 'open' : ''}` },
      e('div', { className: 'bet-slip-header' },
        e('h3', null, '🛒 Giỏ hàng cược', e('span', { className: 'chip' }, `${formatNumber(walletPoints)} pts`)),
        e('button', { className: 'bet-slip-close', onClick: toggleOpen }, '×')
      ),
      canParlay ? e('div', { className: 'bet-slip-tabs', style: { margin: '16px 16px 0' } },
        e('button', { className: `bet-slip-tab ${state.betSlipType === 'single' ? 'active' : ''}`, onClick: () => setType('single') }, 'Cược Đơn'),
        e('button', { className: `bet-slip-tab ${state.betSlipType === 'parlay' ? 'active' : ''}`, onClick: () => setType('parlay') }, 'Cược Xiên')
      ) : null,
      e('div', { className: 'bet-slip-body' },
        state.betSlip.map((p, idx) => {
          const pickKey = `${p.matchId}_${p.marketKey}_${p.optionKey}`;
          const rawStake = state.betSlipStakes[pickKey] !== undefined ? state.betSlipStakes[pickKey] : 100;
          const stakeNum = Number(rawStake);
          const returnAmt = Math.round(stakeNum * Number(p.option.odds || 1));
          return e('div', { key: pickKey, className: 'bet-slip-item' },
            e('button', { className: 'bet-slip-item-remove', onClick: () => removePick(idx) }, '×'),
            e('div', { className: 'bet-slip-match' }, `${p.matchHome} vs ${p.matchAway}`),
            e('div', { className: 'bet-slip-market' }, p.market.title),
            e('div', null,
              e('span', null, p.option.label),
              ' @ ',
              e('span', { className: 'bet-slip-odds' }, oddsValue(p.option.odds))
            ),
            state.betSlipType === 'single' ? e('div', { className: 'bet-slip-input', style: { marginTop: '8px' } },
              e('input', { type: 'number', min: 1, placeholder: 'Nhập điểm...', value: rawStake, onChange: ev => handleStakeChange(pickKey, ev.target.value) }),
              e('button', { className: 'bet-slip-all-in', type: 'button', onClick: () => handleStakeAllIn(pickKey) }, 'All in'),
              e('div', { className: 'bet-slip-payout' },
                'Trả về: ', e('strong', null, formatNumber(returnAmt))
              )
            ) : null
          );
        })
      ),
      e('div', { className: 'bet-slip-footer' },
        state.betSlipType === 'parlay' ? e(React.Fragment, null,
          e('div', { className: 'bet-slip-summary' },
            e('span', null, 'Tỷ lệ xiên tổng:'),
            e('span', { className: 'bet-slip-total-odds' }, oddsValue(combinedOdds))
          ),
          e('div', { className: 'bet-slip-note' }, 'Tỷ lệ xiên đã được nâng nhẹ'),
          e('div', { className: 'bet-slip-input' },
            e('input', { type: 'number', min: 1, placeholder: 'Nhập điểm...', value: state.parlayStake !== undefined ? state.parlayStake : 100, onChange: ev => handleParlayStakeChange(ev.target.value) }),
            e('button', { className: 'bet-slip-all-in', type: 'button', onClick: handleParlayAllIn }, 'All in'),
            e('div', { className: 'bet-slip-payout' },
              'Trả về: ', e('strong', null, formatNumber(Math.round(Number(state.parlayStake !== undefined ? state.parlayStake : 100) * combinedOdds)))
            )
          )
        ) : null,
        e('button', { className: 'primary-button', onClick: handlePlaceBet, style: { width: '100%' } }, 'Xác nhận đặt cược')
      )
    )
  );
}

// ─── Profile page ─────────────────────────────────────────────────────────────
function ProfilePage() {
  const [avatar, setAvatar] = React.useState(state.me?.avatar || '');
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  React.useEffect(() => {
    setAvatar(state.me?.avatar || '');
  }, [state.me?.id, state.me?.avatar]);

  if (!state.me) return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'panel' },
      e('div', { className: 'empty' }, 'Login to view profile. ', e('a', { href: '#/login' }, 'Login'))
    )
  );

  const rank = state.leaderboard.find(r => String(r.id) === String(state.me.id));
  const avatarPreview = String(avatar || '').trim() || String(state.me.avatar || '').trim();

  const handleProfileSubmit = async ev => {
    ev.preventDefault();
    await runTask(async () => {
      const data = await api('/api/profile', {
        method: 'PATCH',
        body: { avatar }
      });
      state.me = data.user;
      await refreshPublicData();
      await loadRouteData();
    }, 'Profile updated');
  };

  const handlePasswordSubmit = async ev => {
    ev.preventDefault();
    if (newPassword !== confirmPassword) {
      setToast('Confirm password does not match.', 'bad');
      notify();
      return;
    }
    await runTask(async () => {
      const data = await api('/api/profile/password', {
        method: 'POST',
        body: { currentPassword, newPassword }
      });
      state.me = data.user;
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    }, 'Password updated');
  };

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'page-head' },
      e('div', null, e('p', { className: 'eyebrow' }, 'Profile'), e('h1', null, state.me.username)),
      e(UserAvatar, { user: state.me, avatar: state.me.avatar, size: 'xl' })
    ),
    e('section', { className: 'stats-grid' },
      e('div', { className: 'stat' }, e('span', null, 'Points'), e('b', null, formatNumber(state.me.points))),
      e('div', { className: 'stat' }, e('span', null, 'Rank'), e('b', null, rank ? `#${rank.rank}` : '-')),
      e('div', { className: 'stat' }, e('span', null, 'Bets'), e('b', null, formatNumber(state.predictions.length + state.parlays.length))),
      e('div', { className: 'stat' }, e('span', null, 'Transactions'), e('b', null, formatNumber(state.walletHistory.length)))
    ),
    e('section', { className: 'grid two' },
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Profile settings')),
        e('form', { className: 'form-grid', onSubmit: handleProfileSubmit },
          e('label', { className: 'full' }, 'Avatar URL',
            e('input', {
              type: 'url',
              placeholder: 'https://example.com/avatar.jpg',
              value: avatar,
              onChange: ev => setAvatar(ev.target.value)
            })
          ),
          e('div', { className: 'avatar-preview full' },
            e(UserAvatar, {
              user: {
                username: state.me.username
              },
              avatar: avatarPreview
            }),
            e('span', null, avatarPreview ? 'Preview from avatar URL' : 'No avatar URL. Initials will be shown.')
          ),
          e('button', { className: 'primary-button full', type: 'submit' }, 'Save profile')
        )
      ),
      e('div', { className: 'panel' },
        e('div', { className: 'section-head' }, e('h2', null, 'Change password')),
        e('form', { className: 'form-grid', onSubmit: handlePasswordSubmit },
          e('label', { className: 'full' }, 'Current password',
            e('input', {
              type: 'password',
              autoComplete: 'current-password',
              required: true,
              value: currentPassword,
              onChange: ev => setCurrentPassword(ev.target.value)
            })
          ),
          e('label', null, 'New password',
            e('input', {
              type: 'password',
              minLength: 7,
              autoComplete: 'new-password',
              required: true,
              value: newPassword,
              onChange: ev => setNewPassword(ev.target.value)
            })
          ),
          e('label', null, 'Confirm new password',
            e('input', {
              type: 'password',
              minLength: 7,
              autoComplete: 'new-password',
              required: true,
              value: confirmPassword,
              onChange: ev => setConfirmPassword(ev.target.value)
            })
          ),
          e('button', { className: 'secondary-button full', type: 'submit' }, 'Update password')
        )
      )
    ),
    e('section', { className: 'panel' },
      e('div', { className: 'section-head' }, e('h2', null, 'Wallet history')),
      e(GiftCodeRedeemForm, null),
      e(WalletHistory, null)
    )
  );
}

function HistoryPage() {
  const [historyTab, setHistoryTab] = React.useState('single');

  if (!state.me) return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'panel' },
      e('div', { className: 'empty' }, 'Login to view betting history. ', e('a', { href: '#/login' }, 'Login'))
    )
  );

  return e(React.Fragment, null,
    e(ToastBar, null),
    e('section', { className: 'page-head' },
      e('div', null,
        e('p', { className: 'eyebrow' }, 'History'),
        e('h1', null, 'Lịch sử cược')
      ),
      e('span', { className: 'chip' }, `${formatNumber(state.predictions.length + state.parlays.length)} bets`)
    ),
    e('section', { className: 'panel' },
      e('div', { className: 'section-head' }, e('h2', null, 'Lịch sử cược')),
      e('div', { className: 'profile-tabs' },
        e('button', { className: `profile-tab ${historyTab === 'single' ? 'active' : ''}`, onClick: () => setHistoryTab('single') }, 'Cược Đơn'),
        e('button', { className: `profile-tab ${historyTab === 'parlay' ? 'active' : ''}`, onClick: () => setHistoryTab('parlay') }, 'Cược Xiên')
      ),
      historyTab === 'single' ? e(PredictionsHistory, null) : e(ParlaysHistory, null)
    )
  );
}

function betHistoryResultText(status, stake, reward) {
  if (status === 'won') return `Thắng +${formatNumber(Math.max(0, Number(reward || 0) - Number(stake || 0)))} pts`;
  if (status === 'lost') return `Thua -${formatNumber(stake)} pts`;
  if (status === 'refunded') return 'Hoàn cược';
  return 'Đang chờ kết quả';
}

function PredictionsHistory() {
  if (!state.predictions.length) return e('div', { className: 'empty' }, 'No bets yet.');
  return e('div', { className: 'stack-list' },
    state.predictions.slice(0, 30).map((pred, i) => {
      const result = matchResultSummary(pred.match);
      const stake = Number(pred.betPoints || 0);
      const reward = Number(pred.rewardPoints || 0);
      return e('div', { key: i, className: `history-row pred-${pred.status}` },
        e('div', null,
          e('b', null, pred.match ? `${pred.match.homeTeam} vs ${pred.match.awayTeam}` : `Match #${pred.matchId}`),
          e('div', { className: 'history-meta', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } },
            e('span', { className: `score-pill ${result.tone === 'live' ? 'score-live' : ''}` }, result.score),
            e('span', { style: { fontSize: '13px', color: 'var(--muted)' } },
              `${pred.market?.title || 'Kèo cũ'} | ${pred.market?.label || `${pred.predictedHomeScore}-${pred.predictedAwayScore}`} | ${oddsValue(pred.market?.odds)}`
            )
          )
        ),
        e('div', { className: 'pred-actions', style: { textAlign: 'right' } },
          e('div', { className: `outcome-badge outcome-${pred.status}` }, pred.status),
          e('div', { style: { marginTop: '4px', fontWeight: 'bold', fontSize: '15px' } },
            `${formatNumber(stake)} pts`
          ),
          e('div', { style: { marginTop: '2px', fontSize: '12px' }, className: betStatusTone(pred.status) },
            betHistoryResultText(pred.status, stake, reward)
          )
        )
      );
    })
  );
}

function ParlaysHistory() {
  if (!state.parlays.length) return e('div', { className: 'empty' }, 'Chưa có vé cược xiên nào.');
  return e('div', { className: 'stack-list' },
    state.parlays.slice(0, 30).map((parlay, i) => {
      const stake = Number(parlay.betPoints || 0);
      const reward = Number(parlay.rewardPoints || 0);
      return e('div', { key: i, className: `parlay-card` },
        e('div', { className: 'parlay-header' },
          e('div', null,
            e('b', null, `Cược Xiên (${parlay.selections.length} trận)`),
            e('div', { style: { fontSize: '13px', color: 'var(--muted)', marginTop: '2px' } }, `Tổng tỷ lệ: ${oddsValue(parlay.combinedOdds)}`)
          ),
          e('div', { className: 'pred-actions', style: { textAlign: 'right' } },
            e('div', { className: `outcome-badge outcome-${parlay.status}` }, parlay.status),
            e('div', { style: { marginTop: '4px', fontWeight: 'bold', fontSize: '15px' } },
              `${formatNumber(stake)} pts`
            ),
            e('div', { style: { marginTop: '2px', fontSize: '12px' }, className: betStatusTone(parlay.status) },
              betHistoryResultText(parlay.status, stake, reward)
            )
          )
        ),
        e('div', { className: 'parlay-legs' },
          parlay.selections.map((leg, j) => {
            const match = leg.match;
            const result = match ? matchResultSummary(match) : { score: '', state: '' };
            return e('div', { key: j, className: `parlay-leg ${leg.status}` },
              e('div', null,
                e('div', { style: { fontSize: '12px', color: 'var(--muted)' } }, match ? `${match.homeTeam} vs ${match.awayTeam}` : `Match #${leg.matchId}`),
                e('div', { style: { fontSize: '14px', fontWeight: 'bold' } }, leg.market?.title)
              ),
              e('div', { style: { textAlign: 'right' } },
                e('div', { style: { color: 'var(--text)' } }, `${leg.option?.label} @ ${oddsValue(leg.option?.odds)}`),
                e('div', { style: { fontSize: '12px', color: 'var(--muted)', marginTop: '2px' } }, leg.status.toUpperCase())
              )
            );
          })
        )
      );
    })
  );
}

function GiftCodeRedeemForm() {
  const [code, setCode] = React.useState('');

  const handleSubmit = async ev => {
    ev.preventDefault();
    const giftCode = code.trim();
    if (!giftCode) {
      setToast('Nhập gift code trước đã.', 'bad');
      notify();
      return;
    }
    await runTask(async () => {
      const data = await api('/api/gift-codes/redeem', { method: 'POST', body: { code: giftCode } });
      if (data.user) state.me = data.user;
      setCode('');
      await refreshPrivateData();
      await refreshPublicData();
    }, 'Đã nhận gift code');
  };

  return e('form', { className: 'gift-code-form', onSubmit: handleSubmit },
    e('label', null, 'Gift code',
      e('input', {
        type: 'text',
        placeholder: 'VD: WORLD2026',
        value: code,
        maxLength: 32,
        onChange: ev => setCode(ev.target.value.toUpperCase())
      })
    ),
    e('button', { className: 'primary-button', type: 'submit' }, 'Nhận điểm')
  );
}

function WalletHistory() {
  if (!state.walletHistory.length) return e('div', { className: 'empty' }, 'No transactions yet.');
  return e('div', { className: 'stack-list' },
    state.walletHistory.slice(0, 12).map((tx, i) => {
      const titleMap = {
        admin_add: 'Admin cộng điểm',
        admin_deduct: 'Admin trừ điểm',
        gift_code: 'Gift code'
      };
      const title = titleMap[tx.type] || tx.type || 'Giao dịch';
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
    e(AdminGiftCodesPanel, null),
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

function AdminGiftCodesPanel() {
  const giftCodes = state.admin?.giftCodes || [];
  const [code, setCode] = React.useState('');
  const [amount, setAmount] = React.useState(100);
  const [description, setDescription] = React.useState('');
  const [maxUses, setMaxUses] = React.useState('');
  const [perUserLimit, setPerUserLimit] = React.useState(1);
  const [expiresAt, setExpiresAt] = React.useState('');
  const [active, setActive] = React.useState(true);

  const handleSubmit = async ev => {
    ev.preventDefault();
    await runTask(async () => {
      await api('/api/admin/gift-codes', {
        method: 'POST',
        body: { code, amount: Number(amount), description, maxUses, perUserLimit: Number(perUserLimit), expiresAt, active }
      });
      setCode('');
      setAmount(100);
      setDescription('');
      setMaxUses('');
      setPerUserLimit(1);
      setExpiresAt('');
      setActive(true);
      await loadAdminData();
    }, 'Gift code created');
  };

  const toggleActive = giftCode => runTask(async () => {
    await api(`/api/admin/gift-codes/${giftCode.id}`, {
      method: 'PATCH',
      body: { active: !giftCode.active }
    });
    await loadAdminData();
  }, giftCode.active ? 'Gift code disabled' : 'Gift code enabled');

  return e('section', { className: 'panel' },
    e('div', { className: 'section-head' }, e('h2', null, 'Gift codes'), e('span', null, formatNumber(giftCodes.length))),
    e('form', { className: 'form-grid gift-code-admin-form', onSubmit: handleSubmit },
      e('label', null, 'Code',
        e('input', { required: true, maxLength: 32, placeholder: 'WORLD2026', value: code, onChange: ev => setCode(ev.target.value.toUpperCase()) })
      ),
      e('label', null, 'Amount',
        e('input', { type: 'number', min: 1, required: true, value: amount, onChange: ev => setAmount(ev.target.value) })
      ),
      e('label', null, 'Max uses',
        e('input', { type: 'number', min: 1, placeholder: 'Unlimited', value: maxUses, onChange: ev => setMaxUses(ev.target.value) })
      ),
      e('label', null, 'Per user',
        e('input', { type: 'number', min: 1, required: true, value: perUserLimit, onChange: ev => setPerUserLimit(ev.target.value) })
      ),
      e('label', null, 'Expires',
        e('input', { type: 'date', value: expiresAt, onChange: ev => setExpiresAt(ev.target.value) })
      ),
      e('label', { className: 'check' },
        e('input', { type: 'checkbox', checked: active, onChange: ev => setActive(ev.target.checked) }),
        ' Active'
      ),
      e('label', { className: 'full' }, 'Description',
        e('input', { maxLength: 160, placeholder: 'Campaign note', value: description, onChange: ev => setDescription(ev.target.value) })
      ),
      e('button', { className: 'secondary-button full', type: 'submit' }, 'Create gift code')
    ),
    giftCodes.length
      ? e('div', { className: 'table-wrap gift-code-table' },
        e('table', null,
          e('thead', null,
            e('tr', null,
              e('th', null, 'Code'), e('th', null, 'Amount'), e('th', null, 'Uses'),
              e('th', null, 'Expires'), e('th', null, 'Status'), e('th', null, 'Actions')
            )
          ),
          e('tbody', null,
            giftCodes.map(giftCode => e('tr', { key: giftCode.id },
              e('td', null, e('b', null, giftCode.code), giftCode.description ? e('span', null, giftCode.description) : null),
              e('td', null, formatNumber(giftCode.amount)),
              e('td', null, `${formatNumber(giftCode.uses || 0)} / ${giftCode.maxUses ? formatNumber(giftCode.maxUses) : '∞'}`),
              e('td', null, giftCode.expiresAt ? formatDateTime(giftCode.expiresAt) : 'Never'),
              e('td', null, giftCode.expired ? 'Expired' : (giftCode.active ? 'Active' : 'Inactive')),
              e('td', { className: 'actions' },
                e('button', { className: `ghost-button${giftCode.active ? ' danger' : ''}`, onClick: () => toggleActive(giftCode) }, giftCode.active ? 'Disable' : 'Enable')
              )
            ))
          )
        )
      )
      : e('div', { className: 'empty' }, 'No gift codes yet.')
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
        e('div', { className: 'welcome-bonus-card zero-balance-card' },
          e('span', null, 'T\u00e0i kho\u1ea3n m\u1edbi'),
          e('strong', null, '0 \u0111i\u1ec3m'),
          e('small', null, '\u0110i\u1ec3m s\u1ebd ch\u1ec9 thay \u0111\u1ed5i khi tham gia d\u1ef1 \u0111o\u00e1n ho\u1eb7c \u0111\u01b0\u1ee3c admin c\u1ed9ng.')
        ),
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
          e('button', { className: 'primary-button auth-btn', type: 'submit' }, 'T\u1ea1o t\u00e0i kho\u1ea3n')
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
