// icons/icon.svg から PNG アイコン（180・512px）を作る
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync(new URL('../icons/icon.svg', import.meta.url), 'utf8');
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'msedge' }); }
for (const size of [180, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: new URL(`../icons/icon-${size}.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons ok');
