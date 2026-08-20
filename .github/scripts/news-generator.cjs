const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RSS_FEEDS = [
  'https://www.google.com/alerts/feeds/046071187132762778180/7113581475891808027',
  'https://www.google.com/alerts/feeds/046071187132762778180/5536053482845216723',
  'https://www.google.com/alerts/feeds/046071187132762778180/14775702419061050618',
  'https://www.google.com/alerts/feeds/046071187132762778180/9623177313418892372',
  'https://www.google.com/alerts/feeds/046071187132762778180/17224163804371326723',
  'https://www.google.com/alerts/feeds/046071187132762778180/16734298621464871050'
];

const REPO_DIR = process.env.GITHUB_WORKSPACE || process.cwd();
const STATE_FILE = path.join(REPO_DIR, '.posted.json');
const CATEGORIES = ['Asset Management', 'Blockchain', 'Investment', 'Finance', 'Citizenship', 'IPO', 'Tokenization', 'AI', 'Real Estate'];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetch(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function htmlEscape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '')
    .replace(/&gt;/g, '')
    .replace(/&amp;/g, '')
    .replace(/&#39;/g, '')
    .replace(/&quot;/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function extractRssItems(xml) {
  const items = [];
  const regex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const entry = match[1];
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (entry.match(/<link[^>]+href="([^"]+)"/) || [])[1] || '';
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
    const description = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
    if (title && link) {
      items.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), link, published, description: description.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() });
    }
  }
  return items;
}

function pickCategories(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const picked = [];
  const map = {
    'Asset Management': ['asset management', 'asset-management'],
    'Blockchain': ['blockchain', 'web3'],
    'Investment': ['investment', 'investor'],
    'Finance': ['finance', 'financial'],
    'Citizenship': ['citizenship', 'citizenship-by-investment'],
    'IPO': ['ipo', 'initial public offering'],
    'Tokenization': ['tokenization', 'tokenised', 'tokenized'],
    'AI': ['ai ', 'artificial intelligence', 'machine learning'],
    'Real Estate': ['real estate', 'property']
  };
  for (const [category, keywords] of Object.entries(map)) {
    if (keywords.some(keyword => text.includes(keyword))) {
      picked.push(category);
    }
  }
  if (!picked.length) {
    picked.push('Finance');
  }
  return picked.slice(0, 3);
}

function postToTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
    console.log('Missing Telegram env vars');
    return Promise.resolve();
  }
  const payload = JSON.stringify({ chat_id: TELEGRAM_CHANNEL_ID, text, disable_web_page_preview: true });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          const data = JSON.parse(body);
          console.log('Telegram response:', data.ok ? 'ok' : (data.description || body));
          resolve(data);
        } catch {
          console.log('Telegram raw:', body);
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  let posted = {};
  if (fs.existsSync(STATE_FILE)) {
    posted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }

  const allEntries = [];
  for (const feed of RSS_FEEDS) {
    try {
      const xml = await fetch(feed);
      const items = extractRssItems(xml);
      allEntries.push(...items);
    } catch (err) {
      console.error('Failed feed:', feed, err.message);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const entry of allEntries) {
    if (!seen.has(entry.link)) {
      seen.add(entry.link);
      unique.push(entry);
    }
  }

  const newPosted = { ...posted };
  const postsDir = path.join(REPO_DIR, '_posts');
  fs.mkdirSync(postsDir, { recursive: true });

  let newCount = 0;
  for (const entry of unique.slice(0, 20)) {
    if (posted[entry.link]) continue;
    const datePart = entry.published ? entry.published.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const slug = slugify(entry.title) || 'news';
    const filename = `${datePart}-${slug}.md`;
    const filepath = path.join(postsDir, filename);
    if (fs.existsSync(filepath)) continue;

    const categories = pickCategories(entry.title, entry.description);
    const tags = categories.slice(0, 2);
    const frontMatter = `---\nlayout: post\ntitle: "${htmlEscape(entry.title)}"\ndate: ${entry.published || new Date().toISOString()}\ncategories: [${categories.map(c => `"${c}"`).join(', ')}]\ntags: [${tags.map(t => `"${t}"`).join(', ')}]\n---\n\n${htmlEscape(entry.description)}\n\n[Source](${htmlEscape(entry.link)})\n`;

    fs.writeFileSync(filepath, frontMatter);
    newPosted[entry.link] = { filename, date: new Date().toISOString() };
    newCount++;

    const shortText = `${entry.title}\nhttps://wealthandrich.github.io/news/posts/${slug}/`;
    await postToTelegram(shortText);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(newPosted, null, 2));

  if (newCount > 0) {
    execSync('git config --global user.email "ci@github.com"', { cwd: REPO_DIR });
    execSync('git config --global user.name "github-actions"', { cwd: REPO_DIR });
    execSync('git add -A', { cwd: REPO_DIR });
    execSync('git commit -m "news: add posts"', { cwd: REPO_DIR });
    execSync('git push origin main', { cwd: REPO_DIR });
    console.log(`Committed ${newCount} new posts`);
  } else {
    console.log('No new posts');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
