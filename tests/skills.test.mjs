/* Tests for skills.js — the offline capabilities the assistant claims.
   These are the answers a user sees with the network cable pulled, so
   they must be right without any provider configured. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply } from './harness.mjs';

/* ---------- maths ---------- */

test('math: evaluates ordinary expressions locally', () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.skills.math('2+2'), '= 4');
  assert.equal(Aevion.skills.math('(45*12)+9/3'), '= 543');
  assert.equal(Aevion.skills.math('what is 10/4'), '= 2.5');
  assert.equal(Aevion.skills.math('2^10'), '= 1024');
  assert.equal(Aevion.skills.math('17 % 5'), '= 2');
  assert.equal(Aevion.skills.math('-3 * -4'), '= 12');
});

test('math: refuses anything that is not arithmetic', () => {
  const { Aevion } = createApp();
  assert.match(Aevion.skills.math('alert(1)'), /plain numbers and operators/);
  assert.match(Aevion.skills.math('1; process.exit()'), /plain numbers and operators/);
  assert.match(Aevion.skills.math('Math.random()'), /plain numbers and operators/);
  assert.match(Aevion.skills.math("require('fs')"), /plain numbers and operators/);
});

test('math: a non-finite result is reported, not printed', () => {
  const { Aevion } = createApp();
  assert.match(Aevion.skills.math('1/0'), /finite number/);
});

test('math: unparseable but numeric-looking input fails gracefully', () => {
  const { Aevion } = createApp();
  assert.match(Aevion.skills.math('1+'), /couldn't parse/);
  assert.match(Aevion.skills.math('((('), /couldn't parse/);
});

/* ---------- translation ---------- */

test('translate: parses "translate X to Y" and understands language names and codes', () => {
  const { Aevion } = createApp();
  const a = Aevion.skills.parseTranslate('translate good morning to tamil');
  assert.equal(a.text, 'good morning');
  assert.equal(a.target, 'ta');
  assert.equal(a.targetLabel, 'Tamil');
  assert.equal(Aevion.skills.parseTranslate('translate hello into Hindi').target, 'hi');
  assert.equal(Aevion.skills.parseTranslate('translate hello to es').target, 'es');
  assert.equal(Aevion.skills.parseTranslate('hello there'), null);
});

test('translate: an unknown language is named back to the user', async () => {
  const { Aevion } = createApp({ settings: { onlineSearch: true } });
  const out = await Aevion.skills.translate('translate hello to klingon');
  assert.match(out, /klingon/);
  assert.match(out, /Try:/);
});

test('translate: stays offline until the user allows online search', async () => {
  const fetch = makeFetch([{ reply: jsonReply([[]]) }]);
  const { Aevion } = createApp({ settings: { onlineSearch: false }, fetch });
  const out = await Aevion.skills.translate('translate hello to tamil');
  assert.match(out, /Enable “Allow online search”/);
  assert.equal(fetch.calls.length, 0, 'no text may be sent while the switch is off');
});

test('translate: when allowed, it posts the text and returns the translated line', async () => {
  const fetch = makeFetch([{ reply: jsonReply([[['வணக்கம்', 'hello', null, null]]]) }]);
  const { Aevion } = createApp({ settings: { onlineSearch: true }, fetch });
  const out = await Aevion.skills.translate('translate hello to tamil');
  assert.match(out, /Tamil: வணக்கம்/);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /tl=ta/);
});

/* ---------- summarizer ---------- */

const ARTICLE = 'Kotlin is a statically typed language. It runs on the Java virtual machine. ' +
  'Kotlin is the official language for Android development. Coroutines make asynchronous code readable. ' +
  'Many teams migrated from Java to Kotlin for null safety. Compose is a declarative UI toolkit.';

test('summarize: returns bullets, and a longer mode returns more of them', () => {
  const { Aevion } = createApp();
  const short = Aevion.skills.summarize(ARTICLE, 'short');
  const long = Aevion.skills.summarize(ARTICLE, 'long');
  assert.match(short, /^• /);
  assert.ok(long.split('\n').length >= short.split('\n').length);
});

test('summarize: keeps sentence order rather than ranking order', () => {
  const { Aevion } = createApp();
  const out = Aevion.skills.summarize(ARTICLE, 'long').split('\n').map(l => l.replace('• ', ''));
  const positions = out.map(s => ARTICLE.indexOf(s));
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions);
});

test('summarize: a two-sentence input is passed through unchanged', () => {
  const { Aevion } = createApp();
  const t = 'One thing happened. Then another happened.';
  assert.equal(Aevion.skills.summarize(t, 'short'), t);
});

/* ---------- quiz / code knowledge ---------- */

test('quiz: produces five usable question/answer pairs about the topic', () => {
  const { Aevion } = createApp();
  const qs = Aevion.skills.quiz('recursion');
  assert.equal(qs.length, 5);
  for (const [q, a] of qs) {
    assert.ok(typeof q === 'string' && q.length > 5);
    assert.ok(typeof a === 'string' && a.length > 3);
  }
  assert.match(qs[0][0], /recursion/);
});

test('code notes: covers every language the project promises', () => {
  const { Aevion } = createApp();
  const promised = ['python', 'javascript', 'typescript', 'java', 'kotlin', 'c', 'cpp', 'csharp',
    'go', 'rust', 'swift', 'php', 'ruby', 'dart', 'sql', 'html', 'css', 'bash', 'powershell'];
  const langs = Aevion.skills.codeLangs();
  for (const l of promised) assert.ok(langs.includes(l), `no local notes for ${l}`);
  assert.match(Aevion.skills.codeNote('kotlin'), /KOTLIN/);
  assert.match(Aevion.skills.codeNote('brainfuck'), /not in my local notes/);
});

