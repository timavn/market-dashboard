const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceEmailClip, emailBodyItem } = require('./sourceEmailClip.cjs');

const EMAIL = `<html><head><title>VLO</title><style>.t{background:url(https://hedgeye.com/bg.png)}</style>
<link rel="stylesheet" href="https://hedgeye.com/a.css"></head><body onload="track()">
<script>track()</script><img src="https://hedgeye.com/pixel.gif" width="1">
<a href="javascript:alert(1)">x</a><a href="https://app.hedgeye.com/feed_items/189162">Access Signal Strength Stocks Dashboard</a>
<p><b>REMOVING:</b> <span>MPC, NOW, VLO</span></p><table><tr><td>VLOX</td><td>VLO</td></tr></table></body></html>`;

test('a stored email shows with nothing that runs or loads, and its first mention of the ticker marked', () => {
  const { html, found } = sourceEmailClip(EMAIL, 'VLO');
  assert.equal(found, true);
  assert.doesNotMatch(html, /<script|<img|<link|onload=|javascript:|url\(https/i);
  assert.match(html, /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><base target="_blank">/);
  // The title and a longer ticker never take the mark; the visible list does, once.
  assert.match(html, /<title>VLO<\/title>/);
  assert.match(html, /<span>MPC, NOW, <mark id="analyst-source-hit">VLO<\/mark><\/span>/);
  assert.equal(html.match(/analyst-source-hit">/g).length, 1);
  assert.match(html, /href="https:\/\/app\.hedgeye\.com\/feed_items\/189162"/);
});

test('an email without the ticker, or a fragment without a head, still shows', () => {
  assert.equal(sourceEmailClip(EMAIL, 'DRAM').found, false);
  assert.equal(sourceEmailClip(EMAIL, 'vlo; drop').found, false);
  const { html, found } = sourceEmailClip('<p>BUY SIGNAL - COVERING SHORT DRAM $51.58</p>', 'DRAM');
  assert.equal(found, true);
  assert.match(html, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"[^]*COVERING SHORT <mark id="analyst-source-hit">DRAM<\/mark> \$51\.58/);
});

test('the HTML body is the first stored body part of the message', () => {
  const items = [{ attachmentId: '__MESSAGE__', status: 'MESSAGE_PROCESSED' },
    { attachmentId: 'message-body-html-2', mimeType: 'text/html', s3Key: 'b' },
    { attachmentId: 'message-body-text-1', mimeType: 'text/plain', s3Key: 'c' },
    { attachmentId: 'message-body-html-1', mimeType: 'TEXT/HTML', s3Key: 'a' }];
  assert.equal(emailBodyItem(items).s3Key, 'a');
  assert.equal(emailBodyItem(items.slice(0, 1)), null);
});
