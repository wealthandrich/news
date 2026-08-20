const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RSS_FEEDS = [
  'https://www.google.com/alerts/feeds/16796289713519395004/2170601499816620500',
  'https://www.google.com/alerts/feeds/16796289713519395004/6399346419578384221',
  'https://www.google.com/alerts/feeds/16796289713519395004/17930995347607772141',
  'https://www.google.com/alerts/feeds/16796289713519395004/8600496722936643125',
  'https://www.google.com/alerts/feeds/16796289713519395004/8600496722936639852',
  'https://www.google.com/alerts/feeds/16796289713519395004/3734443426973380210'
];

const REPO_DIR = process.env.GITHUB_WORKSPACE || process.cwd();
const POSTS_DIR = path.join(REPO_DIR, '_posts');
const STATE_FILE = path.join(REPO_DIR, '.posted.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function cleanText(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').substring(0, 80);
}

function extractCategory(description) {
  const lower = description.toLowerCase();
  if (lower.includes('bitcoin') || lower.includes('crypto')) return 'Cryptocurrency';
  if (lower.includes('ethereum') || lower.includes('defi')) return 'DeFi';
  if (lower.includes('real estate') || lower.includes('property')) return 'Real Estate';
  if (lower.includes('stock') || lower.includes('equity')) return 'Stocks';
  if (lower.includes('gold') || lower.includes('commodity')) return 'Commodities';
  if (lower.includes('tax') || lower.includes('irs')) return 'Taxes';
  if (lower.includes('immigration') || lower.includes('visa')) return 'Immigration';
  return 'Finance';
}

function extractTags(description) {
  const tags = [];
  const lower = description.toLowerCase();
  if (lower.includes('bitcoin')) tags.push('Bitcoin');
  if (lower.includes('ethereum')) tags.push('Ethereum');
  if (lower.includes('ai') || lower.includes('artificial intelligence')) tags.push('AI');
  if (lower.includes('real estate')) tags.push('Real Estate');
  if (lower.includes('gold')) tags.push('Gold');
  if (lower.includes('crypto')) tags.push('Crypto');
  if (lower.includes('investment')) tags.push('Investment');
  if (lower.includes('tax')) tags.push('Tax');
  if (lower.includes('immigration')) tags.push('Immigration');
  return tags.length > 0 ? tags : ['Finance'];
}

async function parseAtomFeed(xml, feedUrl) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkMatch = entry.match(/<link[^>]+href="([^"]+)"/);
    const updatedMatch = entry.match(/<updated>([^<]+)<\/updated>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const summaryMatch = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);

    if (!titleMatch || !linkMatch) continue;

    const title = cleanText(titleMatch[1]);
    const link = linkMatch[1];
    const dateStr = publishedMatch?.[1] || updatedMatch?.[1] || new Date().toISOString();
    const rawSummary = summaryMatch?.[1] || contentMatch?.[1] || '';
    const description = cleanText(rawSummary);

    entries.push({
      title,
      link,
      published: dateStr,
      description,
      category: extractCategory(title + ' ' + description),
      tags: extractTags(title + ' ' + description),
      source: new URL(feedUrl).hostname
    });
  }
  return entries;
}

async function fetchFeed(url) {
  try {
    const xml = await fetch(url);
    return await parseAtomFeed(xml, url);
  } catch (err) {
    console.error(`Failed to fetch ${url}: ${err.message}`);
    return [];
  }
}

function createPostContent(entry) {
  const date = new Date(entry.published).toISOString().split('T')[0];
  const slug = slugify(entry.title);
  const tags = [...new Set([entry.category, ...entry.tags])];
  const frontMatter = `---
layout: post
title: "${entry.title.replace(/"/g, '\\"')}"
date: ${entry.published}
categories: [${entry.category}]
tags: [${tags.map(t => t.replace(/"/g, '\\"')).join(', ')}]
author: Wealth & Rich
---

${entry.description}

[Read full article](${entry.link})
`;

  return { filename: `${date}-${slug}.md`, content: frontMatter };
}

async function main() {
  console.log('Fetching RSS feeds...');
  const allEntries = [];
  for (const url of RSS_FEEDS) {
    const entries = await fetchFeed(url);
    allEntries.push(...entries);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`Total entries fetched: ${allEntries.length}`);

  const seen = new Set();
  const unique = [];
  for (const entry of allEntries) {
    const key = entry.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry);
    }
  }
  console.log(`Unique entries after dedup: ${unique.length}`);

  let state = {};
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load state:', err.message);
  }

  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  let newCount = 0;
  for (const entry of unique) {
    const { filename, content } = createPostContent(entry);
    const filepath = path.join(POSTS_DIR, filename);

    if (state[filename]) continue;

    fs.writeFileSync(filepath, content);
    state[filename] = { created: new Date().toISOString() };
    newCount++;
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`New posts created: ${newCount}`);

  if (newCount > 0) {
    console.log('Committing and pushing...');
    try {
      execSync('git config --global user.email "ci@github.com"', { cwd: REPO_DIR });
      execSync('git config --global user.name "github-actions"', { cwd: REPO_DIR });
      execSync('git add -A', { cwd: REPO_DIR });
      execSync('git commit -m "news: add ' + newCount + ' new articles"', { cwd: REPO_DIR });
      
      
      if (token) {
        
      }
      execSync('git push origin main', { cwd: REPO_DIR });
      console.log('Push complete');
    } catch (err) {
      console.error('Git operations failed:', err.message);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
