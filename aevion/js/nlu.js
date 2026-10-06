/* ============================================================
 * Aevion NLU — the offline brain's ear for other languages.
 *
 * The problem this solves: brain.js matches English keywords, so a
 * Kannada "ಟೈಮರ್ 5 ನಿಮಿಷ" fell through to open chat and needed an AI
 * provider. The basic commands — time, date, greetings, thanks,
 * jokes, notes, tasks, timers, math — should not need the internet
 * in any language.
 *
 * How it works:
 *   1. Normalize — every script's own digits become 0-9, so "೨+೨",
 *      "२+२" and "2+2" are the same sum.
 *   2. Detect the script. A Devanagari sentence is Hindi, Marathi or
 *      Nepali; the word tables then decide which.
 *   3. Score the words. Each language has a short list per intent
 *      ("time", "joke", "timer"…). Two or three real words are enough
 *      to recognize an intent in a language nobody taught the app.
 *   4. Fall back — an unrecognized sentence returns null and brain.js
 *      answers it exactly as before, so English behaviour is
 *      untouched and adding a language can never break another one.
 *
 * Adding a language is additive by design:
 *   Aevion.nlu.teach('kn', 'timer', ['ಸಮಯ ಮಾಪಕ', 'ಟೈಮರ್ ಹಾಕು'])
 * stores the words on this device and they are matched from then on;
 * `Aevion.nlu.addWords` does the same for a shipped pack. A language
 * that is only half-covered still works for the intents it has.
 *
 * Nothing here talks to the network.
 * ============================================================ */