/* ---------- language detection ---------- */

/* Every language the project promises to recognise, with a snippet that
   looks like real code in it. This table is the contract: if one of these
   stops being detected, the promise is broken. */
const SAMPLES = {
  javascript: 'const x = 1;\nfunction go() {\n  console.log("hi");\n}\n',
  typescript: 'interface User { name: string; }\nconst u: User = { name: "a" };\n',
  python: 'import os\n\ndef main():\n    print("hi")\n',
  java: 'import java.util.List;\npublic class Main {\n  public static void main(String[] a) { System.out.println(1); }\n}\n',
  kotlin: 'fun main() {\n  val x = 1\n  println(x)\n}\n',
  c: '#include <stdio.h>\nint main() { printf("hi"); return 0; }\n',
  cpp: '#include <iostream>\nint main() { std::cout << "hi"; }\n',
  csharp: 'using System;\nnamespace App {\n  public class Program {\n    public static void Main() { Console.WriteLine("hi"); }\n  }\n}\n',
  go: 'package main\nimport "fmt"\nfunc main() { fmt.Println("hi") }\n',
  rust: 'fn main() {\n  let mut x = 1;\n  println!("{}", x);\n}\n',
  swift: 'import Foundation\nfunc greet(name: String) -> String {\n  return "hi"\n}\n',
  php: '<?php\n$name = "x";\necho "hello";\n',
  ruby: 'def greet(name)\n  puts "hello #{name}"\nend\n',
  dart: "import 'package:flutter/material.dart';\nvoid main() { runApp(App()); }\n",
  sql: 'SELECT name FROM users WHERE id = 1;',
  html: '<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>',
  css: '.card {\n  display: flex;\n  color: red;\n}\n',
  bash: '#!/bin/bash\nfor f in *.txt; do\n  echo "$f"\ndone\n',
  powershell: 'param($name)\nWrite-Host "hello $name"\nGet-ChildItem -Path .\\src\n'
};

const EXTRA_SAMPLES = {
  json: '{"name": "aevion", "version": 1}',
  yaml: 'name: aevion\nitems:\n  - one\n  - two\n',
  markdown: '# Title\n\n**bold** and a [link](https://example.com)\n\n- item\n'
};

test('detect: identifies every promised language from the code itself', () => {
  const { Aevion } = createApp();
  for (const [expected, sample] of Object.entries(SAMPLES)) {
    const got = Aevion.skills.detectLanguage(sample);
    assert.equal(got, expected, `detected ${got} for:\n${sample}`);
  }
});

test('detect: also covers the config and prose formats it highlights', () => {
  const { Aevion } = createApp();
  for (const [expected, sample] of Object.entries(EXTRA_SAMPLES)) {
    const got = Aevion.skills.detectLanguage(sample);
    assert.equal(got, expected, `detected ${got} for:\n${sample}`);
  }
});

test('every promised language works end to end: notes + detection + highlighting', () => {
  const { Aevion } = createApp();
  const promised = ['python', 'javascript', 'typescript', 'java', 'kotlin', 'c', 'cpp', 'csharp',
    'go', 'rust', 'swift', 'php', 'ruby', 'dart', 'sql', 'html', 'css', 'bash', 'powershell'];
  const missing = [];
  for (const lang of promised) {
    if (!Aevion.skills.codeLangs().includes(lang)) missing.push(`${lang}: no local notes`);
    if (!SAMPLES[lang]) missing.push(`${lang}: no detection sample`);
    else if (Aevion.skills.detectLanguage(SAMPLES[lang]) !== lang) missing.push(`${lang}: not detected`);
    // highlighted? langFor maps names/aliases onto a real rule set
    if (Aevion.md.langFor(lang) === 'text') missing.push(`${lang}: no syntax highlighting`);
  }
  // common spellings a model might use in a fenced block
  for (const [alias, lang] of [['c#', 'csharp'], ['c++', 'cpp'], ['powershell', 'powershell'],
    ['ps1', 'powershell'], ['rb', 'ruby'], ['kt', 'kotlin'], ['sh', 'bash'], ['shell', 'bash']]) {
    if (Aevion.md.langFor(alias) === 'text') missing.push(`${alias}: alias for ${lang} is not highlighted`);
  }
  assert.deepEqual(missing, []);
});

test('highlighting: a dart and a powershell fence really produce tokens', () => {
  const { Aevion } = createApp();
  const dart = Aevion.md.render('```dart\nvoid main() {\n  final x = 1;\n}\n```');
  assert.match(dart, /tok-kw/);
  assert.match(dart, /lang-dart/);
  const ps = Aevion.md.render('```powershell\nWrite-Host "hi"\n$name = 1\n```');
  assert.match(ps, /tok-fn/);
  assert.match(ps, /tok-var/);
  assert.match(ps, /lang-ps/);
});

test('detect: empty or prose input is unknown, not a wild guess', () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.skills.detectLanguage(''), 'unknown');
  assert.equal(Aevion.skills.detectLanguage('   '), 'unknown');
});

test('explain: reports structure and size for a snippet', () => {
  const { Aevion } = createApp();
  const out = Aevion.skills.explainCode('const a = 1;\nclass B {}\nasync function c() { await d(); }\nfor (;;) {}\n');
  assert.match(out, /Code profile/);
  assert.match(out, /5 lines/);
  assert.match(out, /a class/);
  assert.match(out, /asynchronous logic/);
  assert.match(out, /loop/);
});

test('explain: says so plainly when there is no recognisable structure', () => {
  const { Aevion } = createApp();
  assert.match(Aevion.skills.explainCode('hello world'), /no strong signals/);
});
