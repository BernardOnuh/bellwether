// Prints a URL that opens the Mini App outside Telegram as a signed test user (local preview only).
//   npx tsx scripts/miniapp-preview.ts [base=http://localhost:8787] [dark]
import '../src/config.js';
import { signInitData } from '../src/miniapp.js';

const base = process.argv[2] ?? 'http://localhost:8787';
const dark = process.argv.includes('dark');
const data = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 999000111, first_name: 'Preview', username: 'preview_user' }) },
  process.env.TELEGRAM_BOT_TOKEN!);
const theme = JSON.stringify(dark ? { bg_color: '#0f2236', text_color: '#eef6fd' } : { bg_color: '#ffffff', text_color: '#0b2540' });
console.log(`${base}/app#tgWebAppData=${encodeURIComponent(data)}&tgWebAppVersion=7.10&tgWebAppPlatform=ios&tgWebAppThemeParams=${encodeURIComponent(theme)}`);
