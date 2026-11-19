// The weather check. The timer runs it every 30 minutes, even when nobody
// has the website open; the "Check forecast" button can run it on demand.
//
// 1. Load all plans.
// 2. Get a fresh forecast for every ZIP that has upcoming weather plans
//    (one download per ZIP, saved as forecasts/<zip>.json).
// 3. Work out each plan's status, note what changed since the last check,
//    and log an alert when a plan turns bad or clears up.

const { readJson, writeJson, updateJson } = require('./store');
const { geocodeZip, fetchForecast, UpstreamError } = require('./weather');
const rules = require('./rules');

const FORECAST_MAX_AGE_MS = 30 * 60 * 1000;   // reuse a forecast for up to 30 minutes
const MAX_ALERTS = 200;

class NotFoundError extends Error {}

// Latest forecast for a ZIP: the saved one if it's fresh enough, otherwise a
// new download. If Open-Meteo is down, an older saved forecast is returned
// with stale: true rather than nothing.
async function getForecast(zip, { maxAgeMs = FORECAST_MAX_AGE_MS } = {}) {
    const saved = await readJson(`forecasts/${zip}.json`);
    const old = saved && saved.data;
    if (old && Date.now() - old.issuedAt < maxAgeMs) return old;

    try {
        // Coordinates never change, so reuse them from the saved forecast.
        let location = old ? { latitude: old.latitude, longitude: old.longitude, place: old.place } : await geocodeZip(zip);
        if (!location) throw new NotFoundError(`Couldn't find ZIP code ${zip}. Check the number and edit the plan.`);
        const fc = await fetchForecast(location.latitude, location.longitude);
        const data = {
            zip, place: location.place, latitude: location.latitude, longitude: location.longitude,
            timezone: fc.timezone, issuedAt: Date.now(), source: 'Open-Meteo', days: fc.days,
        };
        await writeJson(`forecasts/${zip}.json`, data);
        return data;
    } catch (err) {
        if (old && err instanceof UpstreamError) return { ...old, stale: true };
        throw err;
    }
}

async function runCheck({ force = false, log = console } = {}) {
    const startedAt = Date.now();
    const plans = ((await readJson('plans.json')) || { data: [] }).data;

    // Which ZIPs need a forecast? Upcoming weather plans within 16 days.
    const zips = [...new Set(plans
        .filter((p) => rules.isWeather(p) && !rules.isPast(p) && rules.inRange(p))
        .map((p) => p.zip))];

    const forecasts = {};
    const errors = {};
    for (const zip of zips) {
        try {
            // The timer runs every 30 minutes; 25 minutes means it always refreshes.
            forecasts[zip] = await getForecast(zip, { maxAgeMs: force ? 0 : 25 * 60 * 1000 });
        } catch (err) {
            errors[zip] = err.message;
            log.error?.(`Forecast for ${zip} failed: ${err.message}`);
        }
    }

    let newAlerts = [];
    let counts = {};
    await updateJson('plans.json', [], (current) => {
        newAlerts = [];
        counts = {};
        for (const plan of current) {
            const forecast = forecasts[plan.zip];
            const { status, result } = rules.evaluatePlan(plan, forecast);
            counts[status] = (counts[status] || 0) + 1;
            if (!result) {
                // No forecast this time (event, past, out of range, or a failed download).
                if (['event', 'past', 'pending'].includes(status)) plan.lastStatus = status;
                continue;
            }

            const snap = rules.snapshotOf(result);
            const key = rules.snapshotKey(plan);
            if (plan.lastSnapshot && plan.snapshotKey === key) {
                const changes = rules.diffSnapshots(plan.lastSnapshot, snap);
                if (changes.length) { plan.changes = changes; plan.changedAt = startedAt; }
            } else {
                plan.changes = [];
            }
            plan.lastSnapshot = snap;
            plan.snapshotKey = key;
            plan.lastCheckedAt = startedAt;

            if (status === 'breach' && plan.lastStatus !== 'breach') {
                newAlerts.push({
                    at: startedAt, planId: plan.id, title: plan.title, kind: 'breach',
                    text: result.violations.map((v) => rules.issueText(v, plan.limits)).join('; '),
                });
            } else if (plan.lastStatus === 'breach' && status !== 'breach') {
                newAlerts.push({ at: startedAt, planId: plan.id, title: plan.title, kind: 'clear', text: 'The forecast is back within your limits.' });
            }
            plan.lastStatus = status;
        }
        return current;
    });

    if (newAlerts.length) {
        await updateJson('alerts.json', [], (alerts) => [...newAlerts, ...alerts].slice(0, MAX_ALERTS));
        for (const a of newAlerts) {
            // This is where a real notification would be sent (for example, an
            // email through Azure Communication Services).
            log.log?.(`Alert: ${a.title} — ${a.kind === 'breach' ? a.text : 'all clear'}`);
        }
    }

    const summary = {
        lastRunAt: startedAt,
        durationMs: Date.now() - startedAt,
        plans: plans.length,
        zipsChecked: Object.keys(forecasts).length,
        errors,
        counts,
        alertsSent: newAlerts.length,
    };
    await writeJson('status.json', summary);
    return summary;
}

module.exports = { runCheck, getForecast, NotFoundError };
