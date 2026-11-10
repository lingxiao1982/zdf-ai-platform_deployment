/**
 * Minimal nginx *location* matcher for regression proof.
 *
 * Implements the documented selection order used by this shared-host bug:
 *   1. exact `location =`
 *   2. longest prefix; if it used `^~`, stop (regex is not considered)
 *   3. first matching `~` / `~*` in config order
 *   4. otherwise the longest prefix
 *
 * This is NOT a full nginx parser. Isolated `nginx -t` is attempted separately
 * when the nginx binary exists; otherwise tests rely on this model plus the
 * limitation label in the PR / runbook.
 */

export function parseLocations(confText) {
  const locs = [];
  const re = /location\s+(=|\^~|~\*|~)?\s*(\S+)\s*\{/g;
  let m;
  while ((m = re.exec(confText))) {
    locs.push({
      modifier: m[1] || '',
      pattern: m[2].replace(/^["']|["']$/g, ''),
      order: locs.length,
    });
  }
  return locs;
}

export function matchLocation(uri, locations) {
  const exact = locations.find((l) => l.modifier === '=' && l.pattern === uri);
  if (exact) return { location: exact, reason: 'exact' };

  const prefixes = locations
    .filter((l) => l.modifier === '' || l.modifier === '^~')
    .filter((l) => uri.startsWith(l.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length || a.order - b.order);
  const bestPrefix = prefixes[0] || null;

  if (bestPrefix && bestPrefix.modifier === '^~') {
    return { location: bestPrefix, reason: 'prefix-caret' };
  }

  for (const loc of locations.filter((l) => l.modifier === '~' || l.modifier === '~*')) {
    const flags = loc.modifier === '~*' ? 'i' : '';
    let re;
    try {
      re = new RegExp(loc.pattern, flags);
    } catch {
      continue;
    }
    if (re.test(uri)) return { location: loc, reason: 'regex' };
  }

  if (bestPrefix) return { location: bestPrefix, reason: 'prefix' };
  return { location: null, reason: 'none' };
}

export function summarizeMatch(uri, locations) {
  const { location, reason } = matchLocation(uri, locations);
  if (!location) return { uri, reason, modifier: '', pattern: '' };
  return { uri, reason, modifier: location.modifier, pattern: location.pattern };
}
