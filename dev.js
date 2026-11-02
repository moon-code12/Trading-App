// Starts the API and the Vite client together. Run with `npm run dev` from the project root.
import { spawn } from 'node:child_process';

const env = {
  JWT_SECRET: 'dev-secret-change-me',
  ADMIN_EMAIL: 'sultanabdulwaheed9@gmail.com',
  ADMIN_PASSWORD: 'Sultan@123',
  ...process.env,
};

const run = (cwd, args) =>
  spawn('npm', args, { cwd, env, stdio: 'inherit', shell: true });

const procs = [
  run('server', ['run', 'dev']),
  run('client', ['run', 'dev', '--', '--port', '5175']),
];

const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
procs.forEach((p) => p.on('exit', stop));
