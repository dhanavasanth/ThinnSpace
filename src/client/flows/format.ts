/**
 * Small formatting helpers shared by the Flows surfaces so the home page,
 * the editor header, the Versions drawer and the node cards agree on copy.
 */

/** "just now", "4m ago", "2h ago", "3d ago". */
export function relativeTime(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Sentence describing a schedule stored as seconds plus optional day/time. */
export function describeSchedule(config: Record<string, unknown>, key: string) {
  const seconds = Number(config[key]) || 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 'No schedule set.';
  if (config[`${key}Days`] === 'weekdays') {
    const at = String(config[`${key}At`] || '09:00');
    return `Runs Monday to Friday at ${at}.`;
  }
  if (seconds % 604800 === 0) {
    const weeks = seconds / 604800;
    return weeks === 1 ? 'Runs once a week.' : `Runs every ${weeks} weeks.`;
  }
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? 'Runs once a day.' : `Runs every ${days} days.`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'Runs every hour.' : `Runs every ${hours} hours.`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1
    ? 'Runs every minute.'
    : `Runs every ${minutes} minutes.`;
}
