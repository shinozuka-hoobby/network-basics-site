/*
  ネットワークのしくみ — サイト共通スクリプト（v3.1）
  依存ライブラリなし。外部通信は行わない（同一サイト内の assets/*.json の fetch のみ）。
  進捗は localStorage にのみ保存する。

  対応機能:
    - 左サイドバー（aside.sidebar）の生成（assets/curriculum.json を fetch し、
      body の先頭に差し込む）。Part → 章 → ページの木、現在地の強調、読了 ✓ / 完了 ★、
      検索欄の下の「用語集」リンク。
    - モバイル用ドロワー（button[data-menu-toggle]、背景クリックと Esc で閉じる）。
    - テーマ切替（button[data-theme-toggle]。既定ダーク。localStorage "nb:theme"。
      OS の prefers-color-scheme には従わない）。
    - サイト内検索（assets/search-index.json を初回入力時に fetch。2 文字以上で部分一致）。
    - 用語ツールチップ（assets/glossary.json を初回に 1 度だけ fetch。a.term[data-term] への
      ホバー／フォーカス／クリック／タップで吹き出しを表示。§6.8）。
    - details.toc の自動生成（main h2[id] から）。
    - クイズ（3 問正解でそのページを完了扱いにする）。
    - 読了記録（nav.pager が画面に入ったら記録）。
    - 章の入口の ol.page-list[data-chapter-pages] にページ一覧を描画。
    - index.html の学習マップ（[data-learning-map]）と学習記録リセット。
    - 進捗の端末間同期（§6.5、plans/progress-sync.md）: 進捗を章ごと 2 文字の
      コードにして URL フラグメント #p=1.<payload> に常時載せ、開いた端末が
      和集合で取り込む。index.html の「進捗リンクをコピー」でも手動で運べる。

  進捗キーは内容の版を含む（§6.5）: 読了 "nb:read:<page>:<rev>"、完了 "nb:done:<page>:<rev>"。
  rev は body[data-rev]（無ければ "1"）。サイドバー・学習マップの集計は
  assets/curriculum.json の各ページの rev を使う。旧キー（版なし）は読まない。
  同期用の符号化・復号（encodeProgress / decodeProgress）は "progress codec" の
  区間コメントに囲って置き、tools/test_progress_codec.js が単体で検査する。

  ページ種別・現在地は body[data-page] / body[data-chapter] から判定する。
  <script defer> 前提のため、実行時には DOM の解析が終わっている。
*/
(function () {
  "use strict";

  if (!document.body || document.documentElement.hasAttribute("data-nb-initialized")) return;
  document.documentElement.setAttribute("data-nb-initialized", "");

  // ---------- localStorage ヘルパー（例外を握りつぶす） ----------
  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* 容量超過やプライベートモードなどは無視する */
    }
  }
  function safeRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* 無視する */
    }
  }

  // ---------- assets/*.json の共有 fetch ヘルパー（1 度だけ取得してキャッシュする） ----------
  function makeJsonLoader(url) {
    var promise = null;
    return function () {
      if (!promise) {
        promise = fetch(url).then(function (res) {
          if (!res.ok) throw new Error("fetch failed: " + res.status);
          return res.json();
        });
      }
      return promise;
    };
  }

  // ---------- assets/curriculum.json（サイドバー・章入口・学習マップで共有） ----------
  var fetchCurriculum = makeJsonLoader("assets/curriculum.json");

  // ---------- assets/glossary.json（用語ツールチップで共有） ----------
  var fetchGlossaryRaw = makeJsonLoader("assets/glossary.json");
  var glossaryMapPromise = null;
  function fetchGlossaryMap() {
    if (!glossaryMapPromise) {
      glossaryMapPromise = fetchGlossaryRaw().then(function (list) {
        var map = {};
        (list || []).forEach(function (entry) {
          if (entry && entry.id) map[entry.id] = entry;
        });
        return map;
      });
    }
    return glossaryMapPromise;
  }

  // ---------- 進捗キー（§6.5: nb:read:<page>:<rev> / nb:done:<page>:<rev>） ----------
  function currentPageRev() {
    return document.body.dataset.rev || "1";
  }
  function readKey(pageId, rev) {
    return "nb:read:" + pageId + ":" + (rev || "1");
  }
  function doneKey(pageId, rev) {
    return "nb:done:" + pageId + ":" + (rev || "1");
  }

  // ---------- progress codec begin ----------
  // 進捗コードの符号化・復号（§6.5、plans/progress-sync.md）。
  // この区間は DOM・localStorage・fetch に一切触れない純粋関数だけを置く。
  // tools/test_progress_codec.js がこの区間だけを切り出して vm で検査する。
  var PROGRESS_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  var PROGRESS_MAX_PAGES = 5; // STYLE.md §3: 1 章は 3〜5 ページ

  // chapters: assets/curriculum.json の chapters（章の順。各 chapter.pages がページの順）。
  // hasRead(pageId, rev) / hasDone(pageId, rev): 真偽値を返す関数。
  // 戻り値: "1." を含まない payload（章ごと 2 文字、base64url）。
  function encodeProgress(chapters, hasRead, hasDone) {
    var out = "";
    (chapters || []).forEach(function (chapter) {
      var v = 0;
      (chapter.pages || []).forEach(function (page, k) {
        if (k >= PROGRESS_MAX_PAGES) return;
        var rev = page.rev;
        if (hasRead(page.id, rev)) v |= 1 << (2 * k);
        if (hasDone(page.id, rev)) v |= 1 << (2 * k + 1);
      });
      out += PROGRESS_ALPHABET.charAt((v >> 6) & 63) + PROGRESS_ALPHABET.charAt(v & 63);
    });
    return out;
  }

  // payload: "1." で始まる文字列（例 "1.ABAB…"）。
  // 戻り値: 章ごとの 10 ビット整数の配列。不正なら null（"1." で始まらない、
  // payload が奇数長、アルファベット外の文字を含む場合）。
  function decodeProgress(payload) {
    if (typeof payload !== "string" || payload.slice(0, 2) !== "1.") return null;
    var body = payload.slice(2);
    if (body.length % 2 !== 0) return null;
    var values = [];
    for (var i = 0; i < body.length; i += 2) {
      var hi = PROGRESS_ALPHABET.indexOf(body.charAt(i));
      var lo = PROGRESS_ALPHABET.indexOf(body.charAt(i + 1));
      if (hi === -1 || lo === -1) return null;
      values.push((hi << 6) | lo);
    }
    return values;
  }
  // ---------- progress codec end ----------

  // ---------- 進捗の端末間同期（URL フラグメント #p=1.<payload>） ----------
  // 対象ページ: body[data-page] が "index" か "m" 始まり（glossary/sources は対象外）。
  function isProgressSyncPage() {
    var page = document.body.dataset.page;
    return page === "index" || (typeof page === "string" && page.indexOf("m") === 0);
  }

  function progressHasRead(pageId, rev) {
    return !!safeGet(readKey(pageId, rev));
  }
  function progressHasDone(pageId, rev) {
    return !!safeGet(doneKey(pageId, rev));
  }

  // 起動直後の最初の呼び出しだけ「既存フラグメントが #p= 以外なら上書きしない」を
  // 判定する（目次アンカー #recap などのスクロールを妨げないため）。読了・完了の
  // 契機（2 回目以降の呼び出し）は常に上書きしてよい。
  var progressHashChecked = false;

  // data: fetchCurriculum() が解決する値（{chapters: [...]})。
  function writeProgressHash(data) {
    if (!isProgressSyncPage()) return;
    var chapters = (data && data.chapters) || [];
    if (!progressHashChecked) {
      progressHashChecked = true;
      var hash = location.hash;
      if (hash && hash.indexOf("#p=") !== 0) return;
    }
    var payload = encodeProgress(chapters, progressHasRead, progressHasDone);
    history.replaceState(null, "", location.pathname + location.search + "#p=1." + payload);
  }

  // location.hash の #p=1.<payload> を、この端末に無い記録だけ和集合で取り込む。
  // 戻り値: { read: 新規に取り込んだ読了ページ数, done: 同完了ページ数 }。
  function importProgressFromHash(chapters) {
    var result = { read: 0, done: 0 };
    var hash = location.hash;
    if (hash.indexOf("#p=1.") !== 0) return result;
    var values = decodeProgress(hash.slice(3));
    if (!values) return result;
    (chapters || []).forEach(function (chapter, i) {
      if (i >= values.length) return;
      var v = values[i];
      (chapter.pages || []).forEach(function (page, k) {
        if (k >= PROGRESS_MAX_PAGES) return;
        var rev = page.rev;
        if (v & (1 << (2 * k))) {
          var rKey = readKey(page.id, rev);
          if (!safeGet(rKey)) {
            safeSet(rKey, String(Date.now()));
            result.read++;
          }
        }
        if (v & (1 << (2 * k + 1))) {
          var dKey = doneKey(page.id, rev);
          if (!safeGet(dKey)) {
            safeSet(dKey, String(Date.now()));
            result.done++;
          }
        }
      });
    });
    return result;
  }

  function insertSyncNote(readCount, doneCount) {
    var main = document.querySelector("main");
    if (!main) return;
    var p = document.createElement("p");
    p.className = "sync-note";
    p.setAttribute("role", "status");
    p.textContent =
      "別の端末の進捗を取り込みました（読了 " + readCount + " ページ・完了 " + doneCount + " ページ）。";
    // パンくず → 章ラベル → 見出しの並びを崩さないよう、main の先頭に置く。
    main.insertBefore(p, main.firstChild);
  }

  // 起動時に取り込み → 通知 → フラグメント書き込みの順で行う。initSidebar() より
  // 前に呼び、fetchCurriculum() の .then 登録順で取り込みが描画より先になるようにする。
  function initProgressSync() {
    if (!isProgressSyncPage()) return;
    fetchCurriculum()
      .then(function (data) {
        var chapters = (data && data.chapters) || [];
        var result = importProgressFromHash(chapters);
        if (result.read > 0 || result.done > 0) insertSyncNote(result.read, result.done);
        writeProgressHash(data);
      })
      .catch(function () {
        /* curriculum を読み込めなければ同期は諦める（サイドバー側で別途エラーを出す） */
      });
  }

  // ---------- テーマ切替 ----------
  var THEME_KEY = "nb:theme";

  function currentTheme() {
    // 既定はダーク。OS の prefers-color-scheme には従わない。
    return safeGet(THEME_KEY) === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function updateThemeButton(btn) {
    var dark = document.documentElement.getAttribute("data-theme") !== "light";
    var action = dark ? "ライト表示に切替" : "ダーク表示に切替";
    btn.setAttribute("aria-label", action);
    btn.title = action;
    btn.textContent = "◐";
  }

  function initTheme() {
    applyTheme(currentTheme());
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-theme-toggle", "");
    updateThemeButton(btn);
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      safeSet(THEME_KEY, next);
      applyTheme(next);
      updateThemeButton(btn);
    });
    return btn;
  }

  // ---------- モバイルメニュー ----------
  var menuToggleBtn = null;

  function setMenuState(open) {
    var wasOpen = document.body.classList.contains("sidebar-open");
    document.body.classList.toggle("sidebar-open", open);
    if (menuToggleBtn) {
      menuToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuToggleBtn.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
      if (!open && wasOpen) menuToggleBtn.focus();
    }
    if (open) {
      var closeBtn = document.querySelector(".sidebar-close");
      if (closeBtn) closeBtn.focus();
    }
  }

  function toggleMobileMenu() {
    setMenuState(!document.body.classList.contains("sidebar-open"));
  }

  function closeMobileMenu() {
    setMenuState(false);
  }

  function initMenuToggle() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-menu-toggle", "");
    btn.setAttribute("aria-label", "メニューを開く");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "site-sidebar");
    btn.textContent = "☰";
    btn.addEventListener("click", toggleMobileMenu);
    menuToggleBtn = btn;
    return btn;
  }

  function initBackdrop() {
    var el = document.createElement("div");
    el.className = "sidebar-backdrop";
    el.setAttribute("data-menu-backdrop", "");
    el.addEventListener("click", closeMobileMenu);
    return el;
  }

  // ---------- サイドバー ----------
  // rev は assets/curriculum.json のそのページの rev（無ければ "1"）。
  function pageMarks(pageId, rev) {
    var out = "";
    if (safeGet(readKey(pageId, rev))) out += "✓";
    if (safeGet(doneKey(pageId, rev))) out += (out ? " " : "") + "★";
    return out;
  }

  function buildChapterNode(chapter, currentPage, currentChapter) {
    if (chapter.status !== "ready") {
      var note = document.createElement("p");
      note.className = "sidebar-planned-note";
      note.textContent = "第" + chapter.number + "章 " + chapter.title + "（準備中）";
      return note;
    }

    var details = document.createElement("details");
    details.className = "chapter";
    if (chapter.id === currentChapter) {
      details.open = true;
      details.setAttribute("data-current", "true");
    }

    var summary = document.createElement("summary");
    summary.textContent = "第" + chapter.number + "章 " + chapter.title;
    details.appendChild(summary);

    var ul = document.createElement("ul");
    ul.className = "chapter-pages";

    var entryLi = document.createElement("li");
    var entryA = document.createElement("a");
    entryA.href = chapter.id + ".html";
    entryA.className = "entry-link";
    entryA.textContent = "章の入口";
    if (chapter.id === currentPage) entryA.setAttribute("aria-current", "page");
    entryLi.appendChild(entryA);
    ul.appendChild(entryLi);

    (chapter.pages || []).forEach(function (p) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = p.file;
      if (p.id === currentPage) a.setAttribute("aria-current", "page");

      var num = document.createElement("span");
      num.className = "p-num";
      num.textContent = p.number;

      var title = document.createElement("span");
      title.className = "p-title";
      title.textContent = p.title || p.id;

      var marks = document.createElement("span");
      marks.className = "p-mark";
      marks.textContent = pageMarks(p.id, p.rev);

      a.appendChild(num);
      a.appendChild(title);
      a.appendChild(marks);
      li.appendChild(a);
      ul.appendChild(li);
    });

    details.appendChild(ul);
    return details;
  }

  function renderSidebarTree(container, chapters, currentPage, currentChapter) {
    container.innerHTML = "";
    var order = [];
    var byPart = {};
    chapters.forEach(function (ch) {
      if (!byPart[ch.part]) {
        byPart[ch.part] = [];
        order.push(ch.part);
      }
      byPart[ch.part].push(ch);
    });

    order.forEach(function (partName) {
      var partDiv = document.createElement("div");
      partDiv.className = "sidebar-part";
      var label = document.createElement("p");
      label.className = "part-label";
      label.textContent = partName;
      partDiv.appendChild(label);
      byPart[partName].forEach(function (ch) {
        partDiv.appendChild(buildChapterNode(ch, currentPage, currentChapter));
      });
      container.appendChild(partDiv);
    });
  }

  function buildSidebarSkeleton() {
    var aside = document.createElement("aside");
    aside.className = "sidebar";
    aside.id = "site-sidebar";

    var head = document.createElement("div");
    head.className = "sidebar-head";

    var siteName = document.createElement("p");
    siteName.className = "site-name";
    var siteLink = document.createElement("a");
    siteLink.href = "index.html";
    siteLink.textContent = "ネットワークのしくみ";
    siteName.appendChild(siteLink);
    head.appendChild(siteName);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sidebar-close";
    closeBtn.setAttribute("aria-label", "メニューを閉じる");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeMobileMenu);
    head.appendChild(closeBtn);

    aside.appendChild(head);

    var searchWrap = document.createElement("div");
    searchWrap.className = "sidebar-search";

    var input = document.createElement("input");
    input.type = "search";
    input.id = "sidebar-search-input";
    input.name = "q";
    input.placeholder = "サイト内を検索…";
    input.setAttribute("aria-label", "サイト内を全文検索");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("data-search-input", "");
    searchWrap.appendChild(input);

    var results = document.createElement("div");
    results.className = "search-results";
    results.hidden = true;
    results.setAttribute("data-search-results", "");
    searchWrap.appendChild(results);

    aside.appendChild(searchWrap);

    var glossaryP = document.createElement("p");
    glossaryP.className = "sidebar-glossary-link";
    var glossaryA = document.createElement("a");
    glossaryA.href = "glossary.html";
    glossaryA.textContent = "用語集";
    if (document.body.dataset.page === "glossary") {
      glossaryA.setAttribute("aria-current", "page");
    }
    glossaryP.appendChild(glossaryA);
    aside.appendChild(glossaryP);

    var tree = document.createElement("nav");
    tree.className = "sidebar-tree";
    tree.setAttribute("data-sidebar-tree", "");
    tree.setAttribute("aria-label", "章とページの一覧");
    var loading = document.createElement("p");
    loading.className = "sidebar-planned-note";
    loading.textContent = "読み込み中…";
    tree.appendChild(loading);
    aside.appendChild(tree);

    return aside;
  }

  function initSidebar() {
    var aside = buildSidebarSkeleton();
    document.body.insertBefore(aside, document.body.firstChild);

    var backdrop = initBackdrop();
    document.body.insertBefore(backdrop, aside.nextSibling);

    var menuBtn = initMenuToggle();
    document.body.insertBefore(menuBtn, backdrop.nextSibling);

    var themeBtn = initTheme();
    document.body.insertBefore(themeBtn, menuBtn.nextSibling);

    var tree = aside.querySelector("[data-sidebar-tree]");
    fetchCurriculum()
      .then(function (data) {
        renderSidebarTree(
          tree,
          data.chapters || [],
          document.body.dataset.page,
          document.body.dataset.chapter
        );
      })
      .catch(function () {
        tree.innerHTML = "";
        var p = document.createElement("p");
        p.className = "sidebar-planned-note";
        p.textContent =
          "目次を読み込めませんでした。再読み込みするか、本文のリンクをご利用ください。";
        tree.appendChild(p);
      });

    initSearchBox(aside);
  }

  // ---------- サイト内検索 ----------
  var searchIndexPromise = null;
  function fetchSearchIndex() {
    if (!searchIndexPromise) {
      searchIndexPromise = fetch("assets/search-index.json").then(function (res) {
        if (!res.ok) throw new Error("fetch failed: " + res.status);
        return res.json();
      });
    }
    return searchIndexPromise;
  }

  function appendExcerpt(container, text, query) {
    var lower = text.toLowerCase();
    var idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) {
      container.textContent = text.slice(0, 80);
      return;
    }
    var context = 30;
    var start = Math.max(0, idx - context);
    var end = Math.min(text.length, idx + query.length + context);
    if (start > 0) container.appendChild(document.createTextNode("…"));
    container.appendChild(document.createTextNode(text.slice(start, idx)));
    var mark = document.createElement("mark");
    mark.textContent = text.slice(idx, idx + query.length);
    container.appendChild(mark);
    container.appendChild(document.createTextNode(text.slice(idx + query.length, end)));
    if (end < text.length) container.appendChild(document.createTextNode("…"));
  }

  function findMatch(entry, q) {
    if (entry.title && entry.title.toLowerCase().indexOf(q) !== -1) {
      return { field: "title", text: entry.title };
    }
    if (entry.lead && entry.lead.toLowerCase().indexOf(q) !== -1) {
      return { field: "lead", text: entry.lead };
    }
    if (entry.body && entry.body.toLowerCase().indexOf(q) !== -1) {
      return { field: "body", text: entry.body };
    }
    return null;
  }

  function renderSearchResults(container, entries, query) {
    container.innerHTML = "";
    var q = query.toLowerCase();
    var matches = [];
    for (var i = 0; i < entries.length && matches.length < 20; i++) {
      var m = findMatch(entries[i], q);
      if (m) matches.push({ entry: entries[i], text: m.text });
    }

    var count = document.createElement("p");
    count.className = "result-count";
    count.textContent =
      matches.length + " 件ヒット" + (matches.length >= 20 ? "（先頭 20 件を表示）" : "");
    container.appendChild(count);

    if (matches.length === 0) {
      var none = document.createElement("p");
      none.className = "no-results";
      none.textContent = "一致するページが見つかりませんでした。";
      container.appendChild(none);
      return;
    }

    var ul = document.createElement("ul");
    matches.forEach(function (m) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = m.entry.file;

      var num = document.createElement("span");
      num.className = "r-num";
      num.textContent = m.entry.kind === "chapter" ? "第" + m.entry.number + "章" : m.entry.number;

      var title = document.createElement("span");
      title.className = "r-title";
      title.textContent = m.entry.title || m.entry.id;

      var excerpt = document.createElement("span");
      excerpt.className = "r-excerpt";
      appendExcerpt(excerpt, m.text, query);

      a.appendChild(num);
      a.appendChild(title);
      a.appendChild(excerpt);
      li.appendChild(a);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  function initSearchBox(aside) {
    var input = aside.querySelector("[data-search-input]");
    var results = aside.querySelector("[data-search-results]");
    var tree = aside.querySelector("[data-sidebar-tree]");
    if (!input || !results || !tree) return;

    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length < 2) {
        results.hidden = true;
        results.innerHTML = "";
        tree.hidden = false;
        return;
      }
      tree.hidden = true;
      results.hidden = false;
      fetchSearchIndex()
        .then(function (data) {
          if (input.value.trim() !== q) return;
          renderSearchResults(results, data.pages || [], q);
        })
        .catch(function () {
          if (input.value.trim() !== q) return;
          tree.hidden = false;
          results.innerHTML = "";
          var p = document.createElement("p");
          p.className = "no-results";
          p.textContent = "検索索引を読み込めませんでした。";
          results.appendChild(p);
        });
    });
  }

  function clearSearchGlobal() {
    var input = document.querySelector("[data-search-input]");
    var results = document.querySelector("[data-search-results]");
    var tree = document.querySelector("[data-sidebar-tree]");
    if (!input || !input.value) return false;
    input.value = "";
    if (results) {
      results.hidden = true;
      results.innerHTML = "";
    }
    if (tree) tree.hidden = false;
    return true;
  }

  // ---------- 用語ツールチップ（a.term[data-term]、§6.8） ----------
  // 吹き出しは 1 つだけ DOM 上に用意し、開くたびに対象の a.term の直後へ移動させる
  // （タブ順を自然に保つため、body の末尾に固定で置かない）。
  var termTipEl = null;
  var openTip = null; // { anchor, pinned } | null

  function ensureTermTipEl() {
    if (termTipEl) return termTipEl;
    var tip = document.createElement("div");
    tip.className = "term-tip";
    tip.id = "nb-term-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    termTipEl = tip;
    return tip;
  }

  function positionTermTip(tip, anchor) {
    var margin = 8;
    var rect = anchor.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;

    var left = rect.left;
    if (left + tw > vw - margin) left = Math.max(margin, rect.right - tw);
    if (left < margin) left = margin;

    var top = rect.bottom + 6;
    if (top + th > vh - margin) top = Math.max(margin, rect.top - th - 6);

    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function renderTermTipContent(tip, entry) {
    tip.innerHTML = "";
    var p = document.createElement("p");
    p.className = "term-tip-short";
    p.textContent = entry.short || "";
    tip.appendChild(p);

    var links = document.createElement("p");
    links.className = "term-tip-links";

    var m = /^m(\d{2})-(\d)$/.exec(entry.defined_in || "");
    if (m) {
      var chapterNum = parseInt(m[1], 10);
      var pageLabel = chapterNum + "-" + m[2];
      var defA = document.createElement("a");
      defA.href = entry.defined_in + ".html";
      defA.textContent = "詳しくは第 " + chapterNum + " 章 " + pageLabel + " →";
      links.appendChild(defA);
    }

    var glossA = document.createElement("a");
    glossA.href = "glossary.html#" + entry.id;
    glossA.textContent = "用語集で見る";
    links.appendChild(glossA);

    tip.appendChild(links);
  }

  function hideTermTip() {
    if (!openTip) return;
    if (termTipEl) termTipEl.hidden = true;
    openTip.anchor.removeAttribute("aria-describedby");
    openTip = null;
  }

  function closeTermTipIfOpen() {
    if (!openTip) return false;
    hideTermTip();
    return true;
  }

  function showTermTip(anchor, glossaryMap, pinned) {
    var entry = glossaryMap[anchor.dataset.term];
    if (!entry) return;
    if (openTip && openTip.anchor !== anchor) hideTermTip();

    var tip = ensureTermTipEl();
    renderTermTipContent(tip, entry);
    // 吹き出しは body 直下に置いたまま使う（段落の中へ移すと div.dialog p::before の装飾が当たる）
    if (tip.parentNode !== document.body) document.body.appendChild(tip);
    tip.hidden = false;
    positionTermTip(tip, anchor);
    anchor.setAttribute("aria-describedby", tip.id);
    openTip = { anchor: anchor, pinned: !!(openTip && openTip.anchor === anchor && openTip.pinned) || !!pinned };
  }

  function initGlossaryTerms() {
    var anchors = Array.prototype.slice.call(document.querySelectorAll("a.term[data-term]"));
    if (!anchors.length) return;

    fetchGlossaryMap()
      .then(function (glossaryMap) {
        anchors.forEach(function (anchor) {
          anchor.addEventListener("mouseenter", function () {
            showTermTip(anchor, glossaryMap, false);
          });
          anchor.addEventListener("mouseleave", function () {
            if (openTip && openTip.anchor === anchor && !openTip.pinned) hideTermTip();
          });
          anchor.addEventListener("focus", function () {
            showTermTip(anchor, glossaryMap, false);
          });
          anchor.addEventListener("blur", function () {
            if (openTip && openTip.anchor === anchor && !openTip.pinned) hideTermTip();
          });
          anchor.addEventListener("click", function (e) {
            // glossaryMap にその data-term が無い場合（未登録 id など）は、吹き出しを
            // 出せないまま遷移だけ止めてしまわないよう、既定のリンク動作に任せる。
            if (!glossaryMap[anchor.dataset.term]) return;
            e.preventDefault();
            if (openTip && openTip.anchor === anchor) {
              if (openTip.pinned) {
                hideTermTip();
              } else {
                openTip.pinned = true;
              }
            } else {
              showTermTip(anchor, glossaryMap, true);
            }
          });
        });

        // 開いた吹き出しの外側をタップ／クリックすると閉じる。
        document.addEventListener("pointerdown", function (e) {
          if (!openTip || !termTipEl) return;
          var target = e.target;
          if (termTipEl.contains(target) || openTip.anchor.contains(target)) return;
          hideTermTip();
        });

        window.addEventListener("scroll", function () {
          if (openTip && termTipEl) positionTermTip(termTipEl, openTip.anchor);
        }, true);
        window.addEventListener("resize", function () {
          if (openTip && termTipEl) positionTermTip(termTipEl, openTip.anchor);
        });
      })
      .catch(function () {
        // assets/glossary.json の読み込みに失敗したら、a.term は普通のリンクとして
        // 用語集ページへ遷移させる（href="glossary.html#<id>" のまま何もしない）。
      });
  }

  // ---------- Esc キー（吹き出し → 検索結果 → ドロワーの順に 1 つずつ閉じる） ----------
  function initEscHandler() {
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (closeTermTipIfOpen()) return;
      if (clearSearchGlobal()) return;
      if (document.body.classList.contains("sidebar-open")) {
        closeMobileMenu();
      }
    });
  }

  // ---------- details.toc の自動生成 ----------
  function initTOC() {
    var toc = document.querySelector("details.toc");
    var main = document.querySelector("main");
    if (!toc || !main) return;

    var headings = Array.prototype.slice.call(main.querySelectorAll("h2[id]"));
    if (headings.length === 0) {
      toc.hidden = true;
      return;
    }

    var ul = document.createElement("ul");
    headings.forEach(function (h) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      ul.appendChild(li);
    });
    toc.appendChild(ul);
  }

  // ---------- 読了記録（nav.pager が画面に入ったら記録） ----------
  function initReadTracking() {
    var pager = document.querySelector("nav.pager");
    var pageId = document.body.dataset.page;
    if (!pager || !pageId) return;

    var key = readKey(pageId, currentPageRev());
    if (safeGet(key)) return;

    if (!("IntersectionObserver" in window)) {
      // フォールバック: 観測できない環境ではページ表示時点で記録する。
      safeSet(key, String(Date.now()));
      fetchCurriculum().then(writeProgressHash);
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            safeSet(key, String(Date.now()));
            fetchCurriculum().then(writeProgressHash);
            observer.disconnect();
          }
        });
      },
      { threshold: 0 }
    );
    observer.observe(pager);
  }

  // ---------- クイズ ----------
  function initQuiz() {
    var quizEl = document.querySelector("div.quiz");
    if (!quizEl) return;

    var quizId = quizEl.getAttribute("data-quiz") || document.body.dataset.page;
    if (!quizId) return;

    var questions = Array.prototype.slice.call(quizEl.querySelectorAll("div.q"));
    var solved = new Set();

    questions.forEach(function (q) {
      var buttons = Array.prototype.slice.call(q.querySelectorAll("ol.opts button"));
      var feedback = q.querySelector("p.feedback");
      var retryBtn = null;
      if (feedback) feedback.setAttribute("aria-live", "polite");

      function lockButtons() {
        buttons.forEach(function (b) {
          b.disabled = true;
        });
      }
      function unlockButtons() {
        buttons.forEach(function (b) {
          b.disabled = false;
          b.classList.remove("is-correct", "is-incorrect");
        });
      }
      function removeRetry() {
        if (retryBtn) {
          retryBtn.remove();
          retryBtn = null;
        }
      }
      function showFeedback(isCorrect) {
        if (!feedback) return;
        var explain = feedback.getAttribute("data-explain") || "";
        var prefix = isCorrect ? "正解。" : "不正解。";
        feedback.textContent = explain ? prefix + " " + explain : prefix;
        feedback.classList.toggle("is-correct", isCorrect);
        feedback.classList.toggle("is-incorrect", !isCorrect);
      }
      function clearFeedback() {
        if (!feedback) return;
        feedback.textContent = "";
        feedback.classList.remove("is-correct", "is-incorrect");
      }

      buttons.forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (btn.disabled) return;
          var isCorrect = btn.getAttribute("data-correct") === "true";
          lockButtons();
          btn.classList.add(isCorrect ? "is-correct" : "is-incorrect");
          showFeedback(isCorrect);
          removeRetry();

          if (isCorrect) {
            solved.add(q);
            if (solved.size === questions.length) {
              markPageDone(quizId, quizEl);
            }
          } else {
            retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className = "retry-btn";
            retryBtn.textContent = "もう一度";
            retryBtn.addEventListener("click", function () {
              unlockButtons();
              clearFeedback();
              removeRetry();
              btn.focus();
            });
            if (feedback) {
              feedback.insertAdjacentElement("afterend", retryBtn);
            } else {
              q.appendChild(retryBtn);
            }
          }
        });
      });
    });

    if (safeGet(doneKey(quizId, currentPageRev()))) {
      appendDoneBanner(quizEl);
    }
  }

  function markPageDone(pageId, quizEl) {
    safeSet(doneKey(pageId, currentPageRev()), String(Date.now()));
    fetchCurriculum().then(writeProgressHash);
    appendDoneBanner(quizEl);
  }

  function appendDoneBanner(quizEl) {
    if (quizEl.querySelector(".quiz-done")) return;
    var p = document.createElement("p");
    p.className = "quiz-done";
    p.textContent = "このページは完了です";
    quizEl.appendChild(p);
  }

  // ---------- 章の入口: ol.page-list[data-chapter-pages] ----------
  function initChapterPageList() {
    var el = document.querySelector("ol.page-list[data-chapter-pages]");
    if (!el) return;
    var chapterId = el.getAttribute("data-chapter-pages");
    if (!chapterId) return;

    fetchCurriculum()
      .then(function (data) {
        var chapter = (data.chapters || []).filter(function (c) {
          return c.id === chapterId;
        })[0];
        if (!chapter) return;

        el.innerHTML = "";
        (chapter.pages || []).forEach(function (p) {
          var li = document.createElement("li");
          li.className = "page-item";

          var a = document.createElement("a");
          a.href = p.file;

          var num = document.createElement("span");
          num.className = "p-num";
          num.textContent = p.number;

          var body = document.createElement("span");
          body.className = "p-body";
          var title = document.createElement("span");
          title.className = "p-title";
          title.textContent = p.title || p.id;
          var lead = document.createElement("span");
          lead.className = "p-lead";
          lead.textContent = p.lead || "";
          body.appendChild(title);
          body.appendChild(lead);

          var marks = document.createElement("span");
          marks.className = "p-marks";
          marks.textContent = pageMarks(p.id, p.rev);

          a.appendChild(num);
          a.appendChild(body);
          a.appendChild(marks);
          li.appendChild(a);
          el.appendChild(li);
        });
      })
      .catch(function () {
        if (!el.children.length) {
          var li = document.createElement("li");
          li.textContent = "ページ一覧を読み込めませんでした。再読み込みしてください。";
          el.appendChild(li);
        }
      });
  }

  // ---------- index.html の学習マップ ----------
  function buildChapterCard(ch) {
    var isReady = ch.status === "ready";
    var pages = ch.pages || [];
    var total = pages.length;
    var readCount = 0;
    var doneCount = 0;
    pages.forEach(function (p) {
      if (safeGet(readKey(p.id, p.rev))) readCount++;
      if (safeGet(doneKey(p.id, p.rev))) doneCount++;
    });
    var allDone = isReady && total > 0 && doneCount === total;

    var card;
    if (isReady) {
      card = document.createElement("a");
      card.href = ch.id + ".html";
      card.className = "chapter-card";
    } else {
      card = document.createElement("div");
      card.className = "chapter-card is-planned";
      card.setAttribute("aria-disabled", "true");
      card.setAttribute("tabindex", "-1");
    }

    var num = document.createElement("p");
    num.className = "num";
    num.textContent = "第" + ch.number + "章";
    card.appendChild(num);

    var h3 = document.createElement("h3");
    h3.textContent = ch.title;
    card.appendChild(h3);

    if (isReady) {
      var progress = document.createElement("p");
      progress.className = "progress";
      progress.textContent = total > 0 ? "読了 " + readCount + "/" + total + " ページ" : "ページ準備中";
      card.appendChild(progress);
      if (allDone) {
        var stamp = document.createElement("p");
        stamp.className = "stamp";
        stamp.textContent = "★ 完了";
        card.appendChild(stamp);
      }
    } else {
      var badge = document.createElement("p");
      badge.className = "badge";
      badge.textContent = "準備中";
      card.appendChild(badge);
    }

    return card;
  }

  function renderLearningMap(root, chapters) {
    root.innerHTML = "";
    var order = [];
    var byPart = {};
    chapters.forEach(function (ch) {
      if (!byPart[ch.part]) {
        byPart[ch.part] = [];
        order.push(ch.part);
      }
      byPart[ch.part].push(ch);
    });

    order.forEach(function (partName) {
      var section = document.createElement("section");
      section.className = "map-part";
      var title = document.createElement("p");
      title.className = "part-title";
      title.textContent = partName;
      section.appendChild(title);

      var cardsDiv = document.createElement("div");
      cardsDiv.className = "cards";
      byPart[partName].forEach(function (ch) {
        cardsDiv.appendChild(buildChapterCard(ch));
      });
      section.appendChild(cardsDiv);
      root.appendChild(section);
    });
  }

  function initLearningMap() {
    var root = document.querySelector("[data-learning-map]");
    if (!root) return;

    fetchCurriculum()
      .then(function (data) {
        renderLearningMap(root, data.chapters || []);
      })
      .catch(function () {
        root.innerHTML =
          '<p class="map-error">学習マップを読み込めませんでした。' +
          '再読み込みするか、<a href="m01.html">第1章の入口</a>から読み進めてください。</p>';
      });
  }

  // ---------- 学習記録リセット ----------
  function initResetProgress() {
    document.querySelectorAll("[data-reset-progress]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var ok = window.confirm(
          "この端末に保存された読了記録とクイズの正解記録をすべて削除します。よろしいですか？"
        );
        if (!ok) return;
        var keys = [];
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            // nb:theme（テーマ設定）以外の nb: キーをすべて消す（§6.5）。
            if (key && key.indexOf("nb:") === 0 && key !== THEME_KEY) {
              keys.push(key);
            }
          }
        } catch (e) {
          /* 保存領域にアクセスできない環境では削除を省略する。 */
        }
        keys.forEach(safeRemove);
        history.replaceState(null, "", location.pathname + location.search);
        window.location.reload();
      });
    });
  }

  // ---------- 「進捗リンクをコピー」ボタン（index.html、button[data-copy-progress]） ----------
  function progressShareUrl(payload) {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html#p=1." + payload;
  }

  // クリップボードに書き込めない場合のフォールバック: ボタンの直後に読み取り専用の
  // input を出し、.sync-help の下に操作方法の一文を添える（初回だけ）。
  function showCopyFallback(btn, url) {
    var input = document.querySelector("input.sync-url");
    if (!input) {
      input = document.createElement("input");
      input.type = "text";
      input.readOnly = true;
      input.className = "sync-url";
      btn.insertAdjacentElement("afterend", input);
    }
    input.value = url;

    if (!document.querySelector("p.sync-fallback-note")) {
      var help = document.querySelector("p.sync-help");
      var note = document.createElement("p");
      note.className = "sync-help sync-fallback-note";
      note.textContent = "長押し／⌘C でコピーしてください。";
      if (help) {
        help.insertAdjacentElement("afterend", note);
      } else {
        btn.insertAdjacentElement("afterend", note);
      }
    }

    input.focus();
    input.select();
  }

  function initCopyProgress() {
    var btn = document.querySelector("button[data-copy-progress]");
    if (!btn) return;
    var defaultLabel = btn.textContent;
    var resetTimer = null;

    btn.addEventListener("click", function () {
      fetchCurriculum()
        .then(function (data) {
          var chapters = (data && data.chapters) || [];
          var payload = encodeProgress(chapters, progressHasRead, progressHasDone);
          var url = progressShareUrl(payload);

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(
              function () {
                if (resetTimer) window.clearTimeout(resetTimer);
                btn.textContent = "コピーしました";
                resetTimer = window.setTimeout(function () {
                  btn.textContent = defaultLabel;
                  resetTimer = null;
                }, 2000);
              },
              function () {
                showCopyFallback(btn, url);
              }
            );
          } else {
            showCopyFallback(btn, url);
          }
        })
        .catch(function () {
          /* curriculum を読み込めなければコピーできない（ボタンは何もしない） */
        });
    });
  }

  // ---------- 起動 ----------
  initProgressSync();
  initSidebar();
  initEscHandler();
  initTOC();
  initReadTracking();
  initQuiz();
  initChapterPageList();
  initLearningMap();
  initResetProgress();
  initGlossaryTerms();
  initCopyProgress();
})();
