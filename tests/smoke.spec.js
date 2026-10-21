// smoke.spec.js — tool-specific checks for the YAML and JSON Converter (fixtures in tests/fixtures, all fictional).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const read = (name) => fs.readFileSync(fixture(name), 'utf8');

async function open(page) {
  await page.goto('./');
  await expect(page.locator('#badge')).toHaveAttribute('data-state', 'ok'); // the built-in sample converted
}

async function paste(page, text) {
  await page.fill('#input', text);
}

test.describe('YAML and JSON Converter', () => {
  test('pasting the bundled sample.yaml shows equivalent JSON on the right', async ({ page }) => {
    await open(page);
    const yaml = read('sample.yaml');
    await paste(page, yaml);
    await expect(page.locator('#output')).toHaveValue(/"invoice": 1042/);
    const json = JSON.parse(await page.inputValue('#output'));
    expect(json).toEqual({
      invoice: 1042,
      customer: { name: 'Acme Example Ltd', email: 'billing@example.test' },
      items: [{ sku: 'A-1', qty: 2 }, { sku: 'B-7', qty: 1 }],
      paid: false,
    });
    await expect(page.locator('#badge')).toHaveText('Valid YAML');
    await expect(page.locator('#output')).toHaveValue(/\n  "customer": \{\n    "name"/); // 2-space default indent
    await expect(page.locator('#results .alert--error')).toHaveCount(0);
  });

  test('switching direction converts the sample JSON to YAML with 2 space indentation', async ({ page }) => {
    await open(page);
    await page.click('label[for="dir-j2y"]');
    await expect(page.locator('#input-label')).toHaveText('JSON input');
    await paste(page, read('sample.json'));
    const out = page.locator('#output');
    await expect(out).toHaveValue(/^invoice: 1042\n/);
    const yaml = await out.inputValue();
    expect(yaml).toContain('customer:\n  name: Acme Example Ltd\n  email: billing@example.test\n');
    expect(yaml).toContain('items:\n  - sku: A-1\n    qty: 2\n    price: 25\n');
    expect(yaml).toContain('tags:\n  - sample\n  - fictional\n');
    expect(yaml).not.toMatch(/^\t/m);
    await expect(page.locator('#download')).toHaveText('Download converted.yaml');

    // 4-space option, then Swap moves the YAML back into the input as YAML -> JSON
    await page.click('#options-menu summary');
    await page.selectOption('#opt-indent', '4');
    await expect(out).toHaveValue(/customer:\n {4}name: Acme Example Ltd/);
    await page.keyboard.press('Escape');
    await page.click('#swap');
    await expect(page.locator('#dir-y2j')).toBeChecked();
    await expect(page.locator('#input')).toHaveValue(/^invoice: 1042/);
    expect(JSON.parse(await out.inputValue()).items[1].price).toBe(1200);
  });

  test('invalid YAML with a tab indent shows an error with line and column', async ({ page }) => {
    await open(page);
    await page.setInputFiles('#file-input', fixture('tab-indent.yaml'));
    const err = page.locator('#results .alert.alert--error');
    await expect(err).toBeVisible();
    await expect(err).toContainText('Line 3, column 1');
    await expect(err).toContainText(/tab/i);
    await expect(err.locator('.yj-snippet')).toContainText('3 | →port: 8080');
    await expect(err.locator('.yj-snippet')).toContainText('^');
    await expect(page.locator('#badge')).toHaveText('Error · line 3');
    await expect(page.locator('#output')).toHaveValue('');
    // Go to line selects the problem in the input
    await err.getByRole('button', { name: 'Go to line 3' }).click();
    const sel = await page.evaluate(() => document.getElementById('input').selectionStart);
    expect(sel).toBe('server:\n  host: example.test\n'.length);
  });

  test('missing space after a colon and duplicate keys get plain advice', async ({ page }) => {
    await open(page);
    await paste(page, 'name: demo\nport:8080\nmode: test\n');
    await expect(page.locator('#results .alert--error')).toContainText('write "port: 8080"');
    await paste(page, 'name: a\nname: b\n');
    await expect(page.locator('#results .alert--error')).toContainText(/Line 2, column 1/);
    await expect(page.locator('#results .alert--error')).toContainText(/same key appears twice/);
  });

  test('multiple documents separated by three dashes become a JSON array', async ({ page }) => {
    await open(page);
    await paste(page, read('multi.yaml'));
    await expect(page.locator('#badge')).toHaveText('Valid · 2 docs');
    const json = JSON.parse(await page.inputValue('#output'));
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(2);
    expect(json[0].kind).toBe('Service');
    expect(json[1].spec.replicas).toBe(2);
    await expect(page.locator('#results')).toContainText('2 YAML documents');
  });

  test('anchors, dates, leading zeros, big integers, emoji and empty input', async ({ page }) => {
    await open(page);
    await paste(page, '﻿base: &b {x: 1}\ncopy: *b\nzip: 02134\nbig: 12345678901234567890\nday: 2024-05-01\nat: 2024-05-01T10:00:00Z\nmood: "🙂"\nflag: yes\n');
    await expect(page.locator('#output')).toHaveValue(/"zip"/);
    const json = JSON.parse(await page.inputValue('#output'));
    expect(json).toEqual({ base: { x: 1 }, copy: { x: 1 }, zip: '02134', big: '12345678901234567890', day: '2024-05-01', at: '2024-05-01T10:00:00.000Z', mood: '🙂', flag: 'yes' });
    const results = page.locator('#results');
    await expect(results).toContainText('Anchors and aliases were expanded');
    await expect(results).toContainText('leading zeros');
    await expect(results.locator('.yj-warn')).toContainText('safe range');
    await expect(results).toContainText('byte order mark');
    await expect(results).toContainText('YAML 1.1');
    await page.click('#options-menu summary');
    await page.selectOption('#opt-schema', 'yaml11');
    await expect(page.locator('#output')).toHaveValue(/"flag": true/);
    await page.check('#opt-sort');
    await expect(page.locator('#output')).toHaveValue(/^\{\n  "at"/);
    await paste(page, '   \n');
    await expect(page.locator('#badge')).toHaveText('Empty');
    await expect(page.locator('#results .alert--error')).toHaveCount(0);
    await expect(page.locator('#results')).toContainText('Paste YAML');
  });

  test('safe mode refuses custom tags, and can keep them when turned off', async ({ page }) => {
    await open(page);
    await paste(page, 'bucket: !Ref AssetsBucket\n');
    await expect(page.locator('#results .alert--error')).toContainText('unknown tag');
    await page.click('#options-menu summary');
    await page.uncheck('#opt-safe');
    await expect(page.locator('#output')).toHaveValue(/"!Ref": "AssetsBucket"/);
  });

  test('JSON errors show line, column and advice; flow style works', async ({ page }) => {
    await open(page);
    await page.click('label[for="dir-j2y"]');
    await paste(page, '{\n  "a": [1, 2,],\n  "b": 1\n}');
    const err = page.locator('#results .alert--error');
    await expect(err).toContainText('Line 2, column 14');
    await expect(err).toContainText('trailing comma');
    await paste(page, '{"a": [1, {"b": 2}], "c": "x"}');
    await page.click('#options-menu summary');
    await page.selectOption('#opt-style', 'flow');
    await expect(page.locator('#output')).toHaveValue('{a: [1, {b: 2}], c: x}\n');
  });

  test('the copy and download buttons produce non empty output', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await page.setInputFiles('#file-input', fixture('compose.yaml'));
    await expect(page.locator('#download')).toHaveText('Download compose.json');
    await expect(page.locator('#results')).toContainText('Anchors and aliases were expanded');

    await page.click('#copy');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.length).toBeGreaterThan(100);
    expect(JSON.parse(clip)).toEqual(JSON.parse(read('compose.json')));

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(download.suggestedFilename()).toBe('compose.json');
    const body = fs.readFileSync(await download.path(), 'utf8');
    expect(body.length).toBeGreaterThan(100);
    expect(JSON.parse(body).services.db.environment.TZ).toBe('UTC');

    // keyboard shortcut downloads too, now as YAML after swapping
    await page.click('#swap');
    await expect(page.locator('#download')).toHaveText('Download compose.yaml');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('#input').press('Control+s')]);
    expect(dl2.suggestedFilename()).toBe('compose.yaml');
    const yaml = fs.readFileSync(await dl2.path(), 'utf8');
    expect(yaml).toContain('services:\n  web:\n');
  });

  test('wrong file types are rejected, also when mixed with valid files', async ({ page }) => {
    await open(page);
    await page.setInputFiles('#file-input', fixture('sample.png'));
    await expect(page.locator('#results .alert--error')).toContainText('sample.png was not opened');
    // the picker takes one file; drop several at once onto the text area
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File(['a: 1\n'], 'good.yml', { type: 'text/yaml' }));
      dt.items.add(new File(['xx'], 'photo.png', { type: 'image/png' }));
      document.getElementById('input').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#output')).toHaveValue('{\n  "a": 1\n}\n');
    await expect(page.locator('#results .alert--error')).toContainText('photo.png was not opened');
    await expect(page.locator('#download')).toHaveText('Download good.json');
  });

  test('works at 390px wide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await page.setInputFiles('#file-input', fixture('tab-indent.yaml'));
    await expect(page.locator('#results .alert--error')).toBeVisible();
    await page.click('#options-menu summary');
    await expect(page.locator('#opt-indent')).toBeVisible();
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    expect(w.doc).toBeLessThanOrEqual(w.win + 1);
    await page.keyboard.press('Escape');
    await paste(page, read('sample.yaml'));
    await expect(page.locator('#output')).toHaveValue(/"invoice": 1042/);
    for (const id of ['#input', '#output', '#copy', '#download', '#swap', '#convert']) {
      const box = await page.locator(id).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(391);
    }
    // stacked on phones: output sits below input
    const a = await page.locator('#input').boundingBox();
    const b = await page.locator('#output').boundingBox();
    expect(b.y).toBeGreaterThan(a.y + a.height);
  });

  test('large documents are converted in a worker', async ({ page }) => {
    await open(page);
    const n = 40000;
    await page.evaluate((count) => {
      const lines = [];
      for (let i = 0; i < count; i++) lines.push(`- id: ${i}\n  name: item-${i}\n  note: "${'x'.repeat(30)}"`);
      const el = document.getElementById('input');
      el.value = lines.join('\n');
      el.dispatchEvent(new Event('input'));
    }, n);
    await expect(page.locator('#output')).toHaveValue(/^\[/, { timeout: 30_000 });
    await expect(page.locator('#badge')).toHaveText('Valid YAML');
    const len = await page.evaluate(() => JSON.parse(document.getElementById('output').value).length);
    expect(len).toBe(n);
  });

  test('__demo shows a finished result', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__demo());
    await expect(page.locator('#output')).toHaveValue(/"inkwell-blog"/);
    await expect(page.locator('#results .result')).toBeVisible();
  });
});
