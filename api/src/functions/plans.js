// Plans API
//   GET    /api/plans       -> { plans, alerts, lastRunAt }
//   PUT    /api/plans/{id}  -> create or update one plan
//   DELETE /api/plans/{id}  -> delete one plan

const { app } = require('@azure/functions');
const { readJson, updateJson } = require('../lib/store');
const { reply, checkAccess, guarded } = require('../lib/http');
const { snapshotKey } = require('../lib/rules');

// Fields the background check manages; the page never sends these.
const SERVER_FIELDS = ['lastStatus', 'lastSnapshot', 'snapshotKey', 'changes', 'changedAt', 'lastCheckedAt'];

function validId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
}

// Returns { plan } with only the fields we accept, or { error }.
function cleanPlan(body) {
    if (!body || typeof body !== 'object') return { error: 'Send the plan as JSON.' };
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

    const title = str(body.title);
    const date = str(body.date);
    const start = str(body.start);
    const end = str(body.end);
    const zip = str(body.zip);
    const weather = body.weather !== false;
    const l = body.limits || {};
    const limits = {
        minTempF: num(l.minTempF),
        maxTempF: num(l.maxTempF),
        maxRain: num(l.maxRain),
        maxGustMph: num(l.maxGustMph),
        blockStorms: l.blockStorms !== false,
    };

    if (!title || title.length > 80) return { error: 'The plan needs a name of up to 80 characters.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'The date must look like 2026-11-20.' };
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return { error: 'Times must look like 09:00.' };
    if (end <= start) return { error: 'The end time needs to be after the start time.' };
    if (weather && !/^\d{5}$/.test(zip)) return { error: 'Weather plans need a 5-digit ZIP code.' };
    if (!weather && zip && !/^\d{5}$/.test(zip)) return { error: 'The ZIP code needs 5 digits, or leave it blank.' };
    if ([limits.minTempF, limits.maxTempF, limits.maxRain, limits.maxGustMph].some(Number.isNaN)) return { error: 'The weather limits are missing.' };
    if (limits.minTempF >= limits.maxTempF) return { error: 'The lowest temperature must be below the highest.' };
    if (limits.maxRain < 0 || limits.maxRain > 100) return { error: 'Rain chance must be between 0 and 100%.' };
    if (limits.maxGustMph < 0 || limits.maxGustMph > 200) return { error: 'The wind limit is out of range.' };

    return { plan: { title, date, start, end, zip, weather, limits } };
}

app.http('listPlans', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'plans',
    handler: (request, context) => guarded(context, async () => {
        const denied = checkAccess(request);
        if (denied) return denied;
        const [plans, alerts, status] = await Promise.all([readJson('plans.json'), readJson('alerts.json'), readJson('status.json')]);
        return reply(200, {
            plans: plans ? plans.data : [],
            alerts: alerts ? alerts.data.slice(0, 50) : [],
            lastRunAt: status ? status.data.lastRunAt : null,
        });
    }),
});

app.http('savePlan', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'plans/{id}',
    handler: (request, context) => guarded(context, async () => {
        const denied = checkAccess(request);
        if (denied) return denied;
        const id = request.params.id;
        if (!validId(id)) return reply(400, { error: 'Invalid plan id.' });

        let body;
        try { body = await request.json(); } catch { body = null; }
        const { plan, error } = cleanPlan(body);
        if (error) return reply(400, { error });

        let saved = null;
        let tooMany = false;
        await updateJson('plans.json', [], (plans) => {
            const existing = plans.find((p) => p.id === id);
            if (!existing && plans.length >= 500) { tooMany = true; return plans; }
            const next = { id, createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(), ...plan };
            if (existing) {
                // Keep the background check's history unless the plan moved
                // (different date, time or ZIP). Its last status is always kept,
                // so a change that turns the weather bad still sends an alert.
                const keep = snapshotKey(existing) === snapshotKey(next);
                for (const f of SERVER_FIELDS) {
                    if ((f === 'lastStatus' || keep) && existing[f] !== undefined) next[f] = existing[f];
                }
                if (!keep) next.changes = [];
                plans[plans.indexOf(existing)] = next;
            } else {
                plans.push(next);
            }
            saved = next;
            return plans;
        });
        if (tooMany) return reply(400, { error: 'This calendar is full (500 plans). Delete some old plans first.' });
        return reply(200, { plan: saved });
    }),
});

app.http('deletePlan', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'plans/{id}',
    handler: (request, context) => guarded(context, async () => {
        const denied = checkAccess(request);
        if (denied) return denied;
        const id = request.params.id;
        if (!validId(id)) return reply(400, { error: 'Invalid plan id.' });
        await updateJson('plans.json', [], (plans) => plans.filter((p) => p.id !== id));
        return reply(200, { deleted: id });
    }),
});

module.exports = { cleanPlan };
