/* ============================================================
 * Aevion Update — check for a new version and, on Android,
 * install it like any other app update.
 *
 * Two surfaces, one story:
 *
 *   BROWSER (PWA on aevion.app): a browser tab cannot replace an
 *     installed app, so this module only reads the server's
 *     update.json and reports what it finds. The honest action the
 *     browser tab can take is to point the user at the download and
 *     install step.
 *
 *   ANDROID (the Aevion app): the native UpdatePlugin gives the web
 *     view its own versionCode, and can take a freshly downloaded,
 *     checksum-verified APK and hand it to Android's PackageInstaller,
 *     which replaces the app in place. That is how app stores do it —
 *     the new file is signed by the same key as the old one, the
 *     system installs it over the old one, and the user's data stays
 *     exactly where it was.
 *
 * Nothing here installs anything without the user's explicit approval.
 * The gate is Aevion.evolve.on() (the consent hash), and even inside
 * the app the install is a confirm-tier action: the user is asked
 * every single time. A browser tab never installs anything, ever.
 *
 * The update source is a single static JSON committed to this repo under
 *   downloads/ and served by raw.githubusercontent.com (open CORS, no server):
 *   { "versionCode": 6009, "versionName": "0.6.9",
 *     "downloadUrl": "https://raw.githubusercontent.com/.../main/downloads/Aevion-0.6.9.apk",
 *     "fileSha256": "...", "minVersionCode": 0,
 *     "mandatory": false,
 *     "note": "what changed, shown as What's new" }
 *
 *   mandatory     true = this build must be taken before the app will run
 *                 happily; "Later" disappears. It is ALSO implied without
 *                 the flag: any install older than minVersionCode is
 *                 mandatory by definition, because the publisher has
 *                 declared everything below it unsupported.
 *   minVersionCode  the oldest install that may go on talking to the
 *                 update source unchanged. 0 means "no floor".
 * The build script writes this file alongside the signed APK; the
 * update flow reads it, verifies the SHA-256 of the download against
 * fileSha256, and only then offers the install. The SHA is what makes
 * the "signed by the same key" promise verifiable — without it, a
 * hijacked download URL could serve anything wearing the update
 * badge, and the whole feature would be worse than absent.
 *
 * The checksum is computed here over the RAW BYTES with WebCrypto
 * directly — not through Aevion.hash(), which is for strings (it
 * TextEncoder-encodes its argument, which would mangle a byte array).
 * The native side re-verifies the same digest over what actually
 * arrived in Java before a single session byte is written, so a
 * mismatch is caught twice, in two languages, before install.
 * ============================================================ */

