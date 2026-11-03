import { boot } from './bootstrap.js';

let started;
try { started = await boot(); } catch (e) { console.error(e.message); process.exit(1); }
const { app, runOrders, runChallenges } = started;

// Orders can take about a second to reach the simulated market, so check for work often.
setInterval(() => runOrders().catch((e) => console.error(e)), 1000);
// Weekly challenges appear on schedule, and finished ones are frozen and announced.
setInterval(() => runChallenges().catch((e) => console.error(e)), 60e3);
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API listening on :${port}`));
