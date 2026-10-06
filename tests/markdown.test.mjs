/* Tests for markdown.js — how model output reaches the DOM.
   Every one of these is a safety property: model replies are untrusted
   input, so they must never be able to inject markup or a script URL. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './harness.mjs';

const md = () => createApp().Aevion.md;

test('escaping: HTML in a reply is rendered as text, never as markup', () => {
  const M = md();
  const html = M.render('<script>alert(1)</script>');
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('&lt;script&gt;'), true);
});

test('escaping: a tag smuggled through an inline code span stays inert', () => {
  const M = md();
  const html = M.render('use `<img src=x onerror=alert(1)>` here');
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});

test('escaping: a tag inside a fenced code block stays inert', () => {
  const M = md();
  const html = M.render('```html\n<script>alert(1)</script>\n```');
  assert.equal(/<\/?script/i.test(html), false, 'no live script tag may appear');
  // the syntax highlighter splits the token, so assert on the escaped entity
  assert.match(html, /&lt;script/);
  assert.match(html, /&lt;\/script/);
});

test('escaping: quotes and ampersands are escaped everywhere', () => {
  const M = md();
  const html = M.render('a "quote" & an \'apostrophe\'');
  assert.equal(html.includes('&amp;'), true);
  assert.equal(html.includes('&quot;'), true);
});

test('links: only http(s), mailto and fragments are allowed', () => {
  const M = md();
  for (const bad of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'vbscript:msgbox']) {
    const html = M.render(`[click](${bad})`);
    assert.equal(/href="(?!https?:|mailto:|#)/.test(html), false, `${bad} must not be linked`);
    assert.equal(html.includes(bad + '"'), false);
  }
  assert.match(M.render('[ok](https://example.com)'), /href="https:\/\/example\.com"/);
  assert.match(M.render('[mail](mailto:a@b.com)'), /href="mailto:a@b\.com"/);
});

test('links: external links cannot reach back through window.opener', () => {
  const M = md();
  const html = M.render('[x](https://example.com)');
  assert.match(html, /rel="noopener noreferrer"/);
});

test('inline: bold, italic, strike and inline code', () => {
  const M = md();
  const html = M.render('**bold** *italic* ~~gone~~ `code`');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /md-code-inline/);
});

test('blocks: headings, lists, quotes, rules and tables', () => {
  const M = md();
  assert.match(M.render('## Title'), /<h2[^>]*>Title<\/h2>/);
  assert.match(M.render('- one\n- two'), /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(M.render('1. one\n2. two'), /<ol>/);
  assert.match(M.render('> quoted'), /<blockquote>/);
  assert.match(M.render('---'), /<hr>/);
  const table = M.render('| a | b |\n|:---|---:|\n| 1 | 2 |');
  assert.match(table, /<table>/);
  assert.match(table, /<th[^>]*>a<\/th>/);
  assert.match(table, /text-align:right/);       // the :---: alignment is honoured
  assert.match(table, /<tbody>/);
});

test('code blocks: carry the language, a copy button and real highlighting', () => {
  const M = md();
  const html = M.render('```python\ndef f():\n    return 1\n```');
  assert.match(html, /md-code-lang">python</);
  assert.match(html, /md-code-copy/);
  assert.match(html, /tok-kw/);
  assert.match(html, /<pre>/);
});

test('code blocks: an unknown language still renders as a block', () => {
  const M = md();
  const html = M.render('```brainfuck\n+++[>+++<]\n```');
  assert.match(html, /md-code/);
  assert.match(html, /\+{3}/);
});

test('code blocks: an unclosed fence degrades to something readable', () => {
  const M = md();
  const html = M.render('text before\n```js\nconst a = 1;');
  assert.ok(html.length > 0);
  assert.equal(html.includes('<script'), false);
});

test('streaming guard: repainting pauses only while a fence is open', () => {
  const M = md();
  assert.equal(M.canStream('plain text so far'), true);
  assert.equal(M.canStream('```js\nconst a'), false);
  assert.equal(M.canStream('```js\nconst a\n```\ndone'), true);
});

test('toPlain: strips markup for text-to-speech', () => {
  const M = md();
  const plain = M.toPlain('## Title\n\n**bold** and `code`\n\n- bullet one\n- bullet two\n\n```js\nconst a = 1;\n```');
  assert.equal(plain.includes('*'), false);
  assert.equal(plain.includes('#'), false);
  assert.equal(plain.includes('`'), false);
  assert.match(plain, /Title/);
  assert.match(plain, /code block/);
});

test('render: empty and whitespace input produce nothing at all', () => {
  const M = md();
  assert.equal(M.render(''), '');
  assert.equal(M.render('   \n  '), '');
  assert.equal(M.render(null), '');
});

test('render: carriage returns do not produce stray blocks', () => {
  const M = md();
  const html = M.render('line one\r\nline two');
  assert.equal(html.split('<p>').length - 1, 1);
});

test('render: a very large reply still renders without exploding', () => {
  const M = md();
  const big = Array.from({ length: 400 }, (_, i) => `Line ${i} with **bold** and \`code\`.`).join('\n\n');
  const html = M.render(big);
  assert.ok(html.length > 4000);
  assert.equal(html.includes('<script'), false);
});
