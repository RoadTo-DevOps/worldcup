const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PUBLIC_DIR = fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const leagueCatalog = [
  { label: 'Premier League', sport: 'soccer', league: 'eng.1' },
  { label: 'Champions League', sport: 'soccer', league: 'uefa.champions' },
  { label: 'La Liga', sport: 'soccer', league: 'esp.1' },
  { label: 'Serie A', sport: 'soccer', league: 'ita.1' },
  { label: 'Bundesliga', sport: 'soccer', league: 'ger.1' },
  { label: 'Euro', sport: 'soccer', league: 'uefa.euro' },
  { label: 'World Cup', sport: 'soccer', league: 'fifa.world' }
];

const defaultSettings = {
  initialBalance: 1000,
  multipliers: {
    win: 1.5,
    exact: 2,
    draw: 1.8
  },
  maxBetPercent: 0.25,
  predictionLockMinutes: 5,
  featureLeague: 'eng.1'
};

module.exports = {
  ROOT_DIR,
  DIST_DIR,
  PUBLIC_DIR,
  DATA_DIR,
  DB_PATH,
  leagueCatalog,
  defaultSettings
};
