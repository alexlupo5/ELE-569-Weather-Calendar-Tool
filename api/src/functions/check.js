// Runs the weather check.
//   Timer:  every 30 minutes, whether or not anyone has the site open.
//   POST /api/check: the page's "Check forecast" button runs it right away.

const { app } = require('@azure/functions');
const { runCheck } = require('../lib/checker');
const { readJson } = require('../lib/store');
const { reply, checkAccess, guarded } = require('../lib/http');

app.timer('checkWeather', {
    // NCRONTAB (second minute hour day month weekday), in UTC: at :00 and :30.
    schedule: '0 */30 * * * *',
    handler: async (timer, context) => {
        const summary = await runCheck({ log: context });
        context.log(`Weather check: ${summary.plans} plans, ${summary.zipsChecked} ZIPs, ${summary.alertsSent} alerts, ${Object.keys(summary.errors).length} errors`);
    },
});

app.http('checkNow', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'check',
    handler: (request, context) => guarded(context, async () => {
        const denied = checkAccess(request);
        if (denied) return denied;
        // Don't let repeated clicks hammer Open-Meteo: one forced check per minute.
        const status = await readJson('status.json');
        const recent = status && Date.now() - status.data.lastRunAt < 60 * 1000;
        const summary = await runCheck({ force: !recent, log: context });
        return reply(200, summary);
    }),
});