(function () {
  const U = {}

  /* ---------- the update source ---------- */

  /* One readable place that holds the update URL. The browser PWA can
     only ever *report* the update — so on the web the URL is the
     action. On Android the module downloads from it and hands the file
     to the system installer.

     The default is the update manifest committed to this repo under
     downloads/ and served by raw.githubusercontent.com — it answers with
     open CORS, no server of our own, and the pinned SHA-256 in it is
     what makes trusting a static file safe. A custom host can take over
     any time via the updateUrl setting. */
  const DEFAULT_UPDATE_URL =
    'https://raw.githubusercontent.com/vigneshs07092009-boop/Vignesh/main/downloads/update.json'

  /* Settings keys this module owns. They ride in Aevion.settings like
     every other setting, so they persist with the rest and survive
     updates — which is the whole point of an in-place update. */
  U.updateUrlKey = 'updateUrl'
  U.lastCheckedKey = 'updateCheckedAt'   // ms timestamp of the last completed check
  U.pendingKey = 'updatePending'         // { versionCode, versionName, downloadUrl, fileSha256, note, mandatory, t }
  U.deferredKey = 'updateDeferredUntil'  // ms timestamp until which reminders are suppressed

  const CHECK_INTERVAL_MS = 6 * 3600 * 1000     // never auto-check more often than every 6 hours
  const AUTO_REPEAT_MS = 30 * 60 * 1000         // while the app is open, look again this often
  const LATER_MS = 24 * 3600 * 1000             // what the "Later" button means: a day, not forever

  /* ---------- settings helpers ----------
     Aevion has no settings getter — the settings object IS the API
     (Aevion.set writes and persists; reads are plain property reads).
     These two wrap that honestly, including the "settings not ready
     yet" case, so this module is safe to load before boot completes. */

  function getSetting(key, dflt) {
    try {
      var v = Aevion.settings ? Aevion.settings[key] : undefined
      return (v === undefined || v === null) ? dflt : v
    } catch (e) { return dflt }
  }

  /* ---------- current version ---------- */

  /* The web build knows its version from Aevion.version. The native
     build additionally knows its versionCode from the UpdatePlugin —
     the same number the build writes into the APK and into
     update.json, so one manifest answers for every surface. */
  U.currentVersionName = function () {
    return Aevion.version || '?.?.?'
  }

  U.currentVersionCode = function () {
    /* Preferred: ask the native bridge. The bridge call is async, so
       this is a best-effort synchronous read of a value the app caches
       at boot via U.initNative() — never a guess dressed as fact. */
    if (typeof U._nativeVersionCode === 'number' && U._nativeVersionCode > 0) {
      return U._nativeVersionCode
    }
    /* A web build has no versionCode — the concept only exists in the
       Android package. Fall back to a derived value with the same
       major*1e6+minor*1e3+patch scheme the Gradle build uses, so the
       comparison with the server's versionCode stays meaningful. */
    var m = String(Aevion.version || '0.0.0').match(/^(\d+)\.(\d+)\.(\d+)$/)
    if (!m) return 0
    return parseInt(m[1], 10) * 1000000 + parseInt(m[2], 10) * 1000 + parseInt(m[3], 10)
  }

  /* Ask the native bridge, once at boot, for the real package
     versionCode/versionName and cache it. Fire-and-forget: if the
     bridge is missing (plain web) this resolves to nothing and the
     derived number above keeps answering. */
  U.initNative = function () {
    try {
      var cap = window.Capacitor
      var plugin = cap && cap.Plugins && cap.Plugins.Update
      if (!plugin || typeof plugin.meta !== 'function') return Promise.resolve(null)
      return plugin.meta().then(function (m) {
        if (m && typeof m.versionCode === 'number' && m.versionCode > 0) {
          U._nativeVersionCode = m.versionCode
          U._nativeVersionName = m.versionName || ''
        }
        return m || null
      }).catch(function () { return null })
    } catch (e) { return Promise.resolve(null) }
  }

  /* ---------- host platform ---------- */

  U.isAndroid = function () {
    if (typeof window === 'undefined' || !window.Capacitor) return false
    if (typeof window.Capacitor.isNativePlatform === 'function') {
      try { return !!window.Capacitor.isNativePlatform() } catch (e) { return false }
    }
    /* Without the native bridge the app is running as a plain web page.
       That page cannot install anything, so it is not "Android" from
       the update-install perspective even if the browser is on a
       Android phone. */
    return false
  }

  /* ---------- checksum over raw bytes ---------- */

  U.sha256Hex = async function (bytes) {
    var buf = (bytes instanceof Uint8Array) ? bytes.buffer : bytes
    var b = await crypto.subtle.digest('SHA-256', buf)
    return Array.prototype.map.call(new Uint8Array(b), function (x) {
      return ('0' + x.toString(16)).slice(-2)
    }).join('')
  }

  /* ---------- read the server manifest ---------- */

  U.readManifest = async function (url) {
    url = url || getSetting(U.updateUrlKey) || DEFAULT_UPDATE_URL
    var resp = await fetch(url, { mode: 'cors', cache: 'no-store' })
    if (!resp.ok) throw new Error('The update server returned ' + resp.status + (resp.statusText ? ' (' + resp.statusText + ')' : ''))
    var body = await resp.json()
    if (!body || typeof body !== 'object') throw new Error('update.json is not an object')
    if (typeof body.versionCode !== 'number' || !isFinite(body.versionCode) || body.versionCode <= 0)
      throw new Error('update.json is missing a valid versionCode')
    if (typeof body.versionName !== 'string' || !body.versionName) body.versionName = '?.?.?'
    if (typeof body.downloadUrl !== 'string' || !/^https:\/\//i.test(body.downloadUrl))
      throw new Error('update.json is missing a valid https downloadUrl')
    if (typeof body.fileSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.fileSha256))
      throw new Error('update.json is missing a valid fileSha256 (64 hex chars)')

    /* Both of these are optional, and both are decisions the publisher
       makes, not the app: 'mandatory' forces it, 'minVersionCode' is the
       oldest build that is still supported at all. A malformed value is
       treated as absent rather than fatal — a typo in one field must not
       take the whole update channel down. */
    body.mandatory = body.mandatory === true
    body.minVersionCode = (typeof body.minVersionCode === 'number'
      && isFinite(body.minVersionCode) && body.minVersionCode >= 0)
      ? Math.floor(body.minVersionCode) : 0
    return body
  }

  /* ---------- what the server says compared with this install ---------- */

  U.latest = async function (url) {
    var remote = await U.readManifest(url)
    var current = U.currentVersionCode()
    var newer = remote.versionCode > current
    var older = remote.versionCode < current
    /* Mandatory when the publisher said so, or when this install has fallen
       below the floor they support. Two independent claims, either is
       enough — and the floor cannot be talked away by a "Later" tap. */
    var belowFloor = remote.minVersionCode > 0 && current < remote.minVersionCode
    var mandatory = newer && (remote.mandatory === true || belowFloor)
    return {
      currentVersionName: U._nativeVersionName || U.currentVersionName(),
      currentVersionCode: current,
      remote: remote,
      isNewer: newer,
      isOlder: older,
      isSame: !newer && !older,
      mandatory: mandatory,
      belowFloor: belowFloor,
      minVersionCode: remote.minVersionCode,
      /* An install is only ever offered for a *newer* version that
         carries both a download URL and a checksum — an "update" that
         is missing either is a manifest mistake, not an offer. */
      canInstall: newer && U.isAndroid() && !!remote.downloadUrl && !!remote.fileSha256
    }
  }

  /* ---------- the check (called on boot and on demand) ---------- */

  /* Rate limit: never more than once per 6 hours, and only when the
     device is actually online — a check with no internet is just a
     wasted request and a false "up to date". The Settings button
     passes {force:true} — a person who tapped "check" asked for a
     check, not for a lecture about rate limits. */
  U.canCheck = function () {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false
    var last = getSetting(U.lastCheckedKey, 0)
    if (last && Date.now() - last < CHECK_INTERVAL_MS) return false
    return true
  }

  /* The check itself. Returns one of:
       { state: 'up-to-date', latest }
       { state: 'newer-available', latest }
       { state: 'offline', reason }
       { state: 'rate-limited', reason }
       { state: 'error', error }
     The caller (boot sequence / the Settings button) decides what to
     show. Nothing here ever installs; only installApk can, and it
     demands its own consent. */
  U.checkForUpdate = async function (opts) {
    var o = opts || {}
    var quiet = !!o.quiet
    var force = !!o.force
    var url0 = (o && typeof o.updateUrl === 'string') ? o.updateUrl.trim() : ''
    var url = url0 || getSetting(U.updateUrlKey) || DEFAULT_UPDATE_URL

    if (!force && !U.canCheck()) {
      return { state: 'rate-limited', reason: 'Checked recently — next automatic check is a few hours away. Use the button for an immediate check.' }
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { state: 'offline', reason: 'No internet right now — will check again once it is back.' }
    }

    try {
      var latest = await U.latest(url)
      Aevion.set(U.lastCheckedKey, Date.now())   // only a *completed* check counts
      if (latest.isNewer) {
        /* Remember it so the UI can offer the install later without
           re-fetching, and so the boot report can mention it. */
        Aevion.set(U.pendingKey, {
          versionCode: latest.remote.versionCode,
          versionName: latest.remote.versionName,
          downloadUrl: latest.remote.downloadUrl,
          fileSha256: latest.remote.fileSha256,
          note: typeof latest.remote.note === 'string' ? latest.remote.note : '',
          mandatory: latest.mandatory === true,
          t: Date.now()
        })
        Aevion.emit('update:new-version', latest)
      } else {
        Aevion.set(U.pendingKey, null)   // no stale "new version" badge after the server catches up
      }
      return { state: latest.isNewer ? 'newer-available' : 'up-to-date', latest: latest }
    } catch (e) {
      /* A failed check does NOT stamp lastChecked — the next attempt
         should be allowed rather than locked out for 6 hours. */
      return { state: 'error', error: (e && e.message) || String(e) }
    }
  }

  /* ---------- download the APK (Android only) ---------- */

  /* Downloads the signed APK named by the pending update, verifies its
     SHA-256 against the manifest BEFORE anything else happens, and
     resolves with base64 the native bridge can carry into Java. On the
     web this refuses: a browser tab cannot stash a file and install it
     silently, and pretending otherwise would be a lie. */
  U.downloadApk = async function (opts) {
    if (!U.isAndroid()) throw new Error('Update downloads are only available inside the Aevion Android app — a browser tab cannot install an APK.')
    var pending = getSetting(U.pendingKey, null)
    if (!pending || !pending.downloadUrl || !pending.fileSha256)
      throw new Error('No update is pending — check for a newer version first.')
    /* Offline is its own answer, not a generic "download failed": there is
       nothing wrong with the update, the phone just has no network. */
    if (typeof navigator !== 'undefined' && !navigator.onLine)
      throw new Error('No internet right now — the update will download once the connection is back.')

    var onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null

    var t0 = Date.now()
    var bytes = await new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      xhr.open('GET', pending.downloadUrl, true)
      xhr.responseType = 'arraybuffer'
      xhr.timeout = 7 * 60 * 1000   // 7 minutes — a 5 MB APK can take a while on a slow link

      /* Progress is the difference between a frozen app and a moving bar.
         lengthComputable is false when the server sends no Content-Length,
         in which case the UI is told the bytes but not a percentage. */
      if (onProgress) {
        xhr.addEventListener('progress', function (e) {
          try {
            var total = (e && e.lengthComputable && e.total) ? e.total : 0
            onProgress({
              loaded: (e && e.loaded) || 0,
              total: total,
              percent: total ? Math.min(100, Math.round(((e && e.loaded) || 0) / total * 100)) : null
            })
          } catch (ignore) { /* a progress callback must never break a download */ }
        })
      }

      xhr.addEventListener('load', function () {
        if (xhr.status !== 200) return reject(new Error('Download failed — server returned ' + xhr.status))
        var b = new Uint8Array(xhr.response)
        if (!b || b.byteLength === 0) return reject(new Error('The download came back empty.'))
        if (b.byteLength < 1024) return reject(new Error('The download is far too small to be an APK.'))
        resolve(b)
      })
      xhr.addEventListener('error', function () { reject(new Error('The download failed (network error).')) })
      xhr.addEventListener('timeout', function () { reject(new Error('The download timed out.')) })
      xhr.send()
    })

    /* Verify the published SHA-256 over the raw bytes before anything
       is offered for install. A wrong hash means the download is not
       the file the update manifest described — refuse, loudly. */
    var sha = await U.sha256Hex(bytes)
    if (sha !== String(pending.fileSha256).toLowerCase()) {
      throw new Error('The downloaded file does not match the published checksum — refusing to install it.')
    }

    /* base64 is the shape that survives the JS→Java bridge; a File
       object would not. The native side re-verifies the digest over
       the bytes it actually receives before writing any of them. */
    var binary = ''
    var CHUNK = 0x8000
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    var base64 = btoa(binary)

    return {
      base64: base64,
      expectedSha256: sha,
      versionCode: pending.versionCode,
      versionName: pending.versionName,
      sizeBytes: bytes.byteLength,
      downloadedIn_ms: Date.now() - t0
    }
  }

  /* ---------- install the update (Android only, user-approved) ---------- */

  /* Hands the verified APK to the native UpdatePlugin, which re-checks
     the checksum in Java, builds a PackageInstaller session, and asks
     the user to confirm in the system dialog — exactly the shape an
     app-store update takes. The same signature must sign both old and
     new versions, which is Android's own guarantee that this replaces
     the app without touching its data. */
  U.installApk = async function (opts) {
    if (!U.isAndroid()) {
      return { ok: false, code: 'unavailable', reason: 'Installing an update is only possible inside the Aevion Android app — a browser tab cannot install an APK.' }
    }
    var o = opts || {}
    if (o.consent !== true) {
      return { ok: false, code: 'consent', reason: 'Installing an update needs your approval — it is always a confirm-tier action. No install ever happens without a yes from you.' }
    }
    if (!Aevion.evolve || typeof Aevion.evolve.on !== 'function' || !Aevion.evolve.on()) {
      return { ok: false, code: 'off', reason: 'Self-upgrade is switched off — turn it on in Settings → Self-upgrade first. Safety is always allowed.' }
    }

    var download
    try { download = await U.downloadApk({ onProgress: o.onProgress }) } catch (e) {
      return { ok: false, code: 'download', reason: (e && e.message) || String(e) }
    }

    var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Update
    if (!plugin || typeof plugin.install !== 'function') {
      return { ok: false, code: 'unavailable', reason: 'The native update bridge is not available in this build — reinstall the app to update it.' }
    }

    var r
    try {
      r = await plugin.install({
        base64: download.base64,
        expectedSha256: download.expectedSha256,
        /* The version the manifest promised. The native side compares it with
           what the file itself says, so a swapped download cannot pass as the
           release it claims to be. */
        expectedVersionCode: download.versionCode,
        sizeBytes: download.sizeBytes,
        allowDowngrade: false
      })
    } catch (e) {
      return { ok: false, code: 'install', reason: (e && e.message) || String(e) }
    }

    if (r && r.ok) {
      Aevion.set(U.pendingKey, null)
      Aevion.emit('update:installed', { versionCode: download.versionCode, versionName: download.versionName })
      return { ok: true, versionCode: download.versionCode, versionName: download.versionName }
    }
    /* The native side names what was wrong. Its words are better than
       anything invented here, so pass its reason through — only the code
       is remapped, for callers that branch on it. */
    var code = (r && r.code) ? r.code : 'install-rejected'
    return { ok: false, code: code, reason: (r && r.reason) || 'The install was not accepted.' }
  }

  /* ---------- the "Later" button ---------- */

  /* A day of quiet, not a dismissal: the offer comes back tomorrow, and a
     pending install can never be deferred away when the publisher marked it
     mandatory (or when this build is below the supported floor). */
  U.deferLater = function () {
    if (U.isMandatory()) return { ok: false, reason: 'This update is required — there is nothing to postpone.' }
    U.deferUntil(LATER_MS)
    return { ok: true, until: Date.now() + LATER_MS }
  }

  U.isMandatory = function () {
    var pending = getSetting(U.pendingKey, null)
    return !!(pending && pending.mandatory === true)
  }

  /* ---------- deferred reminder ---------- */

  U.deferUntil = function (ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) throw new Error('deferUntil needs a positive number of milliseconds')
    Aevion.set(U.deferredKey, Date.now() + ms)
  }

  U.isDeferred = function () {
    var at = getSetting(U.deferredKey, 0)
    if (!at || typeof at !== 'number') return false
    if (Date.now() >= at) { Aevion.set(U.deferredKey, null); return false }
    return true
  }

  /* ---------- the automatic check (boot, resume, and a slow heartbeat) ---------- */

  /* "Check for updates when appropriate" has three moments that matter, and
     this wires all three:

       1. boot            — once, quietly, already done by the app
       2. coming back     — a phone app is backgrounded and resumed constantly,
                            and that resume is exactly when a user will notice
                            a stale build
       3. every half hour — while the app is genuinely open, look again, which
                            is how a new release reaches someone who leaves the
                            app running

     Both (2) and (3) go through checkForUpdate, which keeps its own 6-hour
     floor, refuses to run offline, and never installs anything. A person who
     deferred the offer is respected: the check still runs, but nothing is
     pushed at them until the deferral expires. Returns a stop() function. */
  U.startAutoCheck = function (opts) {
    var o = opts || {}
    var timer = null
    var stopped = false

    function tick(why) {
      if (stopped) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && why === 'heartbeat') return
      U.checkForUpdate({ quiet: true }).then(function (r) {
        /* Only surface something when there is genuinely something to
           surface and the user is not in a timed-out mode. */
        if (r && r.state === 'newer-available' && typeof o.onNewer === 'function') {
          if (!U.isDeferred()) o.onNewer(r.latest)
        }
      }).catch(function () { /* an automatic check that fails is not news */ })
    }

    function onVisible() {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'visible') tick('resume')
    }

    tick('boot')
    timer = setInterval(function () { tick('heartbeat') }, AUTO_REPEAT_MS)
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onVisible)
    }

    return function stop() {
      stopped = true
      if (timer) clearInterval(timer)
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }

  /* ---------- report (for boot chat + the automation report) ---------- */

  U.report = function () {
    var pending = getSetting(U.pendingKey, null)
    return {
      canCheck: U.canCheck(),
      isAndroid: U.isAndroid(),
      currentVersionName: U._nativeVersionName || U.currentVersionName(),
      currentVersionCode: U.currentVersionCode(),
      updateUrl: getSetting(U.updateUrlKey, '') || DEFAULT_UPDATE_URL,
      pending: pending ? {
        versionCode: pending.versionCode,
        versionName: pending.versionName,
        note: pending.note || '',
        mandatory: pending.mandatory === true
      } : null,
      deferred: U.isDeferred(),
      mandatory: U.isMandatory()
    }
  }

  /* ---------- wire into Aevion ---------- */

  Aevion.update = U
})()
