// Full-day XNYS closures. Beyond this documented span the capture refuses rather than guessing.
const firstYear = 2000;
const lastYear = 2030;
const special = new Set([
  '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14',
  '2004-06-11', '2007-01-02', '2012-10-29', '2012-10-30',
  '2018-12-05', '2025-01-09',
]);
const day = 86_400_000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const utc = (year, month, date) => Date.UTC(year, month, date);
const nth = (year, month, weekday, n) => {
  const first = new Date(utc(year, month, 1)).getUTCDay();
  return utc(year, month, 1 + (weekday - first + 7) % 7 + (n - 1) * 7);
};
const last = (year, month, weekday) => {
  const end = new Date(utc(year, month + 1, 0));
  return utc(year, month, end.getUTCDate() - (end.getUTCDay() - weekday + 7) % 7);
};
const observed = (time) => {
  const weekday = new Date(time).getUTCDay();
  return time + (weekday === 6 ? -day : weekday === 0 ? day : 0);
};
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return utc(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, (h + l - 7 * m + 114) % 31 + 1);
}
const cache = new Map();
function closures(year) {
  if (cache.has(year)) return cache.get(year);
  const dates = new Set([...special].filter((date) => date.startsWith(`${year}-`)));
  const newYear = utc(year, 0, 1);
  // XNYS does not observe a Saturday New Year's Day on the preceding Friday.
  if (new Date(newYear).getUTCDay() !== 6) dates.add(iso(observed(newYear)));
  const fixed = [nth(year, 0, 1, 3), nth(year, 1, 1, 3), easter(year) - 2 * day,
    last(year, 4, 1), observed(utc(year, 6, 4)), nth(year, 8, 1, 1),
    nth(year, 10, 4, 4), observed(utc(year, 11, 25))];
  if (year >= 2022) fixed.push(observed(utc(year, 5, 19)));
  for (const time of fixed) dates.add(iso(time));
  cache.set(year, dates);
  return dates;
}
export function dateMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && iso(time) === value ? time : null;
}
export function plusYears(value, count) {
  const year = Number(value.slice(0, 4)) + count;
  const month = Number(value.slice(5, 7));
  const date = Math.min(Number(value.slice(8, 10)), new Date(utc(year, month, 0)).getUTCDate());
  return `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}
export function sessions(from, through) {
  const start = dateMillis(from), end = dateMillis(through);
  if (start === null || end === null || start > end) throw new Error(`INVALID_CURVE_DATE: invalid range ${from}..${through}`);
  if (Number(from.slice(0, 4)) < firstYear || Number(through.slice(0, 4)) > lastYear)
    throw new Error(`UNSUPPORTED_CURVE_CALENDAR: XNYS full-day calendar covers ${firstYear}..${lastYear}`);
  const dates = [];
  for (let time = start; time <= end; time += day) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !closures(date.getUTCFullYear()).has(iso(time))) dates.push(iso(time));
  }
  return dates;
}
