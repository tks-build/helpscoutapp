/**
 * Suggests trips for what a guest typed in the enquiry form's "Which trip are
 * you interested in?" box — free text such as "Oct 2027 Morocco" or
 * "Central America".
 *
 * Matching the whole phrase found nothing for the first of those, so this
 * matches on the meaningful words. Month names and filler are dropped. A
 * year counts, because trip titles carry one ("Morocco 15 Days 2027 FELMAR"),
 * but only alongside a real word — "2027" on its own would match every trip
 * that year. Trips are ranked by how many words their title contains; one
 * containing the whole phrase ranks first.
 *
 * Returns every match, best first. The caller decides how many to show.
 */

const IGNORED = new Set([
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'the', 'and', 'with', 'for', 'from', 'trip', 'trips', 'tour', 'tours', 'adventure', 'adventures',
  'your', 'any', 'all', 'next', 'year', 'interested', 'day', 'days', 'night', 'nights', 'week', 'weeks',
]);

export function suggestTrips(trips, typed) {
  const phrase = String(typed || '').trim().toLowerCase();
  const tokens = [...new Set(phrase.match(/[a-zÀ-ɏ]{3,}|\b(?:19|20)\d{2}\b/g) || [])];
  const words = tokens.filter((token) => !/^\d+$/.test(token) && !IGNORED.has(token));
  const years = tokens.filter((token) => /^\d+$/.test(token));
  if (!words.length) return [];

  const scored = trips
    .map((trip) => {
      const name = trip.name.toLowerCase();
      const wordHits = words.filter((word) => name.includes(word)).length;
      if (!wordHits) return null;
      const yearHits = years.filter((year) => name.includes(year)).length;
      const wholePhrase = phrase.length >= 3 && name.includes(phrase) ? tokens.length : 0;
      return { trip, score: wordHits + yearHits + wholePhrase };
    })
    .filter(Boolean);
  if (!scored.length) return [];

  // When the guest named a trip precisely, a title sharing one stray word
  // with it is noise. Keep only matches at least half as good as the best.
  const best = Math.max(...scored.map((entry) => entry.score));
  return scored
    .filter((entry) => entry.score >= Math.ceil(best / 2))
    .sort((a, b) => b.score - a.score || a.trip.name.localeCompare(b.trip.name))
    .map((entry) => entry.trip);
}
