/* ============================================================
   Revuzz cloud bridge
   Keeps the offline localStorage cache and syncs it to Supabase.
   Load this AFTER the main game script.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.REVUZZ_CLOUD || {};

  /* A publishable key is safe to ship. A secret key / service_role JWT is not:
     it ignores row-level security, so putting it here would hand every visitor
     full control of the database. Refuse to start rather than leak it. */
  function isSecretKey(k) {
    var s = String(k || '').trim();
    if (/^sb_secret_/i.test(s)) return 'sb_secret_';
    if (/^sbp_/i.test(s)) return 'sbp_ (personal access token)';
    if (/^ey[A-Za-z0-9_-]+\./.test(s)) {
      try {
        var b = s.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        var claims = JSON.parse(atob(b));
        if (claims && (claims.role === 'service_role' || claims.role === 'supabase_admin')) {
          return 'service_role JWT';
        }
      } catch (e) { /* not a JWT we can read; let it through */ }
    }
    return '';
  }

  var SECRET_KIND = isSecretKey(CFG.anonKey);
  var ONLINE = !!(SECRET_KIND === '' &&
    CFG.url && CFG.anonKey &&
    !/YOUR[-_]/i.test(String(CFG.url)) &&
    !/YOUR[-_]/i.test(String(CFG.anonKey)) &&
    window.supabase && window.supabase.createClient
  );

  var state = {
    client: null,
    user: null,
    online: false,
    pushTimer: 0,
    pushing: false,
    again: false,
    leadBusy: false,
    pendingSn: '',
    warned: false
  };

  function $(s) { return document.querySelector(s); }
  function dataOf(res) { return (res && res.data) || []; }
  function must(res) {
    if (res && res.error) throw res.error;
    return (res && res.data) || [];
  }
  function todayStr() {
    try { return td(); } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }
  function syntheticEmail(sn) { return String(sn).replace(/\D/g, '') + '@students.revuzz.app'; }

  function friendly(e) {
    var m = String((e && e.message) || e || '');
    if (/duplicate key.*username/i.test(m)) return 'That username is taken. Try another.';
    if (/duplicate key.*student_number/i.test(m)) return 'That student number is already registered.';
    if (/Invalid login credentials/i.test(m)) return 'Wrong student number or password.';
    if (/Email not confirmed/i.test(m)) return 'Confirm your email first, or turn off email confirmation in Supabase.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/profile_missing/.test(m)) return 'Your account profile is missing. Ask the admin to check the database.';
    if (/not_authenticated|JWT/i.test(m)) return 'Please log in again.';
    if (/relation .* does not exist|schema cache/i.test(m)) return 'The database is not set up yet. Run the SQL files in Supabase first.';
    return m || 'Something went wrong. Try again.';
  }

  function setError(id, text) {
    var el = $('#' + id);
    if (el) el.textContent = text || '';
  }

  /* ---------------- init ---------------- */

  function boot() {
    if (SECRET_KIND) {
      var msg = 'SECURITY: config.js contains a ' + SECRET_KIND + ' key, which bypasses ' +
        'every access rule. Replace it with the publishable key (sb_publishable_...). ' +
        'The game will stay offline until you do.';
      console.error('[Revuzz] ' + msg);
      setTimeout(function () { try { toast('Wrong key type in config.js - see console'); } catch (e) {} }, 1400);
      return;
    }

    if (!ONLINE) {
      console.info('[Revuzz] Cloud is not configured - running in offline mode.');
      setTimeout(function () {
        try { toast('Cloud not configured - offline mode'); } catch (e) {}
      }, 1400);
      return;
    }

    state.client = window.supabase.createClient(CFG.url, CFG.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'revuzz-auth'
      }
    });
    state.online = true;

    injectSignupPassword();
    wrapGameFunctions();
    wrapLogin();

    state.client.auth.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      if (!session || !session.user) return;
      state.user = session.user;
      return pullSelf().then(function (acct) {
        if (!acct) return;
        hydrate(acct);
        go('menu');
        aiCheckStatus();
      });
    }).catch(function (e) {
      console.warn('[Revuzz] session restore failed', e);
    });

    state.client.auth.onAuthStateChange(function (event, session) {
      state.user = session && session.user ? session.user : null;
    });
  }

  /* ---------------- profile pull / push ---------------- */

  function pullSelf() {
    return state.client.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      if (!user) return null;
      state.user = user;
      var uid = user.id;

      return Promise.all([
        state.client.from('profiles').select('*').eq('id', uid).maybeSingle(),
        state.client.from('player_badges').select('badge_id').eq('user_id', uid),
        state.client.from('player_accessories').select('accessory_key').eq('user_id', uid),
        state.client.from('player_themes').select('theme_id').eq('user_id', uid),
        state.client.from('player_modes').select('mode').eq('user_id', uid),
        state.client.from('daily_activity').select('*').eq('user_id', uid)
          .eq('activity_date', todayStr()).maybeSingle(),
        state.client.from('missed_questions').select('question').eq('user_id', uid)
          .order('last_missed_at', { ascending: false }).limit(30),
        state.client.from('custom_questions').select('*').eq('user_id', uid)
          .order('position', { ascending: true })
      ]).then(function (r) {
        var p = r[0] && r[0].data;
        if (r[0] && r[0].error) throw r[0].error;
        if (!p) return null;

        var badges = must(r[1]).map(function (x) { return x.badge_id; });
        var accessories = must(r[2]).map(function (x) { return x.accessory_key; });
        var themes = must(r[3]).map(function (x) { return x.theme_id; });
        var modes = must(r[4]).map(function (x) { return x.mode; });
        var daily = r[5] && r[5].data;
        var missed = must(r[6]).map(function (x) { return x.question; }).filter(Boolean);
        var custom = must(r[7]);

        var last = p.last_name || '';
        var first = p.first_name || '';
        var middle = p.middle_name || '';
        var full = [last, [first, middle].filter(Boolean).join(' ')]
          .filter(Boolean).join(', ');

        return {
          sn: p.student_number,
          user: p.username,
          email: p.email,
          full: full,
          last: last,
          first: first,
          middle: middle,
          grade: p.grade,
          strand: p.strand,
          yr: p.school_year,
          xp: p.xp,
          lvl: p.level,
          coins: p.coins,
          av: p.avatar || rnd(),
          role: p.role,
          x: {
            q: {
              d: daily ? (daily.activity_date || todayStr()) : '',
              n: daily ? daily.correct_count : 0,
              done: !!(daily && daily.quest_completed)
            },
            streak: p.streak || 0,
            last: p.last_played_on || '',
            rec: p.last_result || null,
            bd: badges,
            tot: p.total_correct || 0,
            th: themes.length ? themes : ['cosmic'],
            t: p.active_theme || 'cosmic',
            tu: p.tour_done ? 1 : 0,
            quiz: custom.map(function (q) {
              if (q.type === 'mc') return { t: 'mc', q: q.prompt, a: q.choices || [] };
              return { t: q.type, q: q.prompt, c: q.answer };
            }),
            mq: missed,
            own: accessories,
            seen: modes,
            spin: daily && daily.spun ? (daily.activity_date || todayStr()) : '',
            inv: Object.assign({ f: 0, t: 0, s: 0 }, p.inventory || {}),
            opt: Object.assign({ noVib: 0, ts: 0, rm: 0, hc: 0 }, p.preferences || {})
          }
        };
      });
    });
  }

  function hydrate(acct) {
    S.sn = acct.sn;
    S.name = acct.user;
    S.email = acct.email || '';
    S.full = acct.full || '';
    S.last = acct.last || '';
    S.first = acct.first || '';
    S.middle = acct.middle || '';
    S.grade = acct.grade || '';
    S.strand = acct.strand || '';
    S.yr = acct.yr || '';
    S.xp = acct.xp || 0;
    S.lvl = acct.lvl || 1;
    S.coins = acct.coins || 0;
    S.av = acct.av || rnd();
    S.isMaster = acct.role === 'admin';
    S.x = Object.assign(X0(), acct.x || {});

    try {
      var d = DB.get();
      d[S.sn] = acct;
      DB.set(d);
      lbSync();
    } catch (e) { /* cache is best-effort */ }
  }

  function snapshot() {
    if (!S.sn || S.sn === 'demo' || !S.name) return null;
    var x = S.x || {};
    var today = todayStr();
    var q = x.q || {};
    var sameDay = q.d === today;

    return {
      username: S.name,
      first_name: S.first || '',
      middle_name: S.middle || '',
      last_name: S.last || '',
      grade: S.grade || '',
      strand: S.strand || '',
      school_year: S.yr || '',
      avatar: S.av,
      /* NOTE: coins, xp, level and total_correct are deliberately absent.
         They only move through revuzz_record_game / revuzz_buy /
         revuzz_claim_daily, so editing them in the browser does nothing. */
      active_theme: x.t || 'cosmic',
      streak: x.streak | 0,
      last_played_on: x.last || null,
      last_result: x.rec || null,
      inventory: x.inv || { f: 0, t: 0, s: 0 },
      preferences: x.opt || {},
      tour_done: !!x.tu,
      badges: x.bd || [],
      accessories: x.own || [],
      themes: (x.th && x.th.length ? x.th : ['cosmic']),
      modes: x.seen || [],
      /* Only the date. The counter, the quest and the spin are written by
         revuzz_record_game / revuzz_claim_daily, never by this snapshot. */
      today: { date: today },
      missed: x.mq || [],
      questions: x.quiz || []
    };
  }

  /* The server is the only thing that can change money. Whenever it hands
     back balances, the local copy adopts them - so a value typed into the
     console survives at most one save. */
  function applyBalances(b) {
    if (!b || typeof b !== 'object') return;
    var changed = false;
    if (typeof b.coins === 'number' && b.coins !== S.coins) { S.coins = b.coins; changed = true; }
    if (typeof b.xp === 'number' && b.xp !== S.xp) { S.xp = b.xp; changed = true; }
    if (typeof b.level === 'number' && b.level !== S.lvl) { S.lvl = b.level; changed = true; }
    if (typeof b.total_correct === 'number' && S.x && b.total_correct !== S.x.tot) {
      S.x.tot = b.total_correct;
      changed = true;
    }
    if (!changed) return;

    try { $('#pfsub').textContent = 'Level ' + S.lvl + ' · 🪙 ' + S.coins; } catch (e) {}
    try { shopHead(); } catch (e) {}
    try { var d = DB.get(); if (d[S.sn]) { d[S.sn].coins = S.coins; d[S.sn].xp = S.xp; d[S.sn].lvl = S.lvl; DB.set(d); } } catch (e) {}
  }

  function pushNow() {
    if (!state.online || !state.user) return Promise.resolve();
    var p = snapshot();
    if (!p) return Promise.resolve();
    if (state.pushing) { state.again = true; return Promise.resolve(); }

    state.pushing = true;
    return state.client.rpc('revuzz_save_account', { p: p }).then(function (res) {
      if (res && res.error) throw res.error;
      applyBalances(res && res.data);
    }).catch(function (e) {
      console.warn('[Revuzz] cloud save failed', e);
      if (!state.warned) {
        state.warned = true;
        try { toast('Cloud save failed - kept on this device'); } catch (err) {}
      }
    }).then(function () {
      state.pushing = false;
      if (state.again) { state.again = false; pushNow(); }
    });
  }

  function schedulePush() {
    clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(pushNow, 700);
  }

  /* ---------------- game results ---------------- */

  function recordGame() {
    if (!state.online || !state.user || S.prac) return;
    try {
      var cmp = S.mode === 'Quiz Royale' ? qrCmp : function (a, b) { return b.s - a.s; };
      var ranked = [].concat(G.P).sort(cmp);
      var pos = ranked.map(function (p) { return p.me; }).indexOf(true) + 1;
      var me = ranked[pos - 1] || { s: 0 };

      /* Only the facts are sent. The server decides the coins and XP from
         the rank and score, so faking "coins: 99999" here achieves nothing. */
      state.client.rpc('revuzz_record_game', {
        p: {
          mode: S.mode,
          code: S.code || '',
          types: S.types || [],
          pos: pos,
          score: me.s || 0,
          won: pos === 1,
          correct: G.right || 0,
          wrong: Math.max(0, (G.qs ? G.qs.length : 0) - (G.right || 0)),
          attempts: G.qs ? G.qs.length : 0,
          practice: false
        }
      }).then(function (res) {
        if (res && res.error) throw res.error;
        applyBalances(res && res.data);
        try { if ($('#lead') && $('#lead').classList.contains('on')) leadUI(); } catch (e) {}
      }).catch(function (e) {
        console.warn('[Revuzz] match save failed', e);
      });
    } catch (e) {
      console.warn('[Revuzz] match save skipped', e);
    }
  }

  /* ---------------- purchases and the daily spin ---------------- */

  function mirrorBuy(kind, id) {
    if (!state.online || !state.user) return;
    state.client.rpc('revuzz_buy', { p: { kind: kind, id: id } }).then(function (res) {
      if (res && res.error) throw res.error;
      applyBalances(res && res.data);
    }).catch(function (e) {
      var m = String((e && e.message) || e || '');
      if (/already_owned/.test(m)) return;
      console.warn('[Revuzz] purchase rejected', m);
      try {
        toast(/not_enough_coins/.test(m)
          ? 'Not enough coins - the server says differently'
          : 'Purchase rejected - refreshing your balance');
      } catch (err) {}
      // Roll the local change back to whatever the database really holds.
      pullSelf().then(function (a) {
        if (a) hydrate(a);
        // hydrate() does not repaint the shop, so the header would keep
        // showing the number the refused purchase "spent".
        try { shopHead(); shopUI(); } catch (err) {}
      }).catch(function () {});
    });
  }

  function claimDaily(kind) {
    if (!state.online || !state.user) return Promise.resolve(null);
    return state.client.rpc('revuzz_claim_daily', { p_kind: kind }).then(function (res) {
      if (res && res.error) throw res.error;
      return res.data;
    });
  }

  function wrap(name, wrapper) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { return wrapper(orig, this, arguments); };
  }

  /* ---------------- leaderboard ---------------- */

  function fetchLeaderboard() {
    return state.client.from('leaderboard').select('*').limit(200).then(function (res) {
      if (res.error) throw res.error;
      var myId = state.user && state.user.id;
      return dataOf(res).map(function (r) {
        return {
          name: r.name,
          sn: r.id === myId ? S.sn : undefined,
          cloud: true,
          score: r.score || 0,
          games: r.games || 0,
          wins: r.wins || 0,
          mode: r.mode || '',
          joined: Date.parse(r.joined) || 0,
          updated: Date.parse(r.updated) || 0,
          last: r.last_played ? Date.parse(r.last_played) : 0,
          bd: r.bd || [],
          av: r.avatar,
          lvl: r.lvl || 1,
          xp: r.xp || 0,
          full: '',
          grade: r.grade || '',
          strand: r.strand || ''
        };
      });
    });
  }

  function mergeRows(local, cloud) {
    var map = new Map();
    (local || []).forEach(function (r) {
      if (r && r.name) map.set(String(r.name).toLowerCase(), r);
    });
    (cloud || []).forEach(function (r) {
      var k = String(r.name || '').toLowerCase();
      if (!k) return;
      var old = map.get(k) || {};
      map.set(k, Object.assign({}, old, r, {
        sn: r.sn || old.sn,
        joined: old.joined || r.joined
      }));
    });
    return Array.from(map.values());
  }

  /* ---------------- login / sign-up ---------------- */

  function checkIdentity(sn, username) {
    var args = { p_student_number: sn };
    if (username) args.p_username = username;
    return state.client.rpc('revuzz_check_identity', args).then(function (res) {
      if (res.error) throw res.error;
      return res.data;
    });
  }

  function setBusy(on) {
    var btn = $('#verifyBox .btn');
    if (btn) {
      btn.disabled = !!on;
      btn.textContent = on ? 'Please wait...' : 'Log in';
    }
  }

  function showLoginBox(masked) {
    var box = $('#verifyBox');
    if (!box) return;
    box.style.display = 'block';
    box.innerHTML =
      '<b>🔐 Welcome back</b>' +
      '<p class="hint">Enter the password for this student account.' +
      (masked ? ' Code emails go to <b>' + esc(masked) + '</b>.' : '') + '</p>' +
      '<input class="in" id="cloudPassLogin" type="password" maxlength="72" ' +
      'autocomplete="current-password" placeholder="PASSWORD" style="letter-spacing:2px">' +
      '<p class="err" id="verifyError"></p>' +
      '<button class="btn green" onclick="RVCloud.loginPassword()">Log in</button>' +
      '<button class="lnk" onclick="RVCloud.forgot()">Forgot password?</button>';

    var pass = $('#cloudPassLogin');
    if (pass) {
      pass.focus();
      pass.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') loginPassword();
      });
    }
  }

  function injectSignupPassword() {
    var box = $('#confirmBox');
    if (!box || $('#cloudPassSignup')) return;
    box.insertAdjacentHTML('afterend',
      '<input class="in nm2" id="cloudPassSignup" type="password" maxlength="72" ' +
      'autocomplete="new-password" placeholder="PASSWORD (8+ CHARACTERS)" style="letter-spacing:2px">');
  }

  function loginPassword() {
    var sn = state.pendingSn || ($('#sn') ? $('#sn').value.trim() : '');
    var pass = $('#cloudPassLogin');
    var pw = pass ? pass.value : '';
    if (pw.length < 8) return setError('verifyError', 'Enter your password (8+ characters).');

    setError('verifyError', '');
    setBusy(true);
    state.client.auth.signInWithPassword({
      email: syntheticEmail(sn),
      password: pw
    }).then(function (res) {
      if (res.error) throw res.error;
      return afterLogin(false);
    }).catch(function (e) {
      setError('verifyError', friendly(e));
    }).then(function () {
      setBusy(false);
    });
  }

  function afterLogin(isNew) {
    return pullSelf().then(function (acct) {
      if (!acct) throw new Error('profile_missing');
      hydrate(acct);
      state.pendingSn = '';
      go('menu');
      aiCheckStatus(true);
      var fresh = isNew;
      try {
        if (localStorage.getItem('rv_fresh') === S.sn) {
          fresh = true;
          localStorage.removeItem('rv_fresh');
        }
      } catch (e) {}
      if (fresh) {
        setTimeout(function () { try { gdStart(); } catch (e) {} }, 900);
      }
    });
  }

  function signUp(sn, username, password) {
    var meta = {
      student_number: sn,
      username: username,
      first_name: R.first,
      middle_name: R.middle,
      last_name: R.last,
      email: R.email,
      grade: R.grade,
      strand: R.strand,
      school_year: R.yr,
      avatar: rnd()
    };
    return state.client.auth.signUp({
      email: syntheticEmail(sn),
      password: password,
      options: { data: meta }
    }).then(function (res) {
      if (res.error) throw res.error;
      return state.client.auth.getSession();
    }).then(function (res) {
      var session = res && res.data && res.data.session;
      if (!session) {
        throw new Error('Account created, but Supabase still asks for email confirmation. ' +
          'Turn off "Confirm email" in Authentication -> Providers -> Email, then log in.');
      }
      /* Signing up used to drop the student straight into the game. They now
         go back to the login screen and sign in properly, so the first thing
         they practise is the normal flow - and a mistyped password is caught
         here instead of after a match. */
      return state.client.auth.signOut({ scope: 'local' }).then(function () {
        finishSignup(sn);
      });
    });
  }

  function finishSignup(sn) {
    state.user = null;
    state.pendingSn = '';
    try { localStorage.setItem('rv_fresh', sn); } catch (e) {}
    try {
      if (typeof INIT !== 'undefined' && INIT.login) INIT.login();
      else go('login');
    } catch (e) {
      try { go('login'); } catch (e2) {}
    }
    var field = document.getElementById('sn');
    if (field) field.value = sn;
    var box = document.getElementById('verifyBox');
    if (box) {
      box.style.display = 'block';
      box.innerHTML = '<b>✅ Account created</b>' +
        '<p class="hint">Log in with your student number and the password you just chose.</p>';
    }
    try { toast('Account created — log in to start playing'); } catch (e) {}
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- wrapping the original game ---------------- */

  function wrapGameFunctions() {
    var originalSave = window.save;
    window.save = function () {
      var out = originalSave.apply(this, arguments);
      if (state.online && state.user && S.sn && S.sn !== 'demo') schedulePush();
      return out;
    };

    var originalFinish = window.finish;
    window.finish = function () {
      var already = !!(typeof G !== 'undefined' && G && G.finished);
      var out = originalFinish.apply(this, arguments);
      if (!already) recordGame();
      return out;
    };

    var originalLeadUI = window.leadUI;
    window.leadUI = function () {
      var out = originalLeadUI.apply(this, arguments);

      try {
        var sub = $('#lead .top p');
        if (sub && state.online) sub.textContent = 'All Revuzz players';
      } catch (e) {}

      if (state.online && !state.leadBusy) {
        state.leadBusy = true;
        fetchLeaderboard().then(function (rows) {
          var merged = mergeRows(lbGet(), rows);
          lbSave(merged);
          if ($('#lead') && $('#lead').classList.contains('on')) originalLeadUI();
        }).catch(function (e) {
          console.warn('[Revuzz] leaderboard failed', e);
        }).then(function () {
          state.leadBusy = false;
        });
      }
      return out;
    };

    /* The leaderboard function merges every account cached in this browser
       (rv_users) into the ranking. Offline that is the only data there is, but
       online it put stale or made-up local accounts next to real students - a
       shared computer would show someone else's old test account. When the
       cloud answers, only cloud rows and the signed-in student are kept. */
    var originalLbSync = window.lbSync;
    window.lbSync = function () {
      var rows = originalLbSync.apply(this, arguments);
      if (!state.online) return rows;
      var keep = rows.filter(function (r) {
        return r && (r.cloud || (S.sn && r.sn === S.sn));
      });
      try { lbSave(keep); } catch (e) {}
      return keep;
    };

    var originalGo = window.go;
    window.go = function (n) {
      if (n === 'login' && state.online && state.user) {
        state.user = null;
        try { state.client.auth.signOut(); } catch (e) {}
        try {
          localStorage.removeItem('rv_users');
          localStorage.removeItem('rv_leaderboard');
        } catch (e) {}
      }
      return originalGo.apply(this, arguments);
    };

    // Purchases: let the game do its optimistic local update, then mirror the
    // purchase to the server, which prices it from the catalog itself.
    wrap('setAv', function (orig, self, args) {
      var key = String(args[0]) + args[1];
      var had = !!(S.x && S.x.own && S.x.own.indexOf(key) >= 0);
      var coins = S.coins;
      var out = orig.apply(self, args);
      if (!had && S.x && S.x.own && S.x.own.indexOf(key) >= 0 && S.coins < coins) {
        mirrorBuy('accessory', key);
      }
      return out;
    });

    wrap('setTh', function (orig, self, args) {
      var id = args[0];
      var had = !!(S.x && S.x.th && S.x.th.indexOf(id) >= 0);
      var coins = S.coins;
      var out = orig.apply(self, args);
      if (!had && S.x && S.x.th && S.x.th.indexOf(id) >= 0 && S.coins < coins) {
        mirrorBuy('theme', id);
      }
      return out;
    });

    wrap('buyAcc', function (orig, self, args) {
      var key = args[0];
      var had = !!(S.x && S.x.own && S.x.own.indexOf(key) >= 0);
      var coins = S.coins;
      var out = orig.apply(self, args);
      if (!had && S.x && S.x.own && S.x.own.indexOf(key) >= 0 && S.coins < coins) {
        mirrorBuy('accessory', key);
      }
      return out;
    });

    wrap('buyLL', function (orig, self, args) {
      var k = args[0];
      var before = S.x && S.x.inv ? (S.x.inv[k] | 0) : 0;
      var coins = S.coins;
      var out = orig.apply(self, args);
      if (S.x && S.x.inv && (S.x.inv[k] | 0) > before && S.coins < coins) {
        mirrorBuy('inv', k);
      }
      return out;
    });

    // The daily spin: the server rolls the reward and refuses a second spin,
    // so the wheel is forced onto whatever the server already decided.
    wrap('spin', function (orig, self, args) {
      if (!state.online || !state.user || !S.x) return orig.apply(self, args);
      if (S.x.spin === todayStr()) return orig.apply(self, args);

      var spun = false;
      claimDaily('spin').then(function (b) {
        if (!b || spun) return;
        spun = true;
        var forced = { 10: 0.15, 20: 0.40, 30: 0.60, 50: 0.80, 100: 0.92, 60: 0.97 }[b.reward];
        var real = Math.random;
        if (typeof forced === 'number') {
          Math.random = function () { Math.random = real; return forced; };
        }
        try { orig.apply(self, args); } finally { Math.random = real; }
        // let the wheel finish, then settle on the server's arithmetic
        setTimeout(function () { applyBalances(b); }, 3900);
      }).catch(function (e) {
        var m = String((e && e.message) || e || '');
        if (/already_claimed/.test(m)) {
          try { S.x.spin = todayStr(); } catch (err) {}
          try { toast('You already spun today'); } catch (err) {}
          try { shopUI(); } catch (err) {}
          return;
        }
        console.warn('[Revuzz] spin failed', m);
        if (!spun) { spun = true; orig.apply(self, args); }
      });
    });

    // INIT.lead holds the function reference captured when the game script ran,
    // so patching window.leadUI alone would be skipped.
    try { INIT.lead = window.leadUI; } catch (e) {}

    wrapMasterControl();

    window.RVCloud = {
      /* Bump when the bridge changes, so "did the browser really reload the
         file?" is answerable from the console. */
      build: '2026-11-25c',
      loginPassword: loginPassword,
      forgot: function () {
        toast('Ask the admin to reset your password. Self-service reset is not enabled yet.');
      },
      changePassword: function () {
        toast('Password changes need an email link. Ask the admin for now.');
      },
      refresh: function () { return pullSelf().then(hydrate); },
      admin: {
        students: adminStudents,
        grant: adminGrant,
        resetDay: adminResetDay,
        csv: adminCsv,
        isAdmin: isServerAdmin
      },
      state: state,
      config: CFG,
      ai: AI
    };
  }

  /* ---------------- AI: questions from a handout ----------------

     Everything here talks to the revuzz-ai Edge Function. The model key
     lives only in Supabase secrets; this file never sees it.

     Flow:  upload -> text extracted in the browser -> saved in `lessons`
            -> the function reads it (owner-only) -> questions land in
            the student's deck and play in every mode.
     ------------------------------------------------------------ */

  var AI_LS = 'rv_lesson';
  var AI_MAX_TEXT = 120000;
  var AI_SCRIPT = {
    pdf: 'vendor/pdf.min.js',
    docx: 'vendor/mammoth.browser.min.js',
    pptx: 'vendor/jszip.min.js'
  };

  var AI = {
    /* Bumped with the bridge; the game shows it in the console. */
    build: '2026-11-25c',
    lesson: readLessonMeta(),
    body: '',
    statusInfo: { checked: false, configured: false, mode: 'off', quota: null },
    lastError: '',
    pending: null
  };

  function aiError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function readLessonMeta() {
    try { return JSON.parse(localStorage.getItem(AI_LS) || 'null'); } catch (e) { return null; }
  }

  function writeLessonMeta(l) {
    try {
      if (l) localStorage.setItem(AI_LS, JSON.stringify(l));
      else localStorage.removeItem(AI_LS);
    } catch (e) { /* private mode: the lesson still works this session */ }
  }

  function aiUrl() {
    return String(CFG.url || '').replace(/\/+$/, '') + '/functions/v1/revuzz-ai';
  }

  function aiSignedIn() {
    return !!(state.online && state.user);
  }

  /* The session is the source of truth; `state.user` can lag behind by a tick
     after a fast sign-out/sign-in. */
  function aiUserId() {
    if (state.user && state.user.id) return Promise.resolve(state.user.id);
    if (!state.online) return Promise.reject(aiError('not_signed_in', 'Log in to use AI.'));
    return state.client.auth.getSession().then(function (res) {
      var user = res && res.data && res.data.session && res.data.session.user;
      if (!user) throw aiError('not_signed_in', 'Log in to use AI.');
      state.user = user;
      return user.id;
    });
  }

  /* The current lesson belongs to whoever is logged in now. */
  function aiOwnsLesson() {
    if (AI.lesson && AI.lesson.owner && state.user && AI.lesson.owner !== state.user.id) {
      AI.lesson = null;
      AI.body = '';
      writeLessonMeta(null);
    }
  }

  function aiPost(payload) {
    if (!aiSignedIn()) return Promise.reject(aiError('not_signed_in', 'Log in to use AI.'));
    aiOwnsLesson();
    return state.client.auth.getSession().then(function (res) {
      var token = res && res.data && res.data.session && res.data.session.access_token;
      if (!token) throw aiError('not_signed_in', 'Please log in again.');
      return fetch(aiUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'apikey': CFG.anonKey,
          'authorization': 'Bearer ' + token
        },
        body: JSON.stringify(payload)
      });
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try { data = JSON.parse(text); } catch (e) { data = {}; }
        if (res.status === 404 && /NOT_FOUND|not found/i.test(text)) {
          throw aiError('not_deployed', 'The AI service is not deployed yet.');
        }
        if (!res.ok || data.ok === false) {
          var err = aiError(data.error || ('http_' + res.status), data.message || 'The AI request failed.');
          err.status = res.status;
          err.data = data;
          if (data.quota) AI.statusInfo.quota = data.quota;
          throw err;
        }
        if (data.quota) AI.statusInfo.quota = data.quota;
        return data;
      });
    });
  }

  function aiCheckStatus(force) {
    if (!aiSignedIn()) {
      AI.statusInfo = { checked: true, configured: false, mode: 'offline', quota: null };
      return Promise.resolve(AI.statusInfo);
    }
    if (AI.statusInfo.checked && !force) return Promise.resolve(AI.statusInfo);
    if (AI.pending) return AI.pending;
    AI.pending = aiPost({ action: 'status' }).then(function (d) {
      AI.statusInfo = {
        checked: true,
        configured: !!d.configured,
        mode: d.mode || 'off',
        provider: d.provider || 'none',
        model: d.model || null,
        quota: d.quota || null,
        classQuota: d.class_quota || null,
        limits: d.limits || null
      };
      AI.pending = null;
      return AI.statusInfo;
    }).catch(function (e) {
      AI.statusInfo = { checked: true, configured: false, mode: 'error', quota: null };
      AI.lastError = AI.friendly(e);
      AI.pending = null;
      return AI.statusInfo;
    });
    return AI.pending;
  }

  AI.canUse = aiSignedIn;
  AI.checkStatus = aiCheckStatus;

  AI.statusLabel = function () {
    var s = AI.statusInfo;
    if (!aiSignedIn()) return 'AI needs internet and a login';
    if (!s.checked) return 'Checking AI…';
    if (s.mode === 'demo') return 'Demo AI — questions are built by rules, not a model';
    if (s.configured) {
      return 'AI ready' + (s.quota ? ' · ' + s.quota.left + ' of ' + s.quota.cap + ' calls left today' : '');
    }
    if (s.mode === 'error') return AI.lastError || 'AI is unavailable right now';
    return 'AI not configured — uploads and local study still work';
  };

  AI.friendly = function (e) {
    var code = (e && e.code) || '';
    var msg = (e && e.message) || String(e || '');
    if (code === 'ai_not_configured' || /ai_not_configured/.test(msg)) {
      return 'AI is not set up yet. Ask your teacher to add an AI key in Supabase.';
    }
    if (code === 'daily_limit') return 'Your AI help for today is used up. It resets at midnight.';
    if (code === 'global_limit') return 'The class AI budget for today is finished. Try again tomorrow.';
    if (code === 'not_signed_in') return 'Please log in to use AI.';
    if (code === 'lesson_not_found') return 'That handout is gone. Upload it again.';
    if (code === 'not_deployed') return 'The AI service is not deployed yet.';
    if (code === 'provider_timeout') return 'The AI took too long to answer. Try again.';
    if (code === 'provider_error') return 'The AI service is busy right now. Try again in a minute.';
    if (code === 'offline') return msg || 'You need internet for this step.';
    if (code === 'unsupported') return msg;
    if (code === 'too_short') return msg;
    if (code === 'no_lesson') return 'Upload or choose a handout first.';
    if (code === 'save_failed') return 'Could not save your notes. ' + msg;
    if (/Failed to fetch|NetworkError|load failed|network error/i.test(msg)) {
      return 'You need internet for this step.';
    }
    return msg || 'Something went wrong.';
  };

  /* ---- file reading (runs on the device, nothing uploaded but the text) ---- */

  function loadOnce(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-rv-lib="' + src + '"]');
      if (existing) {
        if (existing.getAttribute('data-rv-ready') === '1') return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () {
          reject(aiError('offline', 'Could not load the file reader. Check your connection.'));
        });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-rv-lib', src);
      s.onload = function () { s.setAttribute('data-rv-ready', '1'); resolve(); };
      s.onerror = function () {
        reject(aiError('offline', 'Could not load the file reader. Check your connection.'));
      };
      document.head.appendChild(s);
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(aiError('read_failed', 'Could not read that file.')); };
      r.readAsText(file);
    });
  }

  function asBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(aiError('read_failed', 'Could not read that file.')); };
      r.readAsArrayBuffer(file);
    });
  }

  function txtOf(xml) {
    return String(xml || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); });
  }

  function extractPdf(file) {
    return loadOnce(AI_SCRIPT.pdf).then(function () {
      if (!window.pdfjsLib) throw aiError('offline', 'The PDF reader did not start.');
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      } catch (e) { /* older builds set it differently */ }
      return asBuffer(file);
    }).then(function (buf) {
      return window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      var pages = [];
      var chain = Promise.resolve();
      for (var i = 1; i <= doc.numPages; i++) {
        (function (n) {
          chain = chain.then(function () {
            return doc.getPage(n).then(function (page) {
              return page.getTextContent().then(function (content) {
                var line = '';
                content.items.forEach(function (it) {
                  line += (it.str || '') + (it.hasEOL ? '\n' : ' ');
                });
                pages.push(line);
              });
            });
          });
        })(i);
      }
      return chain.then(function () { return pages.join('\n\n'); });
    });
  }

  function extractDocx(file) {
    return loadOnce(AI_SCRIPT.docx).then(function () {
      if (!window.mammoth) throw aiError('offline', 'The DOCX reader did not start.');
      return asBuffer(file);
    }).then(function (buf) {
      return window.mammoth.extractRawText({ arrayBuffer: buf });
    }).then(function (res) { return String((res && res.value) || ''); });
  }

  function extractPptx(file) {
    return loadOnce(AI_SCRIPT.pptx).then(function () {
      if (!window.JSZip) throw aiError('offline', 'The PPTX reader did not start.');
      return asBuffer(file);
    }).then(function (buf) {
      return window.JSZip.loadAsync(buf);
    }).then(function (zip) {
      var names = Object.keys(zip.files).filter(function (n) {
        return /^ppt\/slides\/slide\d+\.xml$/.test(n);
      }).sort(function (a, b) {
        return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
      });
      var out = [];
      var chain = Promise.resolve();
      names.forEach(function (n) {
        chain = chain.then(function () {
          return zip.file(n).async('string').then(function (xml) {
            var hits = [];
            var re = /<a:t>([\s\S]*?)<\/a:t>/g;
            var m;
            while ((m = re.exec(xml))) hits.push(m[1]);
            if (hits.length) out.push(hits.join(' '));
          });
        });
      });
      return chain.then(function () { return out.join('\n\n'); });
    });
  }

  function tidy(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  AI.extractFile = function (file) {
    if (!file) return Promise.reject(aiError('read_failed', 'No file chosen.'));
    if (file.size > 8 * 1024 * 1024) {
      return Promise.reject(aiError('too_big', 'That file is larger than 8 MB. Try a smaller one.'));
    }
    var name = file.name || 'notes.txt';
    var ext = (name.split('.').pop() || '').toLowerCase();
    var kind = { txt: 'txt', md: 'md', pdf: 'pdf', docx: 'docx', pptx: 'pptx' }[ext];
    if (!kind) {
      return Promise.reject(aiError('unsupported', 'Use a PDF, DOCX, PPTX, TXT or MD file.'));
    }
    var title = (name.replace(/\.[^.]+$/, '') || 'My notes').slice(0, 120);
    var job;
    if (kind === 'txt' || kind === 'md') job = file.text ? file.text() : readAsText(file);
    else if (kind === 'pdf') job = extractPdf(file);
    else if (kind === 'docx') job = extractDocx(file);
    else job = extractPptx(file);

    return job.then(function (text) {
      var body = tidy(text);
      if (body.length > AI_MAX_TEXT) body = body.slice(0, AI_MAX_TEXT);
      if (body.length < 20) {
        throw aiError('too_short',
          'That file has almost no readable text. If it is a scanned PDF, copy the text and paste it instead.');
      }
      return { title: title, sourceName: name.slice(0, 160), kind: kind, text: body };
    });
  };

  /* ---- lessons in the database ---- */

  AI.saveLesson = function (doc) {
    var body = tidy(doc && doc.text);
    if (body.length < 20) return Promise.reject(aiError('too_short', 'There is not enough text to study.'));
    if (body.length > AI_MAX_TEXT) body = body.slice(0, AI_MAX_TEXT);

    var savedUid = '';
    return aiUserId().then(function (uid) {
      savedUid = uid;
      var row = {
        user_id: uid,
        title: String((doc && doc.title) || 'My notes').slice(0, 120),
        source_name: String((doc && doc.sourceName) || '').slice(0, 160),
        source_kind: (doc && doc.kind) || 'txt',
        body: body,
        chars: body.length
      };
      return state.client.from('lessons').insert(row)
        .select('id,title,source_kind,chars,created_at')
        .single();
    }).then(function (res) {
      if (res.error) throw aiError('save_failed', res.error.message);
      var l = res.data;
      AI.lesson = {
        id: l.id, title: l.title, kind: l.source_kind, chars: l.chars,
        summary: '', owner: savedUid, savedAt: l.created_at
      };
      AI.body = body;
      writeLessonMeta(AI.lesson);
      return AI.lesson;
    });
  };

  AI.listLessons = function () {
    if (!state.online) return Promise.resolve([]);
    return state.client.from('lessons')
      .select('id,title,source_kind,chars,created_at')
      .order('created_at', { ascending: false })
      .limit(20)
      .then(function (res) {
        if (res.error) throw aiError('list_failed', res.error.message);
        return res.data || [];
      });
  };

  AI.useLesson = function (row) {
    AI.lesson = {
      id: row.id, title: row.title, kind: row.source_kind, chars: row.chars,
      summary: row.summary || '', owner: state.user && state.user.id, savedAt: row.created_at
    };
    AI.body = '';
    writeLessonMeta(AI.lesson);
    return AI.lesson;
  };

  AI.forgetLesson = function () {
    AI.lesson = null;
    AI.body = '';
    writeLessonMeta(null);
  };

  AI.deleteLesson = function (id) {
    if (!state.online) return Promise.reject(aiError('not_signed_in', 'Log in first.'));
    return state.client.from('lessons').delete().eq('id', id).then(function (res) {
      if (res.error) throw aiError('delete_failed', res.error.message);
      if (AI.lesson && AI.lesson.id === id) AI.forgetLesson();
      return true;
    });
  };

  AI.loadBody = function () {
    if (AI.body) return Promise.resolve(AI.body);
    aiOwnsLesson();
    if (!AI.lesson || !AI.lesson.id) {
      return Promise.reject(aiError('no_lesson', 'Upload or choose a handout first.'));
    }
    if (!state.online) {
      return Promise.reject(aiError('not_signed_in', 'Log in to read your saved notes.'));
    }
    return state.client.from('lessons').select('body').eq('id', AI.lesson.id).maybeSingle()
      .then(function (res) {
        if (res.error) throw aiError('lesson_not_found', res.error.message);
        if (!res.data) throw aiError('lesson_not_found', 'That handout was deleted. Upload it again.');
        AI.body = String(res.data.body || '');
        return AI.body;
      });
  };

  /* ---- local fallback: no key, no quota, no network ---- */

  function splitSentences(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .split(/([.!?])\s+/)
      .reduce(function (acc, part, i) {
        if (i % 2 === 1) acc[acc.length - 1] += part;
        else acc.push(part);
        return acc;
      }, [''])
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 40; });
  }

  var AI_STOP = ('about above after again against along also although always among another answer around ' +
    'because been before being below between both cannot could does doing down during each either every ' +
    'first from further have having here into itself just last many might more most much must never only ' +
    'other ought over same should since some such than that their them then there these they this those ' +
    'through under until very were what when where which while will with would your yours example ' +
    'following however important includes including information mainly people please process really ' +
    'school should simple simply something sometimes student students teacher their things usually various ' +
    'within without').split(' ');

  function keyTerms(text, count) {
    var freq = {};
    var m = String(text || '').toLowerCase().match(/[a-z][a-z-]{4,}/g) || [];
    m.forEach(function (w) {
      if (AI_STOP.indexOf(w) >= 0) return;
      freq[w] = (freq[w] || 0) + 1;
    });
    return Object.keys(freq).sort(function (a, b) {
      return freq[b] - freq[a] || a.localeCompare(b);
    }).slice(0, count || 6).map(function (w) {
      return { term: w, definition: 'Mentioned ' + freq[w] + (freq[w] === 1 ? ' time' : ' times') + ' in your notes.' };
    });
  }

  AI.localSummary = function (text) {
    var sents = splitSentences(text);
    return {
      mode: 'local',
      summary: sents.slice(0, 3).join(' ') || tidy(text).slice(0, 600),
      key_terms: keyTerms(text, 6),
      note: 'No AI key: this summary is the opening sentences of your notes.'
    };
  };

  AI.localSearch = function (text, question) {
    var keys = (String(question || '').toLowerCase().match(/[a-z]{4,}/g) || [])
      .filter(function (w) { return AI_STOP.indexOf(w) < 0; });
    var hits = splitSentences(text).filter(function (s) {
      var low = s.toLowerCase();
      return keys.some(function (k) { return low.indexOf(k) >= 0; });
    }).slice(0, 3);
    return {
      mode: 'local',
      answer: hits.length ? hits.join(' ') : 'That is not in your notes for this lesson.',
      sources: hits,
      note: 'No AI key: this is a keyword search inside your notes.'
    };
  };

  /* ---- the three actions ---- */

  AI.summary = function () {
    return aiCheckStatus().then(function (s) {
      if (s.configured && AI.lesson && AI.lesson.id) {
        return aiPost({ action: 'summary', lesson_id: AI.lesson.id }).then(function (d) {
          return {
            mode: d.mode, summary: d.summary, key_terms: d.key_terms || [],
            note: d.note || '', quota: d.quota, truncated: d.truncated
          };
        });
      }
      return AI.loadBody().then(function (body) { return AI.localSummary(body); });
    });
  };

  function toGameQuestion(r) {
    var q = { t: r.type, q: r.prompt };
    if (r.type === 'mc') q.a = Array.isArray(r.choices) ? r.choices.slice(0, 4) : [];
    else if (r.type === 'tf') q.c = !!r.answer;
    else q.c = Array.isArray(r.answer) ? r.answer.slice(0, 4) : [String(r.answer || '')];
    if (r.topic) q.topic = String(r.topic).slice(0, 60);
    return q;
  }

  AI.questions = function (opts) {
    opts = opts || {};
    if (!AI.lesson || !AI.lesson.id) {
      return Promise.reject(aiError('no_lesson', 'Upload a handout first.'));
    }
    return aiCheckStatus().then(function (s) {
      if (!s.configured) {
        throw aiError('ai_not_configured', 'AI is not configured yet.');
      }
      return aiPost({
        action: 'questions',
        lesson_id: AI.lesson.id,
        count: Math.min(Math.max(Number(opts.count) || 8, 1), 20),
        types: opts.types && opts.types.length ? opts.types : ['mc', 'tf']
      });
    }).then(function (d) {
      return {
        mode: d.mode,
        note: d.note || '',
        quota: d.quota,
        rows: (d.questions || []).map(toGameQuestion)
      };
    });
  };

  AI.ask = function (question) {
    var q = String(question || '').trim();
    if (q.length < 3) return Promise.reject(aiError('empty', 'Type a question first.'));
    return aiCheckStatus().then(function (s) {
      if (s.configured && AI.lesson && AI.lesson.id) {
        return aiPost({ action: 'ask', lesson_id: AI.lesson.id, question: q }).then(function (d) {
          return { mode: d.mode, answer: d.answer, sources: d.sources || [], note: d.note || '', quota: d.quota };
        });
      }
      return AI.loadBody().then(function (body) { return AI.localSearch(body, q); });
    });
  };

  /* Generated questions join the student's deck, so they also appear in
     "My quiz" for every game mode. The deck is capped at 40. */
  AI.addToDeck = function (rows) {
    if (typeof S === 'undefined' || !S.x) return 0;
    var deck = S.x.quiz || [];
    var seen = {};
    deck.forEach(function (q) { seen[String(q.q || '').toLowerCase()] = 1; });
    var added = 0;
    (rows || []).forEach(function (q) {
      var key = String(q.q || '').toLowerCase();
      if (!key || seen[key] || deck.length >= 40) return;
      seen[key] = 1;
      deck.push(q);
      added++;
    });
    if (added) {
      S.x.quiz = deck;
      try { save(); } catch (e) {}
      try { cUI(); } catch (e) {}
    }
    return added;
  };

  window.RVAI = AI;

  /* ---------------- teacher mode ---------------- */

  /* The Master Control screen was written against the local cache, so it could
     only ever edit the browser it was open in. When a real administrator is
     signed in, these functions talk to the database instead and the local
     preview is left for offline demos. */

  var adminRows = null;

  function isServerAdmin() {
    return !!(state.online && state.user && typeof S !== 'undefined' && S.isMaster);
  }

  function adminStudents() {
    if (!state.online || !state.user) return Promise.reject(new Error('offline'));
    return state.client
      .from('profiles')
      .select('student_number,username,first_name,last_name,grade,strand,level,xp,coins,total_correct,streak,last_played_on,role')
      .order('username')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data || [];
      });
  }

  function adminGrant(sn, coins, xp) {
    return state.client
      .rpc('revuzz_admin_grant', { p: { student_number: String(sn), coins: coins | 0, xp: xp | 0 } })
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function adminResetDay(sn) {
    return state.client
      .rpc('revuzz_admin_reset_day', { p: { student_number: String(sn) } })
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function adminCsv() {
    var head = ['student_number', 'username', 'last_name', 'first_name', 'grade', 'strand', 'role',
      'level', 'xp', 'coins', 'total_correct', 'streak', 'last_played_on'];
    return adminStudents().then(function (rows) {
      var lines = [head.join(',')];
      rows.forEach(function (r) {
        lines.push(head.map(function (k) {
          return csvCell(k === 'total_correct' ? r.total_correct : r[k]);
        }).join(','));
      });
      return lines.join('\r\n');
    });
  }

  function xpForLevels(row, n) {
    var lvl = row.level | 0, xp = row.xp | 0, need = 0;
    for (var i = 0; i < n; i++) { need += lvl * 100 - xp; xp = 0; lvl++; }
    return need;
  }

  function rvcMasterStats() {
    var box = document.getElementById('masterStats');
    if (!box) return;
    var sel = document.getElementById('masterUser');
    var sn = sel ? sel.value : '';
    var row = (adminRows || []).filter(function (r) { return r.student_number === sn; })[0];
    var cell = function (label, value) { return '<div><small>' + label + '</small><b>' + value + '</b></div>'; };
    box.innerHTML = row
      ? cell('Coins', '🪙 ' + row.coins) + cell('Level', 'Lv ' + row.level) + cell('XP', row.xp)
      : cell('Coins', '—') + cell('Level', '—') + cell('XP', '—');
  }

  function rvcMasterPaint() {
    var sel = document.getElementById('masterUser');
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">Select student account</option>' +
      (adminRows || []).map(function (r) {
        return '<option value="' + r.student_number + '">' +
          (r.username || 'Student') + ' · ' + r.student_number + '</option>';
      }).join('');
    if (keep && (adminRows || []).some(function (r) { return r.student_number === keep; })) sel.value = keep;
    rvcMasterStats();
  }

  function rvcAdminError(e) {
    var m = String((e && e.message) || e || '');
    try {
      if (/not_admin/.test(m)) toast('Only a teacher account can change another student');
      else if (/student_not_found/.test(m)) toast('That student no longer exists');
      else if (/offline/.test(m)) toast('Not connected - using the local preview');
      else toast('Admin action failed: ' + m.slice(0, 60));
    } catch (err) {}
  }

  function wrapMasterControl() {
    var origUI = window.masterUI;
    var origSelect = window.masterSelect;
    var origMoney = window.masterMoney;
    var origXP = window.masterXP;
    var origLevel = window.masterLevel;
    var origReset = window.masterResetSpin;
    var origAll = window.masterAllUsers;

    function refresh() {
      return adminStudents().then(function (rows) {
        adminRows = rows;
        rvcMasterPaint();
        var sub = document.getElementById('masterSub');
        if (sub) sub.textContent = 'Administrator · changes are saved for every device (' + rows.length + ' accounts)';
        var note = document.getElementById('masterNote');
        if (note) note.textContent = 'Pick any student in the class. Coins and XP are written to the server, so the change appears on their device too.';
      }).catch(function (e) {
        console.warn('[Revuzz] admin list failed', e);
        rvcAdminError(e);
      });
    }

    window.masterUI = function () {
      var sub = document.getElementById('masterSub');
      if (!isServerAdmin()) {
        adminRows = null;
        if (sub) sub.textContent = 'Preview only · changes stay in this browser';
        return origUI.apply(this, arguments);
      }
      var sel = document.getElementById('masterUser');
      if (sel) sel.innerHTML = '<option value="">Loading students…</option>';
      refresh();
    };

    window.masterSelect = function () {
      if (!isServerAdmin()) return origSelect.apply(this, arguments);
      rvcMasterStats();
    };

    window.masterMoney = function (sign) {
      if (!isServerAdmin()) return origMoney.apply(this, arguments);
      var sn = document.getElementById('masterUser').value;
      if (!sn) return toast('Select a student account first');
      var n = Math.floor(Number(document.getElementById('masterCoins').value));
      if (!Number.isFinite(n) || n < 1) return toast('Enter a valid coin amount');
      adminGrant(sn, sign * n, 0).then(function (b) {
        toast((sign > 0 ? '+' : '−') + n + ' coins → ' + (b && b.username) + ' (' + (b && b.coins) + ')');
        return refresh();
      }).catch(rvcAdminError);
    };

    window.masterXP = function () {
      if (!isServerAdmin()) return origXP.apply(this, arguments);
      var sn = document.getElementById('masterUser').value;
      if (!sn) return toast('Select a student account first');
      var n = Math.floor(Number(document.getElementById('masterXp').value));
      if (!Number.isFinite(n) || n < 1) return toast('Enter a valid XP amount');
      adminGrant(sn, 0, n).then(function (b) {
        toast('+' + n + ' XP → ' + (b && b.username) + ' (Lv ' + (b && b.level) + ')');
        return refresh();
      }).catch(rvcAdminError);
    };

    window.masterLevel = function (n) {
      if (!isServerAdmin()) return origLevel.apply(this, arguments);
      var sn = document.getElementById('masterUser').value;
      if (!sn) return toast('Select a student account first');
      var row = (adminRows || []).filter(function (r) { return r.student_number === sn; })[0];
      if (!row) return toast('Refresh the list first');
      adminGrant(sn, 0, xpForLevels(row, n)).then(function (b) {
        toast('Advanced ' + n + (n === 1 ? ' level' : ' levels') + ' → ' + (b && b.username) + ' is now Lv ' + (b && b.level));
        return refresh();
      }).catch(rvcAdminError);
    };

    window.masterResetSpin = function () {
      if (!isServerAdmin()) return origReset.apply(this, arguments);
      var sel = document.getElementById('masterUser');
      var sn = sel ? sel.value : '';
      if (!sn) return toast('Select a student account first');
      adminResetDay(sn).then(function (r) {
        toast('Daily spin and quest reset for ' + sn + ' (' + (r && r.rows_cleared) + ' row)');
        return refresh();
      }).catch(rvcAdminError);
    };

    window.masterAllUsers = function () {
      if (!isServerAdmin()) return origAll.apply(this, arguments);
      refresh().then(function () { toast('Student list refreshed'); }).catch(function () {});
    };

    window.masterExportCsv = function () {
      if (!isServerAdmin()) {
        // offline fallback: export the local cache
        var d = DB.get();
        var head = ['student_number', 'username', 'level_xp', 'xp', 'coins'];
        var lines = [head.join(',')];
        Object.keys(d).forEach(function (sn) {
          var a = d[sn] || {};
          lines.push([sn, a.user || '', a.lvl || 1, a.xp || 0, a.coins || 0]
            .map(function (v) { return csvCell(v); }).join(','));
        });
        download('revuzz-local-accounts.csv', lines.join('\r\n'));
        return;
      }
      adminCsv().then(function (text) {
        download('revuzz-students-' + todayStr() + '.csv', text);
        toast('CSV downloaded');
      }).catch(rvcAdminError);
    };

    function download(name, text) {
      try {
        var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      } catch (e) { console.warn('[Revuzz] download failed', e); }
    }

    // INIT.master holds the function reference captured when the game script
    // ran, so patching window.masterUI alone would be skipped.
    try { INIT.master = window.masterUI; } catch (e) {}
  }

  function wrapLogin() {
    var originalStep1 = window.step1;
    window.step1 = function () {
      if (!state.online) return originalStep1.apply(this, arguments);

      var sn = $('#sn').value.trim();
      if (!/^\d{6,15}$/.test(sn)) return er(1, 'Student number should be 6-15 digits.');

      state.pendingSn = sn;
      er(1, '');
      var box = $('#verifyBox');
      if (box) { box.style.display = 'none'; box.innerHTML = ''; }

      checkIdentity(sn).then(function (info) {
        if (!info) return;
        if (!info.exists) {
          R.sn = sn;
          stepTo(2);
          return;
        }
        showLoginBox(info.masked_email);
      }).catch(function (e) {
        er(1, friendly(e));
      });
    };

    var originalStep3 = window.step3;
    window.step3 = function () {
      if (!state.online) return originalStep3.apply(this, arguments);

      var username = $('#nm').value.trim();
      if (!$('#confirmChk').checked) return er(3, 'Please confirm that your information is correct.');
      if (!/^\w{3,16}$/.test(username)) return er(3, '3-16 letters, numbers or _');

      var passEl = $('#cloudPassSignup');
      var password = passEl ? passEl.value : '';
      if (password.length < 8) return er(3, 'Choose a password with at least 8 characters.');

      er(3, '');
      checkIdentity(R.sn, username).then(function (info) {
        if (info.sn_taken) throw new Error('That student number already has an account. Log in instead.');
        if (info.username_taken) throw new Error('That username is taken. Try another.');
        return signUp(R.sn, username, password);
      }).catch(function (e) {
        er(3, friendly(e));
      });
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    setTimeout(boot, 0);
  }
})();
