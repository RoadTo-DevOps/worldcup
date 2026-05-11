const { leagueCatalog } = require('./config');

function dateKeyFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function addDays(date, offset) {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

function leagueLabel(league) {
  const found = leagueCatalog.find((item) => item.league === league);
  return found ? found.label : league;
}

function buildScoreboardUrl(sport, league, dateKey) {
  return `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateKey}`;
}

function buildOddsUrl(sport, league, eventId, competitionId) {
  return `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}/events/${eventId}/competitions/${competitionId}/odds?lang=en&region=us`;
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/plain,*/*'
      }
    });
    if (!response.ok) {
      throw new Error(`ESPN ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function displayTeam(team, fallback) {
  if (!team) return fallback;
  return team.displayName || team.shortDisplayName || team.abbreviation || fallback;
}

function mapEventToMatch(event, leagueItem, dateKey) {
  const competition = event.competitions && event.competitions[0] ? event.competitions[0] : {};
  const competitors = competition.competitors || [];
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find((item) => item.homeAway === 'away') || competitors[1] || {};
  const statusType = competition.status?.type || event.status?.type || {};
  const homeScore = Number(home.score || 0);
  const awayScore = Number(away.score || 0);
  const startTime = competition.date || event.date || `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}T12:00:00.000Z`;
  const state = statusType.state || 'pre';
  const isLive = state === 'in';
  const isFinal = state === 'post';

  return {
    espnMatchId: String(event.id || competition.id || `${leagueItem.league}-${dateKey}-${displayTeam(home.team, 'home')}-${displayTeam(away.team, 'away')}`),
    league: leagueItem.league,
    leagueLabel: leagueItem.label,
    sport: leagueItem.sport,
    homeTeam: displayTeam(home.team, 'Home'),
    awayTeam: displayTeam(away.team, 'Away'),
    homeScore,
    awayScore,
    status: state,
    statusDetail: statusType.shortDetail || competition.status?.displayClock || event.shortName || 'Scheduled',
    kickoffTime: startTime,
    venue: competition.venue?.fullName || '',
    homeLogo: home.team?.logo || '',
    awayLogo: away.team?.logo || '',
    homeAbbrev: home.team?.abbreviation || '',
    awayAbbrev: away.team?.abbreviation || '',
    competitionId: String(competition.id || event.id || ''),
    isLive,
    isFinal,
    hotScore: isLive ? 100 : isFinal ? 76 : 50,
    summary: event.shortName || event.name || `${displayTeam(home.team, 'Home')} vs ${displayTeam(away.team, 'Away')}`,
    source: 'espn',
    lastSyncedAt: new Date().toISOString()
  };
}

function createDemoFixtures(now = new Date()) {
  const items = [
    ['Premier League', 'eng.1', 'Arsenal', 'Manchester City', 0, 0, 2],
    ['Champions League', 'uefa.champions', 'Real Madrid', 'Inter', 1, 1, 5],
    ['La Liga', 'esp.1', 'Barcelona', 'Atletico Madrid', 0, 0, 8],
    ['Serie A', 'ita.1', 'Inter', 'Juventus', 0, 0, 11],
    ['Bundesliga', 'ger.1', 'Bayern Munich', 'Borussia Dortmund', 0, 0, 14],
    ['Euro', 'uefa.euro', 'France', 'Germany', 0, 0, 17],
    ['World Cup', 'fifa.world', 'Argentina', 'Brazil', 0, 0, 20]
  ];
  return items.map(([label, league, homeTeam, awayTeam, homeScore, awayScore, hours]) => ({
    espnMatchId: `demo-${league}`,
    league,
    leagueLabel: label,
    sport: 'soccer',
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    status: hours <= 3 ? 'in' : 'pre',
    statusDetail: hours <= 3 ? 'Live' : 'Kickoff soon',
    kickoffTime: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
    venue: 'Demo Stadium',
    homeLogo: '',
    awayLogo: '',
    homeAbbrev: '',
    awayAbbrev: '',
    isLive: hours <= 3,
    isFinal: false,
    hotScore: hours <= 3 ? 90 : 60,
    summary: `${homeTeam} vs ${awayTeam}`,
    source: 'demo',
    lastSyncedAt: new Date().toISOString()
  }));
}

async function fetchLeagueMatches(leagueItem, dateKey) {
  const url = buildScoreboardUrl(leagueItem.sport, leagueItem.league, dateKey);
  const payload = await fetchJson(url);
  const events = Array.isArray(payload.events) ? payload.events : [];
  return events.map((event) => mapEventToMatch(event, leagueItem, dateKey));
}

function decimalFromFraction(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) {
    const num = Number(text);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  const match = text.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!denominator) return null;
  return Math.round((1 + numerator / denominator) * 100) / 100;
}

function decimalFromAmerican(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return null;
  const decimal = num > 0 ? 1 + num / 100 : 1 + 100 / Math.abs(num);
  return Math.round(decimal * 100) / 100;
}

function oddsDecimal(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'number') return decimalFromAmerican(value) || fallback;
  if (typeof value === 'string') return decimalFromFraction(value) || fallback;
  return value.decimal || value.value || decimalFromFraction(value.displayValue) || decimalFromFraction(value.alternateDisplayValue) || decimalFromAmerican(value.american) || fallback;
}

function oddsText(value, fallback = '') {
  if (!value) return fallback;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.alternateDisplayValue || value.displayValue || value.fraction || value.american || String(value.value || fallback);
}

function addMarket(markets, market) {
  const options = (market.options || []).filter((option) => Number(option.odds) > 0);
  if (!options.length) return;
  markets.push({
    ...market,
    options
  });
}

function providerPrefix(item) {
  return item.provider?.name || item.provider?.id || 'ESPN Odds';
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function parseStandardOdds(item, match) {
  const markets = [];
  const provider = providerPrefix(item);
  const providerId = item.provider?.id || normalizeKey(provider);
  const current = item.current || {};
  const homeCurrent = item.homeTeamOdds?.current || {};
  const awayCurrent = item.awayTeamOdds?.current || {};
  const home = match.homeTeam;
  const away = match.awayTeam;

  addMarket(markets, {
    key: `${providerId}_moneyline`,
    title: `${provider} - 1X2 cả trận`,
    provider,
    providerId,
    period: 'full',
    marketType: 'moneyline',
    settlementMode: 'auto',
    source: 'espn_odds',
    description: 'Kết quả sau 90 phút',
    options: [
      {
        key: 'home',
        label: home,
        selection: 'home',
        odds: oddsDecimal(homeCurrent.moneyLine, decimalFromAmerican(item.homeTeamOdds?.moneyLine)),
        oddsText: oddsText(homeCurrent.moneyLine, String(item.homeTeamOdds?.moneyLine || ''))
      },
      {
        key: 'draw',
        label: 'Hòa',
        selection: 'draw',
        odds: oddsDecimal(current.draw, decimalFromAmerican(item.drawOdds?.moneyLine)),
        oddsText: oddsText(current.draw, String(item.drawOdds?.moneyLine || ''))
      },
      {
        key: 'away',
        label: away,
        selection: 'away',
        odds: oddsDecimal(awayCurrent.moneyLine, decimalFromAmerican(item.awayTeamOdds?.moneyLine)),
        oddsText: oddsText(awayCurrent.moneyLine, String(item.awayTeamOdds?.moneyLine || ''))
      }
    ]
  });

  const lineHome = Number(item.spread);
  if (Number.isFinite(lineHome)) {
    addMarket(markets, {
      key: `${providerId}_spread`,
      title: `${provider} - Handicap cả trận`,
      provider,
      providerId,
      period: 'full',
      marketType: 'handicap',
      settlementMode: 'auto',
      source: 'espn_odds',
      lineHome,
      description: `${home} ${lineHome > 0 ? '+' : ''}${lineHome}`,
      options: [
        {
          key: 'home_spread',
          label: `${home} ${lineHome > 0 ? '+' : ''}${lineHome}`,
          selection: 'home',
          lineHome,
          odds: oddsDecimal(homeCurrent.spread, decimalFromAmerican(item.homeTeamOdds?.spreadOdds)),
          oddsText: oddsText(homeCurrent.spread, String(item.homeTeamOdds?.spreadOdds || ''))
        },
        {
          key: 'away_spread',
          label: `${away} ${-lineHome > 0 ? '+' : ''}${-lineHome}`,
          selection: 'away',
          lineHome,
          odds: oddsDecimal(awayCurrent.spread, decimalFromAmerican(item.awayTeamOdds?.spreadOdds)),
          oddsText: oddsText(awayCurrent.spread, String(item.awayTeamOdds?.spreadOdds || ''))
        }
      ]
    });
  }

  const totalLine = Number(item.overUnder);
  if (Number.isFinite(totalLine)) {
    addMarket(markets, {
      key: `${providerId}_total`,
      title: `${provider} - Tài xỉu cả trận`,
      provider,
      providerId,
      period: 'full',
      marketType: 'total',
      settlementMode: 'auto',
      source: 'espn_odds',
      line: totalLine,
      description: `Tổng bàn ${totalLine}`,
      options: [
        {
          key: 'over',
          label: `Tài ${totalLine}`,
          selection: 'over',
          line: totalLine,
          odds: oddsDecimal(current.over, decimalFromAmerican(item.overOdds)),
          oddsText: oddsText(current.over, String(item.overOdds || ''))
        },
        {
          key: 'under',
          label: `Xỉu ${totalLine}`,
          selection: 'under',
          line: totalLine,
          odds: oddsDecimal(current.under, decimalFromAmerican(item.underOdds)),
          oddsText: oddsText(current.under, String(item.underOdds || ''))
        }
      ]
    });
  }

  return markets;
}

function parseBet365TeamOdds(item, match) {
  const provider = providerPrefix(item);
  const providerId = item.provider?.id || normalizeKey(provider);
  const teamOdds = item.bettingOdds?.teamOdds || {};
  const markets = [];
  const home = match.homeTeam;
  const away = match.awayTeam;
  const totalLine = decimalFromFraction(teamOdds.preMatchOverUnderHandicap?.value);

  addMarket(markets, {
    key: `${providerId}_full_time_result`,
    title: `${provider} - 1X2 cả trận`,
    provider,
    providerId,
    period: 'full',
    marketType: 'moneyline',
    settlementMode: 'auto',
    source: 'espn_odds',
    description: 'Full Time Result',
    options: [
      {
        key: 'home',
        label: home,
        selection: 'home',
        odds: decimalFromFraction(teamOdds.preMatchFullTimeResultHome?.value),
        oddsText: teamOdds.preMatchFullTimeResultHome?.value,
        oddId: teamOdds.preMatchFullTimeResultHome?.oddId
      },
      {
        key: 'draw',
        label: 'Hòa',
        selection: 'draw',
        odds: decimalFromFraction(teamOdds.preMatchFullTimeResultDraw?.value),
        oddsText: teamOdds.preMatchFullTimeResultDraw?.value,
        oddId: teamOdds.preMatchFullTimeResultDraw?.oddId
      },
      {
        key: 'away',
        label: away,
        selection: 'away',
        odds: decimalFromFraction(teamOdds.preMatchFullTimeResultAway?.value),
        oddsText: teamOdds.preMatchFullTimeResultAway?.value,
        oddId: teamOdds.preMatchFullTimeResultAway?.oddId
      }
    ]
  });

  addMarket(markets, {
    key: `${providerId}_double_chance`,
    title: `${provider} - Double chance`,
    provider,
    providerId,
    period: 'full',
    marketType: 'double_chance',
    settlementMode: 'auto',
    source: 'espn_odds',
    description: 'Thắng nếu rơi vào 1 trong 2 cửa',
    options: [
      {
        key: 'home_draw',
        label: `${home} hoặc Hòa`,
        selection: 'home_draw',
        odds: decimalFromFraction(teamOdds.preMatchDoubleChanceHomeOrDraw?.value),
        oddsText: teamOdds.preMatchDoubleChanceHomeOrDraw?.value,
        oddId: teamOdds.preMatchDoubleChanceHomeOrDraw?.oddId
      },
      {
        key: 'home_away',
        label: `${home} hoặc ${away}`,
        selection: 'home_away',
        odds: decimalFromFraction(teamOdds.preMatchDoubleChanceHomeOrAway?.value),
        oddsText: teamOdds.preMatchDoubleChanceHomeOrAway?.value,
        oddId: teamOdds.preMatchDoubleChanceHomeOrAway?.oddId
      },
      {
        key: 'draw_away',
        label: `Hòa hoặc ${away}`,
        selection: 'draw_away',
        odds: decimalFromFraction(teamOdds.preMatchDoubleChanceDrawOrAway?.value),
        oddsText: teamOdds.preMatchDoubleChanceDrawOrAway?.value,
        oddId: teamOdds.preMatchDoubleChanceDrawOrAway?.oddId
      }
    ]
  });

  if (Number.isFinite(totalLine)) {
    addMarket(markets, {
      key: `${providerId}_goal_line`,
      title: `${provider} - Goal line`,
      provider,
      providerId,
      period: 'full',
      marketType: 'total',
      settlementMode: 'auto',
      source: 'espn_odds',
      line: totalLine,
      description: `Tổng bàn ${totalLine}`,
      options: [
        {
          key: 'over',
          label: `Tài ${totalLine}`,
          selection: 'over',
          line: totalLine,
          odds: decimalFromFraction(teamOdds.preMatchGoalLineOver?.value),
          oddsText: teamOdds.preMatchGoalLineOver?.value,
          oddId: teamOdds.preMatchGoalLineOver?.oddId
        },
        {
          key: 'under',
          label: `Xỉu ${totalLine}`,
          selection: 'under',
          line: totalLine,
          odds: decimalFromFraction(teamOdds.preMatchGoalLineUnder?.value),
          oddsText: teamOdds.preMatchGoalLineUnder?.value,
          oddId: teamOdds.preMatchGoalLineUnder?.oddId
        }
      ]
    });
  }

  const known = new Set([
    'preMatchFullTimeResultDraw',
    'preMatchFullTimeResultAway',
    'preMatchFullTimeResultHome',
    'preMatchDoubleChanceDrawOrAway',
    'preMatchDoubleChanceHomeOrAway',
    'preMatchDoubleChanceHomeOrDraw',
    'preMatchOverUnderHandicap',
    'preMatchGoalLineUnder',
    'preMatchGoalLineOver'
  ]);

  Object.entries(teamOdds).forEach(([key, value]) => {
    if (known.has(key) || !value?.value) return;
    addMarket(markets, {
      key: `${providerId}_${normalizeKey(key)}`,
      title: `${provider} - ${key.replace(/^preMatch/, '').replace(/([a-z])([A-Z])/g, '$1 $2')}`,
      provider,
      providerId,
      period: 'full',
      marketType: 'generic',
      settlementMode: 'manual',
      source: 'espn_odds',
      description: 'Có trong endpoint ESPN, cần admin chấm tay',
      options: [
        {
          key: normalizeKey(key),
          label: key.replace(/^preMatch/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
          selection: normalizeKey(key),
          odds: decimalFromFraction(value.value),
          oddsText: value.value,
          oddId: value.oddId
        }
      ]
    });
  });

  return markets;
}

function parsePlayerOdds(item) {
  const provider = providerPrefix(item);
  const providerId = item.provider?.id || normalizeKey(provider);
  const playerOdds = item.bettingOdds?.playerOdds || {};
  const markets = [];

  Object.entries(playerOdds).forEach(([key, options]) => {
    if (!Array.isArray(options)) return;
    addMarket(markets, {
      key: `${providerId}_${normalizeKey(key)}`,
      title: `${provider} - ${key.replace(/^preMatch/, '').replace(/([a-z])([A-Z])/g, '$1 $2')}`,
      provider,
      providerId,
      period: 'full',
      marketType: 'player_prop',
      settlementMode: 'manual',
      source: 'espn_odds',
      description: 'Có trong endpoint ESPN, cần admin chấm tay',
      options: options.map((option) => ({
        key: String(option.oddId || normalizeKey(option.player)),
        label: option.player || 'Unknown player',
        selection: option.player || '',
        odds: decimalFromFraction(option.value),
        oddsText: option.value,
        oddId: option.oddId
      }))
    });
  });

  return markets;
}

function parseOddsMarkets(payload, match) {
  const markets = [];
  const items = Array.isArray(payload?.items) ? payload.items : [];
  items.forEach((item) => {
    markets.push(...parseStandardOdds(item, match));
    markets.push(...parseBet365TeamOdds(item, match));
    markets.push(...parsePlayerOdds(item));
  });
  return markets;
}

async function fetchOddsMarkets(match) {
  if (!match.espnMatchId || !match.competitionId) return [];
  const url = buildOddsUrl(match.sport || 'soccer', match.league, match.espnMatchId, match.competitionId);
  const payload = await fetchJson(url, 6000);
  return parseOddsMarkets(payload, match);
}

async function syncMatches(db, options = {}) {
  const now = new Date();
  const fixtureDates = options.fixtureDates || [0, 1, 2];
  const dateKeys = fixtureDates.map((offset) => dateKeyFromDate(addDays(now, offset)));
  const fetched = [];
  const errors = [];
  const tasks = [];
  for (const leagueItem of leagueCatalog) {
    for (const dateKey of dateKeys) {
      tasks.push({ leagueItem, dateKey });
    }
  }

  const results = await Promise.allSettled(
    tasks.map((task) => fetchLeagueMatches(task.leagueItem, task.dateKey))
  );
  results.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === 'fulfilled') {
      fetched.push(...result.value);
    } else {
      errors.push({ league: task.leagueItem.league, dateKey: task.dateKey, message: result.reason?.message || 'Fetch failed' });
    }
  });

  const oddsResults = await Promise.allSettled(fetched.map((match) => fetchOddsMarkets(match)));
  oddsResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      fetched[index].oddsMarkets = result.value;
    } else {
      fetched[index].oddsMarkets = [];
      errors.push({ league: fetched[index].league, dateKey: fetched[index].kickoffTime?.slice(0, 10), message: result.reason?.message || 'Odds fetch failed' });
    }
  });

  return { matches: fetched, errors };
}

function upsertMatches(db, matches) {
  const existingByEspnId = new Map();
  for (const match of db.matches) {
    if (match.espnMatchId) existingByEspnId.set(match.espnMatchId, match);
  }

  const upserted = [];
  for (const incoming of matches) {
    const existing = existingByEspnId.get(incoming.espnMatchId);
    if (existing) {
      const updated = {
        ...existing,
        ...incoming,
        id: existing.id,
        createdAt: existing.createdAt || incoming.lastSyncedAt,
        updatedAt: new Date().toISOString(),
        source: incoming.source || existing.source || 'espn'
      };
      Object.assign(existing, updated);
      upserted.push(existing);
    } else {
      const match = {
        id: db.meta.nextMatchId++,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...incoming
      };
      db.matches.push(match);
      upserted.push(match);
    }
  }

  db.matches = db.matches.sort((a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime));

  return upserted;
}

function isMatchLocked(match, settings) {
  if (!match) return true;
  if (match.isFinal) return true;
  if (match.isLive || match.status === 'in') return true;
  const kickoff = new Date(match.kickoffTime).getTime();
  if (!Number.isFinite(kickoff)) return false;
  const lockMinutes = Number(settings?.predictionLockMinutes || 5);
  return Date.now() >= kickoff - lockMinutes * 60 * 1000;
}

function matchOutcome(match) {
  if (!match) return 'unknown';
  if (match.homeScore > match.awayScore) return 'home';
  if (match.homeScore < match.awayScore) return 'away';
  return 'draw';
}

function predictionOutcome(prediction) {
  if (!prediction) return 'unknown';
  if (prediction.predictedWinner) return prediction.predictedWinner;
  if (Number(prediction.predictedHomeScore) > Number(prediction.predictedAwayScore)) return 'home';
  if (Number(prediction.predictedHomeScore) < Number(prediction.predictedAwayScore)) return 'away';
  return 'draw';
}

function getMultiplier(match, prediction, settings) {
  const actual = matchOutcome(match);
  const predicted = predictionOutcome(prediction);
  const exact = Number(prediction.predictedHomeScore) === Number(match.homeScore) && Number(prediction.predictedAwayScore) === Number(match.awayScore);
  if (exact) return { status: 'won', multiplier: Number(settings?.multipliers?.exact || 2), exact: true };
  if (actual === 'draw' && predicted === 'draw') {
    return { status: 'draw', multiplier: Number(settings?.multipliers?.draw || 1.8), exact: false };
  }
  if (actual !== 'draw' && predicted === actual) {
    return { status: 'won', multiplier: Number(settings?.multipliers?.win || 1.5), exact: false };
  }
  return { status: 'lost', multiplier: 0, exact: false };
}

module.exports = {
  syncMatches,
  upsertMatches,
  createDemoFixtures,
  isMatchLocked,
  matchOutcome,
  predictionOutcome,
  getMultiplier,
  leagueLabel
};