(function () {
  const N = {};

  /* ---------- 1. digits ----------
     Every block below is a set of ten consecutive code points whose
     first character is that script's zero. Folding them to ASCII is
     what makes arithmetic work in any language. */
  const ZEROES = [
    0x0030, // ASCII
    0x0660, // Arabic-Indic
    0x06F0, // Extended Arabic-Indic (Persian/Urdu)
    0x0966, // Devanagari
    0x09E6, // Bengali
    0x0A66, // Gurmukhi
    0x0A8E, // Gujarati
    0x0B66, // Oriya
    0x0BE6, // Tamil
    0x0C66, // Telugu
    0x0CE6, // Kannada
    0x0D66, // Malayalam
    0x0E50, // Thai
    0x0ED0, // Lao
    0x0F20, // Tibetan
    0x1040, // Myanmar
    0x17E0, // Khmer
    0x1946, // Limbu
    0x1B50, // Balinese
    0x1C40, // Lepcha
    0xA8D0, // Saurashtra
    0xA900, // Kayah Li
    0xA9D0, // Javanese
    0xFF10  // Fullwidth
  ];

  N.digits = function (text) {
    let out = '';
    for (const ch of String(text == null ? '' : text)) {
      const c = ch.codePointAt(0);
      let mapped = ch;
      for (const z of ZEROES) {
        if (c >= z && c <= z + 9) { mapped = String.fromCharCode(48 + (c - z)); break; }
      }
      out += mapped;
    }
    return out;
  };

  /* ---------- 2. scripts ----------
     Ordered most-specific first. `langs` are the candidates a script
     can mean; the word tables pick the winner. Latin is deliberately
     absent: it is the fallback and its words are matched last. */
  const SCRIPTS = [
    { name: 'Kannada', langs: ['kn'], re: /[\u0C80-\u0CFF]/ },
    { name: 'Tamil', langs: ['ta'], re: /[\u0B80-\u0BFF]/ },
    { name: 'Telugu', langs: ['te'], re: /[\u0C00-\u0C7F]/ },
    { name: 'Malayalam', langs: ['ml'], re: /[\u0D00-\u0D7F]/ },
    { name: 'Sinhala', langs: ['si'], re: /[\u0D80-\u0DFF]/ },
    { name: 'Bengali', langs: ['bn', 'as'], re: /[\u0980-\u09FF]/ },
    { name: 'Gujarati', langs: ['gu'], re: /[\u0A80-\u0AFF]/ },
    { name: 'Gurmukhi', langs: ['pa'], re: /[\u0A00-\u0A7F]/ },
    { name: 'Odia', langs: ['or'], re: /[\u0B00-\u0B7F]/ },
    { name: 'Devanagari', langs: ['hi', 'mr', 'ne'], re: /[\u0900-\u097F]/ },
    { name: 'Arabic', langs: ['ar', 'ur', 'fa'], re: /[\u0600-\u06FF\u0750-\u077F]/ },
    { name: 'Hebrew', langs: ['he'], re: /[\u0590-\u05FF]/ },
    { name: 'Greek', langs: ['el'], re: /[\u0370-\u03FF\u1F00-\u1FFF]/ },
    { name: 'Cyrillic', langs: ['ru', 'uk'], re: /[\u0400-\u04FF]/ },
    { name: 'Armenian', langs: ['hy'], re: /[\u0530-\u058F]/ },
    { name: 'Georgian', langs: ['ka'], re: /[\u10A0-\u10FF]/ },
    { name: 'Ethiopic', langs: ['am'], re: /[\u1200-\u137F]/ },
    { name: 'Thai', langs: ['th'], re: /[\u0E00-\u0E7F]/ },
    { name: 'Lao', langs: ['lo'], re: /[\u0E80-\u0EFF]/ },
    { name: 'Myanmar', langs: ['my'], re: /[\u1000-\u109F]/ },
    { name: 'Khmer', langs: ['km'], re: /[\u1780-\u17FF]/ },
    { name: 'Hangul', langs: ['ko'], re: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/ },
    { name: 'Japanese', langs: ['ja'], re: /[\u3040-\u30FF]/ },
    { name: 'Chinese', langs: ['zh'], re: /[\u3400-\u9FFF]/ }
  ];

  /* Which languages a piece of text could be, from its characters. */
  N.scripts = function (text) {
    const t = String(text == null ? '' : text);
    return SCRIPTS.filter(s => s.re.test(t)).map(s => s.name);
  };

  N.detect = function (text) {
    const t = String(text == null ? '' : text);
    for (const s of SCRIPTS) if (s.re.test(t)) return { lang: s.langs[0], script: s.name, langs: s.langs.slice() };
    return { lang: null, script: 'Latin', langs: [] };
  };

  /* ---------- 3. the word tables ----------
     One short list per intent. These are the words a person actually
     says, not translations of the English ones — "how much" and
     "compute" both land on math, and a single-word "time?" works. */
  const W = {};

  /* Hindi / Urdu / Marathi / Nepali */
  W.hi = {
    help: ['मदद', 'सहायता'], clear: ['साफ करो', 'साफ़ करो', 'चैट मिटाओ'], languages: ['भाषाएँ', 'भाषाओं की सूची'],
    time: ['समय', 'टाइम', 'कितने बजे', 'बजे'],
    date: ['आज की तारीख', 'तारीख', 'दिनांक'],
    greet: ['नमस्ते', 'नमस्कार', 'हैलो', 'हेलो'],
    thanks: ['धन्यवाद', 'शुक्रिया', 'थैंक'],
    whoami: ['तुम कौन', 'आप कौन', 'तुम्हारा नाम'],
    features: ['क्या कर सकती', 'क्या कर सकते', 'क्या-क्या कर'],
    recall: ['मेरे बारे में क्या याद', 'क्या याद है'],
    remember: ['याद रखो', 'याद रखना', 'नोट कर लो'],
    task: ['काम जोड़ो', 'टास्क जोड़ो', 'काम जोड़ें'],
    tasks: ['मेरे काम', 'मेरे टास्क', 'काम दिखाओ'],
    note: ['नोट', 'लिख लो', 'नोट करो'],
    status: ['सिस्टम स्थिति', 'स्थिति', 'स्टेटस'],
    setname: ['मेरा नाम', 'मुझे बुलाओ'],
    translate: ['अनुवाद', 'तरजुमा'],
    math: ['कितना होता', 'हिसाब', 'गणना', 'जोड़', 'कितने होते'],
    search: ['खोजो', 'खोज', 'सर्च'],
    joke: ['चुटकुला', 'जोक', 'हँसाओ', 'मजाक'],
    coin: ['सिक्का', 'टॉस'],
    dice: ['पासा'],
    weather: ['मौसम', 'गर्मी', 'बारिश'],
    timer: ['टाइमर', 'अलार्म', 'समय मापक'],
    timerlist: ['टाइमर दिखाओ', 'कौन से टाइमर'],
    timerstop: ['टाइमर बंद', 'टाइमर हटाओ'],
    'open-site': ['खोलो'],
    privacy: ['गोपनीयता', 'डेटा', 'प्राइवेसी']
  };
  W.mr = {
    help: ['मदत'], clear: ['साफ करा'], time: ['वेळ', 'किती वाजले'], date: ['तारीख', 'आजची तारीख'],
    greet: ['नमस्कार', 'हॅलो'], thanks: ['धन्यवाद', 'आभारी'], joke: ['विनोद', 'हसवा'],
    note: ['नोंद', 'लिहून ठेव'], tasks: ['माझी कामे'], timer: ['टाइमर'], math: ['किती होते', 'बेरीज'],
    whoami: ['तू कोण'], weather: ['हवामान'], search: ['शोध']
  };
  W.ur = {
    help: ['مدد'], time: ['وقت', 'کتنے بجے'], date: ['تاریخ', 'آج کی تاریخ'],
    greet: ['سلام', 'السلام علیکم', 'ہیلو'], thanks: ['شکریہ'], joke: ['لطیفہ', 'ہنسا دو'],
    note: ['نوٹ'], tasks: ['میرے کام'], timer: ['ٹائمر'], math: ['کتنے ہوتے', 'حساب'],
    weather: ['موسم'], search: ['تلاش']
  };
  W.ne = {
    help: ['मद्दत'], time: ['समय', 'कति बजे'], date: ['मिति', 'आजको मिति'],
    greet: ['नमस्ते', 'नमस्कार'], thanks: ['धन्यवाद'], joke: ['जोक', 'हसाउने'],
    note: ['नोट'], tasks: ['मेरा काम'], timer: ['टाइमर'], math: ['कति हुन्छ']
  };

  /* Tamil */
  W.ta = {
    help: ['உதவி'], clear: ['அழி', 'காலி செய்'], languages: ['மொழிகள்'],
    time: ['நேரம்', 'மணி என்ன', 'மணி'],
    date: ['தேதி', 'இன்றைய தேதி'],
    greet: ['வணக்கம்', 'ஹலோ', 'ஹாய்'],
    thanks: ['நன்றி', 'நன்றிகள்'],
    whoami: ['நீ யார்', 'உன் பெயர்'],
    features: ['என்ன செய்ய', 'என்னென்ன செய்ய'],
    recall: ['என்ன நினைவிருக்கிறது', 'என்னைப் பற்றி'],
    remember: ['நினைவில் வை', 'நினைவு வை'],
    task: ['பணி சேர்', 'வேலை சேர்'],
    tasks: ['என் பணிகள்', 'பணிகள் காட்டு'],
    note: ['குறிப்பு', 'எழுதி வை'],
    status: ['நிலை', 'நிலைமை'],
    setname: ['என் பெயர்', 'என்னை அழை'],
    translate: ['மொழிபெயர்', 'மொழிபெயர்ப்பு'],
    math: ['எவ்வளவு', 'கணக்கு', 'கூட்டு'],
    search: ['தேடு', 'தேடல்'],
    joke: ['நகைச்சுவை', 'ஜோக்', 'சிரிக்க வை'],
    coin: ['நாணயம்'],
    dice: ['பகடை'],
    weather: ['வானிலை', 'மழை'],
    timer: ['டைமர்', 'நேரம் அமை'],
    timerlist: ['டைமர் காட்டு'],
    timerstop: ['டைமர் நிறுத்து'],
    'open-site': ['திற'],
    privacy: ['தனியுரிமை', 'தரவு']
  };

  /* Telugu */
  W.te = {
    help: ['సహాయం'], clear: ['శుభ్రం చేయి', 'చాట్ తొలగించు'], languages: ['భాషలు'],
    time: ['సమయం', 'టైమ్', 'ఎన్ని గంటలు'],
    date: ['తేదీ', 'నేటి తేదీ'],
    greet: ['నమస్కారం', 'హలో', 'హాయ్'],
    thanks: ['ధన్యవాదాలు', 'థాంక్స్'],
    whoami: ['నువ్వు ఎవరు', 'నీ పేరు'],
    features: ['ఏం చేయగల', 'ఏమేమి చేయగల'],
    recall: ['నా గురించి', 'ఏం గుర్తుంది'],
    remember: ['గుర్తు పెట్టుకో', 'గుర్తు ఉంచు'],
    task: ['పని జోడించు', 'టాస్క్ జోడించు'],
    tasks: ['నా పనులు', 'పనులు చూపించు'],
    note: ['నోట్', 'రాసి పెట్టు'],
    status: ['స్థితి', 'స్టేటస్'],
    setname: ['నా పేరు', 'నన్ను పిలువు'],
    translate: ['అనువాదం', 'అనువదించు'],
    math: ['ఎంత', 'లెక్క', 'కూడు'],
    search: ['వెతుకు', 'శోధించు'],
    joke: ['జోక్', 'నవ్వించు', 'హాస్యం'],
    coin: ['నాణెం'],
    dice: ['పాచిక'],
    weather: ['వాతావరణం', 'వర్షం'],
    timer: ['టైమర్', 'సమయం పెట్టు'],
    timerlist: ['టైమర్లు చూపించు'],
    timerstop: ['టైమర్ ఆపు'],
    'open-site': ['తెరువు'],
    privacy: ['గోప్యత', 'డేటా']
  };

  /* Kannada */
  W.kn = {
    help: ['ಸಹಾಯ'], clear: ['ಅಳಿಸು', 'ಚಾಟ್ ಅಳಿಸು'], languages: ['ಭಾಷೆಗಳು'],
    time: ['ಸಮಯ', 'ಟೈಮ್', 'ಎಷ್ಟು ಗಂಟೆ'],
    date: ['ದಿನಾಂಕ', 'ಇಂದಿನ ದಿನಾಂಕ', 'ತಾರೀಖು'],
    greet: ['ನಮಸ್ಕಾರ', 'ಹಲೋ', 'ಹಾಯ್'],
    thanks: ['ಧನ್ಯವಾದ', 'ಥ್ಯಾಂಕ್ಸ್'],
    whoami: ['ನೀನು ಯಾರು', 'ನಿನ್ನ ಹೆಸರು'],
    features: ['ಏನು ಮಾಡಬಲ್ಲೆ', 'ಏನೇನು ಮಾಡ'],
    recall: ['ನನ್ನ ಬಗ್ಗೆ', 'ಏನು ನೆನಪಿದೆ'],
    remember: ['ನೆನಪಿಟ್ಟುಕೊ', 'ನೆನಪಿನಲ್ಲಿ ಇಟ್ಟುಕೊ'],
    task: ['ಕೆಲಸ ಸೇರಿಸು', 'ಟಾಸ್ಕ್ ಸೇರಿಸು'],
    tasks: ['ನನ್ನ ಕೆಲಸಗಳು', 'ಕೆಲಸಗಳನ್ನು ತೋರಿಸು'],
    note: ['ಟಿಪ್ಪಣಿ', 'ನೋಟ್', 'ಬರೆದಿಟ್ಟುಕೊ'],
    status: ['ಸ್ಥಿತಿ', 'ಸ್ಟೇಟಸ್'],
    setname: ['ನನ್ನ ಹೆಸರು', 'ನನ್ನನ್ನು ಕರೆ'],
    translate: ['ಅನುವಾದ', 'ಭಾಷಾಂತರ'],
    math: ['ಎಷ್ಟು', 'ಲೆಕ್ಕ', 'ಗಣನೆ', 'ಕೂಡು'],
    search: ['ಹುಡುಕು', 'ಶೋಧಿಸು'],
    joke: ['ಜೋಕ್', 'ನಗಿಸು', 'ಹಾಸ್ಯ'],
    coin: ['ನಾಣ್ಯ'],
    dice: ['ದಾಳ'],
    weather: ['ಹವಾಮಾನ', 'ಮಳೆ'],
    timer: ['ಟೈಮರ್', 'ಟೈಮ್ ಸೆಟ್ ಮಾಡು'],
    timerlist: ['ಟೈಮರ್ ತೋರಿಸು'],
    timerstop: ['ಟೈಮರ್ ನಿಲ್ಲಿಸು'],
    'open-site': ['ತೆರೆ'],
    privacy: ['ಗೌಪ್ಯತೆ', 'ಮಾಹಿತಿ']
  };

  /* Malayalam / Bengali / Gujarati / Punjabi / Odia / Sinhala */
  W.ml = {
    help: ['സഹായം'], time: ['സമയം', 'മണി എത്ര'], date: ['തീയതി', 'ഇന്നത്തെ തീയതി'],
    greet: ['നമസ്കാരം', 'ഹലോ'], thanks: ['നന്ദി'], joke: ['തമാശ', 'ചിരിപ്പിക്കൂ'],
    note: ['കുറിപ്പ്'], tasks: ['എന്റെ ജോലികൾ'], timer: ['ടൈമർ'], math: ['എത്ര', 'കണക്ക്'],
    whoami: ['നീ ആരാണ്'], weather: ['കാലാവസ്ഥ'], search: ['തിരയൂ'], remember: ['ഓർത്തു വെക്കൂ']
  };
  W.bn = {
    help: ['সাহায্য'], time: ['সময়', 'কতটা বাজে'], date: ['তারিখ', 'আজকের তারিখ'],
    greet: ['নমস্কার', 'হ্যালো'], thanks: ['ধন্যবাদ'], joke: ['কৌতুক', 'হাসাও'],
    note: ['নোট'], tasks: ['আমার কাজ'], timer: ['টাইমার'], math: ['কত হয়', 'হিসাব'],
    whoami: ['তুমি কে'], weather: ['আবহাওয়া'], search: ['খোঁজো'], remember: ['মনে রাখো']
  };
  W.gu = {
    help: ['મદદ'], time: ['સમય', 'કેટલા વાગ્યા'], date: ['તારીખ'], greet: ['નમસ્તે', 'હેલો'],
    thanks: ['આભાર'], joke: ['જોક'], note: ['નોંધ'], tasks: ['મારા કામ'], timer: ['ટાઈમર'],
    math: ['કેટલું થાય'], weather: ['હવામાન']
  };
  W.pa = {
    help: ['ਮਦਦ'], time: ['ਸਮਾਂ', 'ਕੀਨੇ ਵਜੇ'], date: ['ਤਾਰੀਖ'], greet: ['ਸਤ ਸ੍ਰੀ ਅਕਾਲ', 'ਹੈਲੋ'],
    thanks: ['ਧੰਨਵਾਦ'], joke: ['ਚੁਟਕਲਾ'], note: ['ਨੋਟ'], tasks: ['ਮੇਰੇ ਕੰਮ'], timer: ['ਟਾਈਮਰ']
  };
  W.or = { help: ['ସହାୟତା'], time: ['ସମୟ'], date: ['ତାରିଖ'], greet: ['ନମସ୍କାର'], thanks: ['ଧନ୍ୟବାଦ'], joke: ['ଥଟ୍ଟା'], timer: ['ଟାଇମର'] };
  W.si = {
    help: ['උදව්'], time: ['වේලාව', 'කීයද'], date: ['දිනය'], greet: ['ආයුබෝවන්'],
    thanks: ['ස්තූතියි'], joke: ['විහිළුව'], note: ['සටහන'], timer: ['ටයිමර්'], math: ['කොච්චරද']
  };
  W.as = { help: ['সহায়'], time: ['সময়'], date: ['তাৰিখ'], greet: ['নমস্কাৰ'], thanks: ['ধন্যবাদ'], joke: ['হাঁহি'], timer: ['টাইমাৰ'] };

  /* Right-to-left and other non-Latin */
  W.ar = {
    help: ['مساعدة'], time: ['الوقت', 'كم الساعة'], date: ['التاريخ', 'تاريخ اليوم'],
    greet: ['مرحبا', 'السلام عليكم', 'أهلا'], thanks: ['شكرا', 'شكرًا'],
    joke: ['نكتة', 'ضحكني'], note: ['ملاحظة'], tasks: ['مهامي'], timer: ['مؤقت'],
    math: ['كم يساوي', 'حساب'], weather: ['الطقس'], search: ['ابحث'], remember: ['تذكر'],
    whoami: ['من أنت']
  };
  W.fa = {
    help: ['کمک'], time: ['ساعت', 'ساعت چند'], date: ['تاریخ'], greet: ['سلام', 'درود'],
    thanks: ['ممنون', 'متشکرم'], joke: ['لطیفه'], note: ['یادداشت'], timer: ['تایمر'], math: ['چند']
  };
  W.he = { help: ['עזרה'], time: ['שעה', 'מה השעה'], date: ['תאריך'], greet: ['שלום'], thanks: ['תודה'], joke: ['בדיחה'], timer: ['טיימר'] };
  W.ru = {
    help: ['помощь'], clear: ['очистить'], time: ['время', 'который час'], date: ['дата', 'сегодняшняя дата'],
    greet: ['привет', 'здравствуй', 'здравствуйте'], thanks: ['спасибо'], joke: ['шутка', 'анекдот', 'рассмеши'],
    note: ['заметка', 'запиши'], tasks: ['мои задачи'], timer: ['таймер'], math: ['сколько', 'посчитай'],
    weather: ['погода'], search: ['найди'], remember: ['запомни'], whoami: ['кто ты']
  };
  W.uk = { help: ['допомога'], time: ['час', 'котра година'], date: ['дата'], greet: ['привіт'], thanks: ['дякую'], joke: ['жарт'], timer: ['таймер'] };
  W.el = { help: ['βοήθεια'], time: ['ώρα', 'τι ώρα'], date: ['ημερομηνία'], greet: ['γεια'], thanks: ['ευχαριστώ'], joke: ['ανέκδοτο'], timer: ['χρονόμετρο'] };
  W.th = {
    help: ['ช่วย'], time: ['เวลา', 'กี่โมง'], date: ['วันที่'], greet: ['สวัสดี'], thanks: ['ขอบคุณ'],
    joke: ['ตลก', 'เรื่องขำ'], note: ['บันทึก'], timer: ['ตัวจับเวลา'], math: ['เท่าไหร่']
  };
  W.zh = {
    help: ['帮助'], time: ['几点', '时间'], date: ['日期', '今天几号'], greet: ['你好', '您好'],
    thanks: ['谢谢'], joke: ['笑话', '讲个笑话'], note: ['笔记'], tasks: ['我的任务'],
    timer: ['计时器', '定时'], math: ['等于多少', '计算'], weather: ['天气'], search: ['搜索']
  };
  W.ja = {
    help: ['助けて', 'ヘルプ'], time: ['時間', '何時'], date: ['日付'], greet: ['こんにちは', 'やあ'],
    thanks: ['ありがとう'], joke: ['ジョーク', '笑わせて'], note: ['メモ'], timer: ['タイマー'],
    math: ['いくつ', '計算'], weather: ['天気'], search: ['検索']
  };
  W.ko = {
    help: ['도움'], time: ['시간', '몇 시'], date: ['날짜'], greet: ['안녕', '안녕하세요'],
    thanks: ['고마워', '감사'], joke: ['농담'], note: ['메모'], timer: ['타이머'], math: ['얼마', '계산']
  };
  W.vi = { help: ['giúp'], time: ['mấy giờ', 'thời gian'], date: ['ngày'], greet: ['xin chào'], thanks: ['cảm ơn'], joke: ['truyện cười'], timer: ['hẹn giờ'] };
  W.my = { help: ['အကူအညီ'], time: ['အချိန်'], greet: ['မင်္ဂလာပါ'], thanks: ['ကျေးဇူး'], joke: ['ဟာသ'] };
  W.km = { help: ['ជំនួយ'], time: ['ម៉ោង'], greet: ['សួស្តី'], thanks: ['អរគុណ'], joke: ['រឿងកំប្លែង'] };
  W.lo = { help: ['ຊ່ວຍ'], time: ['ເວລາ'], greet: ['ສະບາຍດີ'], thanks: ['ຂອບໃຈ'], joke: ['ເລື່ອງຕະຫຼົກ'] };
  W.hy = { help: ['օգնություն'], time: ['ժամ'], greet: ['բարև'], thanks: ['շնորհակալություն'], joke: ['կատակ'] };
  W.ka = { help: ['დახმარება'], time: ['დრო'], greet: ['გამარჯობა'], thanks: ['მადლობა'], joke: ['ხუმრობა'] };
  W.am = { help: ['እርዳታ'], time: ['ሰዓት'], greet: ['ሰላም'], thanks: ['አመሰግናለሁ'], joke: ['ቀልድ'] };

  /* Latin-script languages. These are recognised when the app language is
     set to them (the picker in Settings), because a script cannot tell
     Spanish from English — and a shared alphabet is exactly where keyword
     guesses go wrong. Non-Latin scripts below need no such hint. */
  W.es = {
    help: ['ayuda'], clear: ['limpiar'], time: ['hora', 'qué hora'], date: ['fecha'],
    greet: ['hola', 'buenas'], thanks: ['gracias'], joke: ['chiste', 'broma'],
    note: ['nota', 'apunta'], tasks: ['mis tareas'], timer: ['temporizador', 'alarma'],
    math: ['cuánto', 'calcular', 'suma'], weather: ['clima', 'tiempo hace'],
    search: ['busca', 'buscar'], remember: ['recuerda'], whoami: ['quién eres']
  };
  W.fr = {
    help: ['aide'], clear: ['effacer'], time: ['heure', 'quelle heure'], date: ['date'],
    greet: ['bonjour', 'salut'], thanks: ['merci'], joke: ['blague'],
    note: ['note', 'noter'], tasks: ['mes tâches'], timer: ['minuteur', 'alarme'],
    math: ['combien', 'calculer'], weather: ['météo'], search: ['cherche'], remember: ['souviens']
  };
  W.de = {
    help: ['hilfe'], clear: ['löschen'], time: ['uhrzeit', 'wie spät'], date: ['datum'],
    greet: ['hallo', 'guten tag'], thanks: ['danke'], joke: ['witz', 'erzähl einen witz'],
    note: ['notiz', 'notiere'], tasks: ['meine aufgaben'], timer: ['timer', 'wecker'],
    math: ['wie viel', 'rechne'], weather: ['wetter'], search: ['suche'], remember: ['merke']
  };
  W.pt = {
    help: ['ajuda'], time: ['horas', 'que horas'], date: ['data'], greet: ['olá', 'bom dia'],
    thanks: ['obrigado', 'obrigada'], joke: ['piada'], note: ['nota', 'anota'], timer: ['temporizador'],
    math: ['quanto', 'calcular'], weather: ['clima'], search: ['buscar']
  };
  W.it = {
    help: ['aiuto'], time: ['ore', 'che ore'], date: ['data'], greet: ['ciao', 'buongiorno'],
    thanks: ['grazie'], joke: ['barzelletta'], note: ['nota'], timer: ['timer'], math: ['quanto']
  };
  W.nl = { help: ['hulp'], time: ['tijd', 'hoe laat'], date: ['datum'], greet: ['hallo', 'hoi'], thanks: ['bedankt', 'dank je'], joke: ['mop'], timer: ['timer'] };
  W.pl = { help: ['pomoc'], time: ['godzina', 'która godzina'], date: ['data dzisiaj', 'dzisiejsza data'], greet: ['cześć', 'witaj'], thanks: ['dziękuję'], joke: ['żart'], timer: ['timer'] };
  W.tr = {
    help: ['yardım'], time: ['saat', 'saat kaç'], date: ['tarih'], greet: ['merhaba', 'selam'],
    thanks: ['teşekkür'], joke: ['şaka', 'fıkra'], note: ['not'], timer: ['zamanlayıcı'],
    math: ['kaç', 'hesapla'], weather: ['hava'], search: ['ara']
  };
  W.id = {
    help: ['bantuan'], time: ['jam berapa', 'waktu'], date: ['tanggal'], greet: ['halo', 'hai'],
    thanks: ['terima kasih'], joke: ['lelucon'], note: ['catatan'], timer: ['pengatur waktu'],
    math: ['berapa', 'hitung'], weather: ['cuaca'], search: ['cari']
  };
  W.ms = { help: ['bantuan'], time: ['pukul berapa'], date: ['tarikh'], greet: ['helo'], thanks: ['terima kasih'], joke: ['jenaka'], timer: ['pemasa'] };
  W.fil = { help: ['tulong'], time: ['anong oras'], date: ['petsa'], greet: ['kumusta', 'hello'], thanks: ['salamat'], joke: ['biro'], timer: ['timer'] };
  W.sw = {
    help: ['msaada'], time: ['saa ngapi', 'muda'], date: ['tarehe'], greet: ['habari', 'jambo'],
    thanks: ['asante'], joke: ['utani', 'kichokoo'], note: ['kumbuka'], timer: ['kihesabu muda'],
    math: ['ngapi', 'hesabu']
  };
  W.ha = { help: ['taimako'], time: ['lokaci'], greet: ['sannu'], thanks: ['na gode'], joke: ['wasa'] };
  W.yo = { help: ['iranwo'], time: ['aago'], greet: ['bawo', 'pele'], thanks: ['o se'], joke: ['awada'] };
  W.zu = { help: ['usizo'], time: ['isikhathi'], greet: ['sawubona'], thanks: ['ngiyabonga'], joke: ['ihlaya'] };
  W.af = { help: ['hulp'], time: ['tyd'], greet: ['hallo'], thanks: ['dankie'], joke: ['grap'], timer: ['tydhouer'] };
  W.ca = { help: ['ajuda'], time: ['quina hora'], date: ['data'], greet: ['hola'], thanks: ['gràcies'], joke: ['acudit'] };
  W.eu = { help: ['laguntza'], time: ['zer ordu'], date: ['data'], greet: ['kaixo'], thanks: ['eskerrik asko'], joke: ['txiste'] };

  /* ---------- units, so "5 minutes" is understood everywhere ---------- */
  N.UNITS = {
    sec: ['second', 'seconds', 'sec', 'secs', 'सेकंड', 'सेकेंड', 'सेकन्ड', 'সেকেন্ড', 'સેકંડ', 'ਸਕਿੰਟ', 'ସେକେଣ୍ଡ', 'செக்கன்', 'సెకను', 'ಸೆಕೆಂಡ್', 'സെക്കൻഡ്', 'තත්පර', 'ثانية', 'ثانیه', 'секунд', 'секунда', 'วินาที', '秒', '초', 'giây', 'segundo', 'sekunde', 'secondes', 'détik'],
    min: ['minute', 'minutes', 'min', 'mins', 'मिनट', 'मिनिट', 'মিনিট', 'મિનિટ', 'ਮਿੰਟ', 'ମିନିଟ', 'நிமிடம்', 'నిమిషం', 'ನಿಮಿಷ', 'മിനിറ്റ്', 'මිනිත්තු', 'دقيقة', 'دقیقه', 'минут', 'นาที', '分', '분', 'phút', 'minuto', 'minuut'],
    hour: ['hour', 'hours', 'hr', 'hrs', 'घंटा', 'घंटे', 'तास', 'ঘন্টা', 'કલાક', 'ਘੰਟਾ', 'ଘଣ୍ଟା', 'மணி நேரம்', 'గంట', 'ಗಂಟೆ', 'മണിക്കൂർ', 'පැය', 'ساعة', 'ساعت', 'час', 'ชั่วโมง', '小时', '時間', '시간', 'giờ', 'hora', 'uur', 'heure', 'stunde']
  };

  /* ---------- number words, one to ten ----------
     Nobody says "2 + 2" out loud in Kannada; they say "ಎರಡು + ಎರಡು".
     The first ten numbers in the languages people actually speak to this
     are enough to make spoken arithmetic work, and folding them into
     digits reuses the whole rest of the pipeline. Only the language in
     play is consulted, so English is never read through a Turkish
     number table. */
  const NUM = {
    kn: ['ಒಂದು', 'ಎರಡು', 'ಮೂರು', 'ನಾಲ್ಕು', 'ಐದು', 'ಆರು', 'ಏಳು', 'ಎಂಟು', 'ಒಂಬತ್ತು', 'ಹತ್ತು'],
    ta: ['ஒன்று', 'இரண்டு', 'மூன்று', 'நான்கு', 'ஐந்து', 'ஆறு', 'ஏழு', 'எட்டு', 'ஒன்பது', 'பத்து'],
    te: ['ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది', 'పది'],
    hi: ['एक', 'दो', 'तीन', 'चार', 'पांच', 'छह', 'सात', 'आठ', 'नौ', 'दस'],
    ml: ['ഒന്ന്', 'രണ്ട്', 'മൂന്ന്', 'നാല്', 'അഞ്ച്', 'ആറ്', 'ഏഴ്', 'എട്ട്', 'ഒമ്പത്', 'പത്ത്'],
    bn: ['এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়', 'দশ'],
    mr: ['एक', 'दोन', 'तीन', 'चार', 'पाच', 'सहा', 'सात', 'आठ', 'नऊ', 'दहा'],
    gu: ['એક', 'બે', 'ત્રણ', 'ચાર', 'પાંચ', 'છ', 'સાત', 'આઠ', 'નવ', 'દસ'],
    pa: ['ਇੱਕ', 'ਦੋ', 'ਤਿੰਨ', 'ਚਾਰ', 'ਪੰਜ', 'ਛੇ', 'ਸੱਤ', 'ਅੱਠ', 'ਨੌਂ', 'ਦਸ'],
    ur: ['ایک', 'دو', 'تین', 'چار', 'پانچ', 'چھ', 'سات', 'آٹھ', 'نو', 'دس'],
    ne: ['एक', 'दुई', 'तीन', 'चार', 'पाँच', 'छ', 'सात', 'आठ', 'नौ', 'दस'],
    si: ['එක', 'දෙක', 'තුන', 'හතර', 'පහ', 'හය', 'හත', 'අට', 'නවය', 'දහය'],
    ar: ['واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة'],
    es: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'],
    fr: ['un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'],
    de: ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn'],
    pt: ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'],
    ru: ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять'],
    tr: ['bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz', 'on'],
    id: ['satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh'],
    zh: ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'],
    ja: ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'],
    ko: ['일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십']
  };

  /* "ಎರಡು + ಎರಡು" -> "2 + 2", without touching a number word that is part
     of a longer word ("दोस्त" is a friend, not a two). */
  N.words2num = function (text, lang) {
    const list = NUM[lang];
    let t = String(text == null ? '' : text);
    if (!list) return t;
    list.forEach((w, i) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp('(^|[^\\p{L}])' + esc + '(?![\\p{L}])', 'gu'), '$1' + (i + 1));
    });
    return t;
  };
  N.numberLangs = () => Object.keys(NUM);

  /* ---------- 4. words taught on this device ---------- */
  function taught() {
    const t = Aevion.store.get('nluWords', {});
    return t && typeof t === 'object' ? t : {};
  }

  /* The words for a language: the shipped table plus anything the user
     taught, with the taught ones first so they win a tie. */
  N.words = function (lang, intent) {
    const extra = (taught()[lang] || {})[intent] || [];
    const base = (W[lang] && W[lang][intent]) || [];
    return [...new Set([].concat(extra, base))];
  };

  N.addWords = function (lang, intent, words) {
    const list = [].concat(words || []).map(w => String(w).trim()).filter(Boolean);
    if (!lang || !intent || !list.length) return null;
    const all = taught();
    all[lang] = all[lang] || {};
    all[lang][intent] = [...new Set([].concat(all[lang][intent] || [], list))];
    Aevion.store.set('nluWords', all);
    Aevion.emit('nlu:changed', { lang, intent, words: list });
    return list;
  };
  N.teach = (lang, intent, words) => N.addWords(lang, intent, words);
  N.forgetTaught = function () { Aevion.store.set('nluWords', {}); Aevion.emit('nlu:changed', {}); return true; };

  /* Which languages this app can understand offline, and how well. */
  N.coverage = function () {
    const extra = taught();
    const codes = [...new Set(Object.keys(W).concat(Object.keys(extra)))].sort();
    return codes.map(code => {
      const meta = (Aevion.languages || []).find(l => l.code === code);
      const intents = [...new Set(Object.keys(W[code] || {}).concat(Object.keys(extra[code] || {})))];
      return {
        code,
        label: meta ? Aevion.langLabel(meta) : code,
        intents: intents.length,
        teachable: true
      };
    });
  };

  /* ---------- 5. routing ---------- */

  /* Order matters: the intent that should win when keywords overlap
     comes first ("ಮೇರೆ ಕಾಮಗಳು" is a list; "ಕಾಮ ಸೇರಿಸು" is an add). */
  N.INTENTS = [
    'timerlist', 'timerstop', 'timer', 'tasks', 'task', 'note', 'remember', 'recall',
    'help', 'languages', 'clear', 'translate', 'search', 'weather', 'privacy', 'whoami',
    'features', 'status', 'setname', 'date', 'time', 'greet', 'thanks',
    'joke', 'coin', 'dice', 'open-site', 'math'
  ];

  const fold = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

  /* Languages written in the Latin alphabet — used only to pick the right
     matching rule below. */
  const NON_LATIN = new Set(SCRIPTS.reduce((all, s) => all.concat(s.langs), []));
  const LATIN_LANGS = Object.keys(W).filter(l => !NON_LATIN.has(l));

  /* Indic, Arabic, CJK and friends are written without word spaces the way
     English uses them, so a substring is the right test there. Latin
     scripts get a word boundary instead, which is what keeps “para” from
     meaning “ara” (Turkish for search). */
  function hit(t, word, lang) {
    if (!LATIN_LANGS.includes(lang)) return t.includes(word);
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}])' + esc, 'u').test(t);
  }

  /* The languages to try: the one the script reveals, plus the one the
     app is set to when it is not English. English is never in here —
     brain.js keeps its own English rules and its exact behaviour. */
  function candidates(text) {
    const found = N.detect(text);
    const set = new Set(found.langs);
    const chosen = Aevion.settings && Aevion.settings.lang;
    if (chosen && chosen !== 'en') set.add(chosen);
    return [...set].filter(l => W[l] || (taught()[l]));
  }

  /* -> { kind, raw, lang, match } or null when nothing localized hits. */
  N.route = function (text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const t = fold(N.digits(raw));
    const langs = candidates(raw);
    if (!langs.length) return null;

    for (const intent of N.INTENTS) {
      for (const lang of langs) {
        for (const word of N.words(lang, intent)) {
          const w = fold(N.digits(word));
          if (!w) continue;
          if (hit(t, w, lang)) return { kind: intent, raw, lang, match: word };
        }
      }
    }

    /* Arithmetic has no language: spoken numbers become digits, and if
       what is left after the letters are removed is digits and operators,
       it is a sum. */
    let numeric = t;
    for (const lang of langs) numeric = N.words2num(numeric, lang);
    const stripped = numeric.replace(/[^0-9+\-*/^%().\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/[0-9]/.test(stripped) && /[+\-*/^%]/.test(stripped) && /^[-+*/^%().\d\s]+$/.test(stripped)) {
      return { kind: 'math-maybe', raw, lang: langs[0], match: null, expression: stripped };
    }
    return null;
  };

  /* The arithmetic part of a sentence in any language: strips the
     question words, drops everything that is not a number or an
     operator, and normalizes the digits. "ಮೂರು + ೪ ಎಷ್ಟು?" -> "3+4". */
  N.cleanMath = function (text, lang) {
    let t = fold(N.words2num(N.digits(text), lang));
    for (const intent of ['math', 'timer']) {
      for (const word of N.words(lang || 'en', intent)) {
        if (word) t = t.split(fold(N.digits(word))).join(' ');
      }
    }
    const keep = t.replace(/[^0-9+\-*/^%().\s]/g, ' ');
    return keep.replace(/\s+/g, ' ').trim();
  };

  /* ---------- 6. durations ("5 ನಿಮಿಷ", "चार मिनट") ---------- */
  N.duration = function (text, lang) {
    const t = fold(N.digits(text));
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, दस: 10, ஒரு: 1, இரண்டு: 2, மூன்று: 3, నాలుగు: 4, ಐದು: 5, ఒకటి: 1, రెండు: 2, మూడు: 3, uno: 1, dos: 2, tres: 3, one: 1 };
    const digits = t.match(/\d+(?:[.,]\d+)?/);
    let n = digits ? parseFloat(digits[0].replace(',', '.')) : null;
    if (n === null) {
      for (const [w, v] of Object.entries(words)) if (t.includes(w)) { n = v; break; }
    }
    if (n === null || !(n > 0)) return null;
    const unitWords = (list) => list.some(u => t.includes(fold(u)));
    let unit = 'min';
    if (unitWords(N.UNITS.sec)) unit = 'sec';
    else if (unitWords(N.UNITS.hour)) unit = 'hour';
    else if (unitWords(N.UNITS.min)) unit = 'min';
    /* "timer 5" with no unit at all: minutes is the sane default. */
    const ms = unit === 'sec' ? n * 1000 : unit === 'hour' ? n * 3600000 : n * 60000;
    return { ms: Math.round(ms), minutes: Math.round(ms / 60000), unit, value: n };
  };

  /* ---------- 7. speaking back ---------- */
  const SAY = {
    en: { greet: 'Hello! What can I do?', thanks: 'Anytime.', empty: 'Say something and I will run it locally.', noted: 'Saved on this device.', heard: 'Listening.' },
    hi: { greet: 'नमस्ते! बताइए, क्या करना है?', thanks: 'कोई बात नहीं।', empty: 'कुछ कहिए — मैं यहीं, इसी डिवाइस पर हूँ।', noted: 'इसी डिवाइस पर सुरक्षित कर लिया।', heard: 'सुन रही हूँ।' },
    mr: { greet: 'नमस्कार! सांगा, काय करायचं आहे?', thanks: 'काही हरकत नाही.', empty: 'काहीतरी सांगा.', noted: 'या डिव्हाइसवर साठवलं.' },
    ur: { greet: 'سلام! بتائیے، کیا کرنا ہے؟', thanks: 'کوئی بات نہیں۔', empty: 'کچھ کہیے۔', noted: 'اسی ڈیوائس پر محفوظ کر لیا۔' },
    ne: { greet: 'नमस्ते! भन्नुहोस्, के गर्नु छ?', thanks: 'केही छैन।', empty: 'केही भन्नुहोस्।', noted: 'यही यन्त्रमा सुरक्षित भयो।' },
    ta: { greet: 'வணக்கம்! என்ன செய்ய வேண்டும்?', thanks: 'பரவாயில்லை.', empty: 'ஏதாவது சொல்லுங்கள்.', noted: 'இந்த சாதனத்திலேயே சேமித்தேன்.', heard: 'கேட்கிறேன்.' },
    te: { greet: 'నమస్కారం! ఏం చేయాలి?', thanks: 'పర్వాలేదు.', empty: 'ఏదైనా చెప్పండి.', noted: 'ఇదే పరికరంలో సేవ్ చేశాను.', heard: 'వింటున్నాను.' },
    kn: { greet: 'ನಮಸ್ಕಾರ! ಏನು ಬೇಕು ಹೇಳಿ?', thanks: 'ಪರವಾಗಿಲ್ಲ.', empty: 'ಏನಾದರೂ ಹೇಳಿ — ನಾನು ಇಲ್ಲೇ, ಈ ಸಾಧನದಲ್ಲೇ ಇದ್ದೇನೆ.', noted: 'ಇದೇ ಸಾಧನದಲ್ಲಿ ಉಳಿಸಿದೆ.', heard: 'ಕೇಳುತ್ತಿದ್ದೇನೆ.' },
    ml: { greet: 'നമസ്കാരം! എന്ത് വേണം?', thanks: 'കുഴപ്പമില്ല.', empty: 'എന്തെങ്കിലും പറയൂ.', noted: 'ഈ ഉപകരണത്തിൽ സൂക്ഷിച്ചു.' },
    bn: { greet: 'নমস্কার! কী করতে হবে?', thanks: 'কিছু হয়নি।', empty: 'কিছু বলুন।', noted: 'এই ডিভাইসেই রাখা হলো।' },
    gu: { greet: 'નમસ્તે! શું કરવું છે?', thanks: 'કંઈ વાંધો નહીં.', empty: 'કંઈક કહો.', noted: 'આ જ ડિવાઇસમાં સાચવ્યું.' },
    pa: { greet: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਦੱਸੋ ਕੀ ਕਰਨਾ ਹੈ?', thanks: 'ਕੋਈ ਗੱਲ ਨਹੀਂ।', empty: 'ਕੁਝ ਕਹੋ।', noted: 'ਇਸੇ ਡਿਵਾਈਸ ਵਿੱਚ ਸੰਭਾਲ ਲਿਆ।' },
    or: { greet: 'ନମସ୍କାର! କଣ କରିବାକୁ ହେବ?', thanks: 'କିଛି ନାହିଁ।', empty: 'କିଛି କୁହନ୍ତୁ।', noted: 'ଏହି ଡିଭାଇସରେ ସେଭ୍ ହେଲା।' },
    as: { greet: 'নমস্কাৰ! কি কৰিব লাগে?', thanks: 'ভাল হ\'ল।', empty: 'কিবা কওক।', noted: 'এই ডিভাইচতে ৰখা হ\'ল।' },
    si: { greet: 'ආයුබෝවන්! මොනවද කරන්න ඕන?', thanks: 'කමක් නෑ.', empty: 'මොනවා හරි කියන්න.', noted: 'මේ උපාංගයේම සුරැකිය.' },
    ar: { greet: 'مرحبا! ماذا تريد أن أفعل؟', thanks: 'على الرحب والسعة.', empty: 'قل شيئا.', noted: 'تم الحفظ على هذا الجهاز.' },
    fa: { greet: 'سلام! چه کاری انجام بدهم؟', thanks: 'خواهش می‌کنم.', empty: 'چیزی بگویید.', noted: 'روی همین دستگاه ذخیره شد.' },
    he: { greet: 'שלום! מה לעשות?', thanks: 'בכיף.', empty: 'תגיד משהו.', noted: 'נשמר במכשיר הזה.' },
    ru: { greet: 'Привет! Что нужно сделать?', thanks: 'Всегда пожалуйста.', empty: 'Скажите что-нибудь.', noted: 'Сохранено на этом устройстве.' },
    uk: { greet: 'Привіт! Що зробити?', thanks: 'Будь ласка.', empty: 'Скажіть щось.', noted: 'Збережено на цьому пристрої.' },
    el: { greet: 'Γεια! Τι χρειάζεσαι;', thanks: 'Ευχαρίστως.', empty: 'Πες κάτι.', noted: 'Αποθηκεύτηκε σε αυτή τη συσκευή.' },
    th: { greet: 'สวัสดี! ให้ทำอะไรดี?', thanks: 'ด้วยความยินดี.', empty: 'พูดอะไรสักอย่าง.', noted: 'บันทึกไว้ในเครื่องนี้แล้ว.' },
    zh: { greet: '你好！需要我做什么？', thanks: '不客气。', empty: '说点什么吧。', noted: '已保存在本机。' },
    ja: { greet: 'こんにちは！何をしましょうか？', thanks: 'どういたしまして。', empty: '何か言ってください。', noted: 'この端末に保存しました。' },
    ko: { greet: '안녕하세요! 무엇을 도와드릴까요?', thanks: '천만에요.', empty: '무엇이든 말해 주세요.', noted: '이 기기에 저장했어요.' },
    vi: { greet: 'Xin chào! Cần gì ạ?', thanks: 'Không có gì.', empty: 'Nói gì đó đi.', noted: 'Đã lưu trên thiết bị này.' },
    id: { greet: 'Halo! Mau lakukan apa?', thanks: 'Sama-sama.', empty: 'Katakan sesuatu.', noted: 'Tersimpan di perangkat ini.' },
    ms: { greet: 'Helo! Apa yang perlu dibuat?', thanks: 'Sama-sama.', empty: 'Katakan sesuatu.', noted: 'Disimpan dalam peranti ini.' },
    fil: { greet: 'Kumusta! Ano ang gagawin?', thanks: 'Walang anuman.', empty: 'Sabihin mo lang.', noted: 'Naka-save sa device na ito.' },
    sw: { greet: 'Habari! Nikusaidie nini?', thanks: 'Karibu.', empty: 'Sema kitu.', noted: 'Imehifadhiwa kwenye kifaa hiki.' },
    tr: { greet: 'Merhaba! Ne yapmamı istersin?', thanks: 'Rica ederim.', empty: 'Bir şey söyle.', noted: 'Bu cihazda kaydedildi.' },
    es: { greet: '¡Hola! ¿Qué necesitas?', thanks: 'De nada.', empty: 'Di algo.', noted: 'Guardado en este dispositivo.' },
    fr: { greet: 'Bonjour ! Que puis-je faire ?', thanks: 'Avec plaisir.', empty: 'Dis quelque chose.', noted: 'Enregistré sur cet appareil.' },
    de: { greet: 'Hallo! Was soll ich tun?', thanks: 'Gern geschehen.', empty: 'Sag etwas.', noted: 'Auf diesem Gerät gespeichert.' },
    pt: { greet: 'Olá! O que precisa?', thanks: 'De nada.', empty: 'Diga algo.', noted: 'Guardado neste dispositivo.' },
    it: { greet: 'Ciao! Cosa ti serve?', thanks: 'Prego.', empty: 'Dimmi qualcosa.', noted: 'Salvato su questo dispositivo.' },
    nl: { greet: 'Hallo! Wat kan ik doen?', thanks: 'Graag gedaan.', empty: 'Zeg iets.', noted: 'Opgeslagen op dit apparaat.' },
    pl: { greet: 'Cześć! Co zrobić?', thanks: 'Nie ma za co.', empty: 'Powiedz coś.', noted: 'Zapisano na tym urządzeniu.' }
  };

  /* A canned line in the user's language, or the English one when this
     language has no table yet — never an empty string. */
  N.say = function (lang, key, english) {
    const table = SAY[lang] || {};
    return table[key] || (SAY.en && SAY.en[key]) || english || '';
  };

  const JOKES = {
    en: ['Why do programmers prefer dark mode? Because light attracts bugs.',
      'There are 10 types of people: those who understand binary and those who do not.'],
    hi: ['शिक्षक: तुमने होमवर्क क्यों नहीं किया? छात्र: सर, बिजली नहीं थी। शिक्षक: तो मोमबत्ती से करते! छात्र: सर, मोमबत्ती वाला उत्तर पढ़ने वाला कौन था?',
      'पत्नी: आप हमेशा मोबाइल में क्यों लगे रहते हैं? पति: क्योंकि तुमसे बात करने का बहाना चाहिए ना!'],
    kn: ['ಗುರು: ಮನೆಪಾಠ ಯಾಕೆ ಮಾಡಿಲ್ಲ? ವಿದ್ಯಾರ್ಥಿ: ಸರ್, ಕರೆಂಟ್ ಇರಲಿಲ್ಲ. ಗುರು: ಹಾಗಾದರೆ ಮೊಂಬತ್ತಿ ಬೆಳಗಿಸಿ ಬರೆಯಬಹುದಿತ್ತು! ವಿದ್ಯಾರ್ಥಿ: ಸರ್, ಮೊಂಬತ್ತಿ ಸಂಖ್ಯೆ ಕೊಡಿ, ನಾನು ಫೋನ್ ಮಾಡುತ್ತಿದ್ದೆ.',
      'ಅಮ್ಮ: ಯಾಕೆ ತಡವಾಗಿ ಬಂದೆ? ಮಗು: ರಸ್ತೆಯಲ್ಲಿ ಒಂದು ಚಿಹ್ನೆ ಬಂತು ಅಮ್ಮ — "ನಿಧಾನವಾಗಿ ಹೋಗಿ". ಅದಕ್ಕೆ ನಿಧಾನವಾಗಿ ನಡೆದು ಬಂದೆ!'],
    ta: ['ஆசிரியர்: வீட்டுப்பாடம் ஏன் செய்யவில்லை? மாணவன்: சார், மின்சாரம் இல்லை! ஆசிரியர்: மெழுகுவர்த்தி வெளிச்சத்தில் எழுதலாம் தானே? மாணவன்: சார், அந்த மெழுகுவர்த்தியின் போன் நம்பர் கொடுங்க!',
      'அம்மா: ஏன் தாமதம்? மகன்: அம்மா, வழியில் "மெதுவாக செல்லவும்" போர்டு இருந்தது, அதனால் மெதுவாக நடந்து வந்தேன்!'],
    te: ['ఉపాధ్యాయుడు: హోంవర్క్ ఎందుకు చేయలేదు? విద్యార్థి: సర్, కరెంట్ లేదు! ఉపాధ్యాయుడు: కొవ్వొత్తి వెలుతురులో రాయచ్చు కదా? విద్యార్థి: సర్, ఆ కొవ్వొత్తి ఫోన్ నంబర్ ఇవ్వండి!',
      'అమ్మ: ఇంత ఆలస్యం ఎందుకు? అబ్బాయి: అమ్మా, దారిలో "నెమ్మదిగా వెళ్లండి" బోర్డు ఉంది, అందుకే నెమ్మదిగా నడిచి వచ్చాను!'],
    ml: ['ടീച്ചർ: ഹോംവർക്ക് എന്തേ ചെയ്യാത്തത്? കുട്ടി: സാർ, കറന്റ് ഇല്ലായിരുന്നു. ടീച്ചർ: മെഴുകുതിരി കത്തിച്ച് എഴുതാമായിരുന്നു! കുട്ടി: ശരി സാർ, ആ മെഴുകുതിരിയുടെ നമ്പർ തരൂ.',
      'അമ്മ: വൈകിയതെന്തേ? മകൻ: "പതുക്കെ പോകുക" എന്ന ബോർഡ് കണ്ടു, അതുകൊണ്ട് പതുക്കെ നടന്നു.'],
    bn: ['শিক্ষক: বাড়ির কাজ করনি কেন? ছাত্র: স্যার, লাইট ছিল না। শিক্ষক: মোমবাতি জ্বালিয়ে লিখতে পারতে! ছাত্র: স্যার, ওই মোমবাতির ফোন নম্বরটা দিন।',
      'মা: এত দেরি করলে কেন? ছেলে: রাস্তায় "ধীরে চলুন" লেখা ছিল, তাই ধীরে হেঁটে এলাম।'],
    mr: ['शिक्षक: गृहपाठ का केला नाही? विद्यार्थी: सर, लाइट नव्हती. शिक्षक: मेणबत्ती लावून लिहीत तर! विद्यार्थी: सर, त्या मेणबत्तीचा फोन नंबर द्या.',
      'आई: उशिरा का आलास? मुलगा: रस्त्यावर "हळू चला" असं लिहिलं होतं, म्हणून हळू चालत आलो.'],
    gu: ['શિક્ષક: ગૃહકાર્ય કેમ ન કર્યું? વિદ્યાર્થી: સર, લાઇટ ન હતી. શિક્ષક: મીણબત્તી કરીને લખી શકાય! વિદ્યાર્થી: સર, એ મીણબત્તીનો નંબર આપો.'],
    pa: ['ਅਧਿਆਪਕ: ਘਰ ਦਾ ਕੰਮ ਕਿਉਂ ਨਹੀਂ ਕੀਤਾ? ਵਿਦਿਆਰਥੀ: ਸਰ, ਲਾਈਟ ਨਹੀਂ ਸੀ। ਅਧਿਆਪਕ: ਮੋਮਬੱਤੀ ਨਾਲ ਲਿਖ ਸਕਦੇ ਸੀ! ਵਿਦਿਆਰਥੀ: ਸਰ, ਉਸ ਮੋਮਬੱਤੀ ਦਾ ਨੰਬਰ ਦਿਓ।'],
    ur: ['استاد: ہوم ورک کیوں نہیں کیا؟ طالبِ علم: سر، بجلی نہیں تھی۔ استاد: موم بتی سے لکھ سکتے تھے! طالبِ علم: سر، اُس موم بتی کا نمبر دے دیں۔'],
    ne: ['शिक्षक: गृहकार्य किन गरेनौ? विद्यार्थी: सर, बत्ती थिएन। शिक्षक: मैनबत्ती बालेर लेख्न सक्थ्यौ! विद्यार्थी: सर, त्यो मैनबत्तीको फोन नम्बर दिनुहोस्।'],
    si: ['ගුරු: ගෙදර වැඩ කළේ නැත්තේ ඇයි? සිසු: සර්, විදුලිය නැහැ. ගුරු: ඉටිපන්දමක් දල්වලා ලියන්න තිබුණා! සිසු: සර්, ඒ ඉටිපන්දමේ දුරකථන අංකය දෙන්න.'],
    es: ['Profesor: ¿por qué no hiciste la tarea? Alumno: no había luz. Profesor: ¡podías usar una vela! Alumno: profe, páseme el teléfono de la vela.',
      'Mamá: ¿por qué llegaste tarde? Hijo: había un cartel que decía "despacio", así que vine despacio.'],
    fr: ['Prof: pourquoi tu n\'as pas fait tes devoirs ? Élève : il n\'y avait pas d\'électricité. Prof : tu pouvais prendre une bougie ! Élève : donne-moi le numéro de la bougie alors.',
      'Maman : pourquoi ce retard ? Fils : il y avait un panneau « ralentir », alors j\'ai ralenti.'],
    de: ['Lehrer: Warum hast du keine Hausaufgaben gemacht? Schüler: Es gab keinen Strom. Lehrer: Dann nimm doch eine Kerze! Schüler: Geben Sie mir bitte die Nummer der Kerze.',
      'Mama: Warum kommst du zu spät? Kind: Da stand "langsam fahren", also bin ich langsam gegangen.'],
    pt: ['Professor: por que não fez a lição? Aluno: faltou luz. Professor: podia usar uma vela! Aluno: então me passe o telefone da vela.',
      'Mãe: por que chegou tarde? Filho: tinha uma placa "devagar", então vim devagar.'],
    ru: ['Учитель: почему не сделал домашку? Ученик: света не было. Учитель: взял бы свечку! Ученик: дайте тогда номер свечки.',
      'Мама: почему так поздно? Сын: там знак «тихий ход», вот я тихо и шёл.'],
    ar: ['المعلم: لماذا لم تحل الواجب؟ الطالب: لم يكن هناك كهرباء. المعلم: كان يمكنك استخدام شمعة! الطالب: أعطني رقم هاتف الشمعة إذن.',
      'الأم: لماذا تأخرت؟ الابن: كانت هناك لافتة تقول "تمهل"، فتمهلت.'],
    tr: ['Öğretmen: ödevi neden yapmadın? Öğrenci: elektrik yoktu. Öğretmen: mum yakıp yazsaydın! Öğrenci: mumun telefon numarasını ver o zaman.',
      'Anne: neden geç kaldın? Çocuk: "yavaş" tabelası vardı, ben de yavaş geldim.'],
    id: ['Guru: kenapa tidak kerjakan PR? Murid: tidak ada listrik. Guru: pakai lilin saja! Murid: beri nomor telepon lilinnya dong.',
      'Ibu: kenapa telat? Anak: ada rambu "pelan-pelan", jadi saya pelan-pelan.'],
    vi: ['Thầy: sao không làm bài tập? Trò: mất điện ạ. Thầy: thì thắp nến mà làm! Trò: thầy cho em số điện thoại của cây nến đi.',
      'Mẹ: sao về muộn? Con: có biển "đi chậm", nên con đi chậm.'],
    fil: ['Guro: bakit hindi mo ginawa ang takdang-aralin? Estudyante: walang kuryente. Guro: gamitin mo ang kandila! Estudyante: pakibigay po ang numero ng kandila.',
      'Nanay: bakit ka na-late? Anak: may karatulang "dahan-dahan", kaya dahan-dahan ako.'],
    sw: ['Mwalimu: kwa nini hukufanya kazi ya nyumbani? Mwanafunzi: hakukuwa na umeme. Mwalimu: ungetumia mshumaa! Mwanafunzi: nipe namba ya simu ya mshumaa basi.',
      'Mama: kwa nini umechelewa? Mtoto: kulikuwa na bango "pole pole", kwa hiyo nilitembea pole pole.'],
    zh: ['老师：为什么没写作业？学生：停电了。老师：可以点蜡烛啊！学生：那请把蜡烛的电话给我。',
      '妈妈：怎么这么晚？孩子：路上写着"慢行"，所以我就慢慢走过来了。'],
    ja: ['先生：なぜ宿題をやらなかった？ 生徒：停電でした。 先生：ろうそくを使えばいい！ 生徒：じゃあそのろうそくの電話番号を教えてください。',
      '母：どうして遅刻したの？ 子：「徐行」って看板があったから、ゆっくり歩いてきた。'],
    ko: ['선생님: 숙제 왜 안 했어? 학생: 정전이었어요. 선생님: 촛불 켜면 되잖아! 학생: 그럼 그 촛불 전화번호 좀 주세요.',
      '엄마: 왜 이렇게 늦었어? 아이: "천천히" 표지판이 있어서 천천히 걸어왔어.']
  };

  N.jokeLangs = () => Object.keys(JOKES);
  N.jokes = function (lang) {
    const list = JOKES[lang];
    if (list && list.length) return list.slice();
    return JOKES.en.slice();
  };
  /* Was the joke actually in the user's language, or did we fall back? */
  N.jokeLocalized = lang => !!(JOKES[lang] && JOKES[lang].length);

  /* ---------- 8. time and date in the user's own numerals ---------- */
  N.localeTag = function (lang) {
    if (!lang) return undefined;
    return (Aevion.speechTag && Aevion.speechTag(lang)) || lang;
  };
  N.time = function (lang) {
    try { return new Date().toLocaleTimeString(N.localeTag(lang)); } catch { return new Date().toLocaleTimeString(); }
  };
  N.date = function (lang) {
    try {
      return new Date().toLocaleDateString(N.localeTag(lang), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch { return new Date().toLocaleDateString(); }
  };

  Aevion.nlu = N;
})();
