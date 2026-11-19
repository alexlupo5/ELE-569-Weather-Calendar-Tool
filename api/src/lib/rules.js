// Weather rules: the same checks the web page makes, so the background job
// and the page always agree on a plan's status.
// All values are °F and mph. Plan dates and times are local to the ZIP code.

const HORIZON_DAYS = 15;                              // Open-Meteo: today + 15 days
const MARGIN = { tempF: 5, rain: 10, gustMph: 5 };    // "close to a limit"
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';

const isWeather = (p) => p.weather !== false;
const round = (n) => Math.round(n);

const maxOf = (xs, k) => Math.max(...xs.map((x) => x[k]));
const minOf = (xs, k) => Math.min(...xs.map((x) => x[k]));

const RULES = [
    { key: 'cold', bad: (x, t) => x.tempF < t.minTempF, near: (x, t) => x.tempF < t.minTempF + MARGIN.tempF,
      describe: (xs, t) => `Cold: down to ${round(minOf(xs, 'tempF'))}°F (limit ${round(t.minTempF)}°F)` },
    { key: 'hot', bad: (x, t) => x.tempF > t.maxTempF, near: (x, t) => x.tempF > t.maxTempF - MARGIN.tempF,
      describe: (xs, t) => `Hot: up to ${round(maxOf(xs, 'tempF'))}°F (limit ${round(t.maxTempF)}°F)` },
    { key: 'rain', bad: (x, t) => x.rain != null && x.rain > t.maxRain, near: (x, t) => x.rain != null && x.rain > t.maxRain - MARGIN.rain,
      describe: (xs, t) => `Rain: up to ${maxOf(xs, 'rain')}% chance (limit ${t.maxRain}%)` },
    { key: 'gust', bad: (x, t) => x.gustMph > t.maxGustMph, near: (x, t) => x.gustMph > t.maxGustMph - MARGIN.gustMph,
      describe: (xs, t) => `Wind gusts: up to ${round(maxOf(xs, 'gustMph'))} mph (limit ${round(t.maxGustMph)} mph)` },
    { key: 'storm', bad: (x, t) => t.blockStorms && x.storm, near: () => false,
      describe: () => 'Thunderstorms possible' },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.key, r]));

function fmtHour(h) { h = ((h % 24) + 24) % 24; return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`; }

function rangeText(hours) {
    const hs = [...hours].sort((a, b) => a - b);
    const groups = [];
    for (const h of hs) {
        const g = groups[groups.length - 1];
        if (g && h === g[g.length - 1] + 1) g.push(h); else groups.push([h]);
    }
    return groups.map((g) => {
        const a = fmtHour(g[0]);
        const b = fmtHour(g[g.length - 1] + 1);
        return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
    }).join(', ');
}

function issueText(issue, limits) {
    return `${RULE[issue.key].describe(issue.hours, limits)}, ${rangeText(issue.hours.map((x) => x.hour))}`;
}

function hoursOf(plan) {
    const [sh] = plan.start.split(':').map(Number);
    const [eh, em] = plan.end.split(':').map(Number);
    let end = em > 0 ? eh + 1 : eh;
    if (end <= sh) end = sh + 1;
    end = Math.min(end, 24);
    const out = [];
    for (let h = sh; h < end; h++) out.push(h);
    return out;
}

function checkWindow(day, hours, limits) {
    const hs = hours.map((h) => day[h]).filter(Boolean);
    if (!hs.length) return null;
    const violations = [];
    const near = [];
    for (const rule of RULES) {
        const bad = hs.filter((x) => rule.bad(x, limits));
        if (bad.length) { violations.push({ key: rule.key, hours: bad }); continue; }
        const close = hs.filter((x) => rule.near(x, limits));
        if (close.length) near.push({ key: rule.key, hours: close });
    }
    const rains = hs.map((x) => x.rain).filter((v) => v != null);
    return {
        violations, near,
        tempLo: minOf(hs, 'tempF'), tempHi: maxOf(hs, 'tempF'),
        rainMax: rains.length ? Math.max(...rains) : null,
        gustMax: maxOf(hs, 'gustMph'),
        storm: hs.some((x) => x.storm),
    };
}

// Today's date and the current minute of the day in a time zone.
function localNow(timeZone, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function daysBetween(a, b) {
    const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

function isPast(plan, timeZone) {
    const now = localNow(timeZone || DEFAULT_TIMEZONE);
    if (plan.date !== now.date) return plan.date < now.date;
    const [eh, em] = plan.end.split(':').map(Number);
    return eh * 60 + em <= now.minutes;
}

function inRange(plan, timeZone) {
    return daysBetween(localNow(timeZone || DEFAULT_TIMEZONE).date, plan.date) <= HORIZON_DAYS;
}

// Returns { status, result } where status is one of:
// event, past, pending, nodata, safe, watch, breach
function evaluatePlan(plan, forecast) {
    const tz = forecast?.timezone || DEFAULT_TIMEZONE;
    if (!isWeather(plan)) return { status: 'event' };
    if (isPast(plan, tz)) return { status: 'past' };
    if (!inRange(plan, tz)) return { status: 'pending' };
    const day = forecast?.days?.[plan.date];
    if (!day) return { status: 'nodata' };
    const result = checkWindow(day, hoursOf(plan), plan.limits);
    if (!result) return { status: 'nodata' };
    return { status: result.violations.length ? 'breach' : result.near.length ? 'watch' : 'safe', result };
}

const snapshotKey = (p) => `${p.date}|${p.start}|${p.end}|${p.zip}`;

function snapshotOf(result) {
    return { tempLo: result.tempLo, tempHi: result.tempHi, rainMax: result.rainMax, gustMax: result.gustMax, storm: result.storm };
}

function diffSnapshots(a, b) {
    const out = [];
    if (a.rainMax != null && b.rainMax != null && Math.abs(b.rainMax - a.rainMax) >= 10) out.push({ key: 'rain', from: a.rainMax, to: b.rainMax });
    if (Math.abs(b.tempHi - a.tempHi) >= 3) out.push({ key: 'tempHi', from: a.tempHi, to: b.tempHi });
    if (Math.abs(b.tempLo - a.tempLo) >= 3) out.push({ key: 'tempLo', from: a.tempLo, to: b.tempLo });
    if (Math.abs(b.gustMax - a.gustMax) >= 5) out.push({ key: 'gust', from: a.gustMax, to: b.gustMax });
    if (a.storm !== b.storm) out.push({ key: 'storm', from: a.storm, to: b.storm });
    return out;
}

module.exports = {
    HORIZON_DAYS, DEFAULT_TIMEZONE, isWeather, isPast, inRange, evaluatePlan, issueText,
    snapshotKey, snapshotOf, diffSnapshots, localNow, daysBetween,
};
