import html from '../public/index.html';
import docs from '../public/docs.html';
import js from '../public/app.js.txt';
import css from '../public/style.css';
import { createApp } from './app.js';

export { WorkdayQuota } from './lib/quota.js'; // SQLite-backed Durable Object: per-key monthly quota + global daily pool

const handle = createApp({ html, docs, js, css });
export default { fetch: (req, env, ctx) => handle(req, env, ctx) };
