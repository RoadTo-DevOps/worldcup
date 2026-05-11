export const LEAGUES = [
  { label: 'All leagues', value: 'all' },
  { label: 'Premier League', value: 'eng.1' },
  { label: 'Champions League', value: 'uefa.champions' },
  { label: 'La Liga', value: 'esp.1' },
  { label: 'Serie A', value: 'ita.1' },
  { label: 'Bundesliga', value: 'ger.1' },
  { label: 'Euro', value: 'uefa.euro' },
  { label: 'World Cup', value: 'fifa.world' }
];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0));
}

export function formatDateTime(value) {
  if (!value) return 'TBA';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'TBA';
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

export function shortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit'
  }).format(date);
}

export function initials(name) {
  return String(name || 'U')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export function statusLabel(match) {
  if (!match) return 'Unknown';
  if (match.isFinal || match.status === 'post') return 'Final';
  if (match.isLive || match.status === 'in') return match.statusDetail || 'Live';
  return match.statusDetail || 'Scheduled';
}

export function statusClass(match) {
  if (!match) return 'muted';
  if (match.isFinal || match.status === 'post') return 'final';
  if (match.isLive || match.status === 'in') return 'live';
  return 'upcoming';
}

export function scoreLine(match) {
  if (!match) return '-';
  if (match.status === 'pre' && !match.isLive) return 'vs';
  return `${Number(match.homeScore || 0)} - ${Number(match.awayScore || 0)}`;
}

export function predictionStatus(prediction) {
  if (!prediction) return 'None';
  if (prediction.status === 'pending') return 'Pending';
  if (prediction.status === 'push') return `Push +${formatNumber(prediction.rewardPoints)}`;
  if (prediction.status === 'lost') return 'Lost';
  return `Won +${formatNumber(prediction.rewardPoints)}`;
}

export function routeName() {
  return window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
}

export function routeParts() {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

export function clampText(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}
