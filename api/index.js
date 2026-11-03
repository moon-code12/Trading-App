// Vercel serverless entry: every /api/* request lands here (see vercel.json) and is handed to the Express app.
import { waitUntil } from '@vercel/functions';
import { boot } from '../server/src/bootstrap.js';

let ready;
export default async function handler(req, res) {
  ready ??= boot({ jobs: 'lazy', waitUntil }).catch((e) => { ready = undefined; throw e; });
  const { app } = await ready;
  return app(req, res);
}
