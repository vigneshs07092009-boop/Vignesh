/* ============================================================
 * Sample Aevion Plugin — "hello-world"
 * Plugins are plain JS files that call Aevion.plugins.register().
 * commands: map of prefix → async handler(text) → string reply.
 * ============================================================ */
(function () {
  Aevion.plugins.register({
    name: 'Hello World',
    desc: 'Demo plugin: greet command + fortune skill.',
    commands: {
      '/hello': async () => '👋 Hello from a plugin! Edit js/plugins/hello-world.js to build your own skills.',

      '/fortune': async () => {
        const f = ['A commit a day keeps the merge conflicts away.', 'Great code is written twice: once in your head.', 'The bug you fear is the bug you have not tested.', 'Ship small, ship often.'];
        return '🔮 ' + f[Math.floor(Math.random() * f.length)];
      }
    }
  });
})();
