(function () {
  "use strict";
  var SITE = window.SITE, AGENTS = window.AGENTS, SCENES = window.SCENES, WONT = window.WONT, TRACKS = window.TRACKS;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------- pictures sent in the thread (drawn, like the product's own images) ---------- */
  var PICS = {
    couch:
      '<svg viewBox="0 0 280 170" role="img" aria-label="A cream loveseat"><rect width="280" height="170" fill="#EFE9DF"/><rect y="128" width="280" height="42" fill="#E3DACB"/>' +
      '<rect x="46" y="62" width="188" height="58" rx="22" fill="#F7F2E8" stroke="#D9CFBD"/><rect x="34" y="82" width="34" height="52" rx="16" fill="#F2EBDD" stroke="#D9CFBD"/><rect x="212" y="82" width="34" height="52" rx="16" fill="#F2EBDD" stroke="#D9CFBD"/>' +
      '<rect x="56" y="96" width="168" height="38" rx="14" fill="#FBF8F1" stroke="#D9CFBD"/><line x1="140" y1="98" x2="140" y2="132" stroke="#E2D9C8"/><rect x="62" y="134" width="8" height="12" rx="3" fill="#8B7B63"/><rect x="210" y="134" width="8" height="12" rx="3" fill="#8B7B63"/></svg>',
    room:
      '<svg viewBox="0 0 280 170" role="img" aria-label="A bedroom"><rect width="280" height="170" fill="#E7EEF5"/><rect y="124" width="280" height="46" fill="#D8C7AE"/>' +
      '<rect x="176" y="22" width="76" height="62" rx="4" fill="#CFE4F7" stroke="#fff" stroke-width="5"/><line x1="214" y1="22" x2="214" y2="84" stroke="#fff" stroke-width="3"/>' +
      '<rect x="28" y="80" width="130" height="50" rx="10" fill="#fff" stroke="#D5DBE3"/><rect x="28" y="70" width="130" height="24" rx="10" fill="#9DB8D6"/><rect x="36" y="76" width="38" height="14" rx="7" fill="#fff"/></svg>',
    ledger:
      '<svg viewBox="0 0 280 200" role="img" aria-label="The Ledger card"><rect width="280" height="200" fill="#F3F2EE"/>' +
      '<rect x="14" y="14" width="18" height="18" rx="5" fill="#0E0F0C"/><rect x="18" y="19" width="10" height="2" rx="1" fill="#F3F2EE" opacity=".6"/><rect x="18" y="23" width="7" height="2" rx="1" fill="#D4F26A"/>' +
      '<text x="38" y="28" font-family="Onest,Inter,sans-serif" font-size="11" font-weight="600" fill="#0E0F0C">Elves Ledger</text><text x="266" y="28" text-anchor="end" font-family="Onest,Inter,sans-serif" font-size="9" fill="#77786F">Live from Nessie</text>' +
      '<text x="14" y="52" font-family="Onest,Inter,sans-serif" font-size="9.5" fill="#77786F">Net cost so far</text><text x="12" y="88" font-family="Onest,Inter,sans-serif" font-size="38" font-weight="600" letter-spacing="-1.6" fill="#0E0F0C">$740</text>' +
      '<rect x="14" y="100" width="54" height="16" rx="6" fill="#D4F26A"/><text x="22" y="111.5" font-family="Onest,Inter,sans-serif" font-size="9.5" font-weight="600" fill="#0E0F0C">Projected</text><text x="76" y="112" font-family="Onest,Inter,sans-serif" font-size="11" font-weight="600" fill="#0E0F0C">$114</text><text x="102" y="112" font-family="Onest,Inter,sans-serif" font-size="9.5" fill="#77786F">net, by Dec 1</text>' +
      '<rect x="14" y="126" width="252" height="60" rx="12" fill="#fff" stroke="#E4E3DD"/><path d="M26 140 H92 V150 H190 V172 H254" fill="none" stroke="#0E0F0C" stroke-width="1.6" stroke-linejoin="round"/><circle cx="26" cy="140" r="3" fill="#0E0F0C"/><circle cx="254" cy="172" r="3.6" fill="#D4F26A" stroke="#0E0F0C" stroke-width="1.4"/></svg>',
    plans:
      '<svg viewBox="0 0 280 190" role="img" aria-label="Three plans with the odds of each"><rect width="280" height="190" fill="#F3F2EE"/>' +
      '<text x="14" y="26" font-family="Onest,Inter,sans-serif" font-size="9.5" fill="#77786F">Move plans under $300</text><text x="14" y="50" font-family="Onest,Inter,sans-serif" font-size="18" font-weight="600" letter-spacing="-.5" fill="#0E0F0C">Three ways to finish</text>' +
      [["A", "Best odds", 92, 74], ["B", "Runner-up", 81, 112], ["C", "Least effort", 54, 150]].map(function (p) {
        return '<rect x="14" y="' + (p[3] - 14) + '" width="252" height="34" rx="10" fill="#fff" stroke="#E4E3DD"/><rect x="22" y="' + (p[3] - 6) + '" width="18" height="18" rx="5" fill="' + (p[0] === "A" ? "#D4F26A" : "#EEEDE8") + '"/><text x="31" y="' + (p[3] + 7) + '" text-anchor="middle" font-family="Onest,Inter,sans-serif" font-size="10" font-weight="600" fill="#0E0F0C">' + p[0] + "</text>" +
          '<text x="48" y="' + (p[3] + 2) + '" font-family="Onest,Inter,sans-serif" font-size="10.5" font-weight="500" fill="#0E0F0C">' + p[1] + '</text><rect x="48" y="' + (p[3] + 9) + '" width="150" height="3" rx="1.5" fill="#E9E8E2"/><rect x="48" y="' + (p[3] + 9) + '" width="' + (150 * p[2] / 100) + '" height="3" rx="1.5" fill="#0E0F0C"/>' +
          '<text x="256" y="' + (p[3] + 8) + '" text-anchor="end" font-family="Onest,Inter,sans-serif" font-size="14" font-weight="600" fill="#0E0F0C">' + p[2] + "%</text>";
      }).join("") + "</svg>",
  };

  /* ---------- phone ---------- */
  function Phone(root) {
    this.root = root;
    root.innerHTML =
      '<div class="ph-top"><div class="ph-av" aria-hidden="true">E</div><div class="ph-name"><b>Elves</b> · iMessage</div></div>' +
      '<div class="ph-body" role="log" aria-live="polite"></div>' +
      '<div class="ph-input"><span>iMessage</span><i aria-hidden="true"></i></div>';
    this.body = $(".ph-body", root);
    this.token = 0;
  }
  Phone.prototype.clear = function () { this.token++; this.body.innerHTML = ""; };
  Phone.prototype.scroll = function () { this.body.scrollTop = this.body.scrollHeight; };
  Phone.prototype.add = function (m, lastAgent) {
    var row = el("div", "row " + m.from);
    if (m.from === "elf") {
      var a = AGENTS[m.agent] || AGENTS.crew;
      if (lastAgent !== m.agent) row.appendChild(el("div", "who", '<i class="' + a.tone + '"></i>' + esc(a.name)));
    }
    if (m.img && m.from === "you") row.appendChild(el("div", "pic", PICS[m.img]));
    row.appendChild(el("div", "bub", esc(m.text)));
    if (m.img && m.from === "elf") row.appendChild(el("div", "pic", PICS[m.img]));
    this.body.appendChild(row);
    this.scroll();
  };
  Phone.prototype.play = async function (scene, opts) {
    opts = opts || {};
    if (!opts.keep) this.clear();
    var t = this.token, last = null, i;
    if (reduce) { for (i = 0; i < scene.msgs.length; i++) { this.add(scene.msgs[i], last); last = scene.msgs[i].agent || null; } return; }
    for (i = 0; i < scene.msgs.length; i++) {
      var m = scene.msgs[i];
      if (m.from === "elf") {
        var dots = el("div", "typing", "<i></i><i></i><i></i>");
        this.body.appendChild(dots); this.scroll();
        await sleep(Math.min(1500, 520 + m.text.length * 6));
        if (t !== this.token) return;
        dots.remove();
      } else {
        await sleep(i === 0 ? 350 : 650);
        if (t !== this.token) return;
      }
      this.add(m, last); last = m.from === "elf" ? m.agent : null;
      await sleep(260);
      if (t !== this.token) return;
    }
  };

  var sceneById = {}; SCENES.forEach(function (s) { sceneById[s.id] = s; });

  /* ---------- hero: a short loop of three real moments ---------- */
  var hero = new Phone($("#phone-hero"));
  var heroLoop = ["crew-refuse", "stuff-sell", "money-plan"];
  var heroOn = false, heroIdx = 0;
  async function heroRun() {
    if (heroOn) return; heroOn = true;
    while (heroOn) {
      await hero.play(sceneById[heroLoop[heroIdx % heroLoop.length]]);
      if (reduce) break;
      await sleep(3600);
      heroIdx++;
    }
    heroOn = false;
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) heroRun(); else if (!reduce) { heroOn = false; hero.token++; } }); }, { threshold: 0.25 }).observe($("#phone-hero"));
  } else heroRun();

  /* ---------- the crew emulator ---------- */
  var main = new Phone($("#phone-main"));
  var tabs = $("#agent-tabs"), funcs = $("#funcs"), blurb = $("#agent-blurb"), wont = $("#wont"), line = $("#scene-line");
  var currentAgent = "crew", currentScene = null, started = false;
  Object.keys(AGENTS).forEach(function (k) {
    var b = el("button", null, esc(AGENTS[k].name)); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.agent = k;
    b.addEventListener("click", function () { pickAgent(k, true); }); tabs.appendChild(b);
  });
  function pickAgent(k, play) {
    currentAgent = k;
    Array.prototype.forEach.call(tabs.children, function (b) { b.setAttribute("aria-selected", String(b.dataset.agent === k)); });
    blurb.textContent = AGENTS[k].blurb;
    funcs.innerHTML = "";
    SCENES.filter(function (s) { return s.agent === k; }).forEach(function (s) {
      var li = el("li"), b = el("button", null, "<b>" + esc(s.title) + "</b><span>" + esc(s.line) + "</span><i></i>");
      b.type = "button"; b.dataset.scene = s.id; b.addEventListener("click", function () { pickScene(s.id); });
      li.appendChild(b); funcs.appendChild(li);
    });
    wont.innerHTML = (WONT[k] || []).map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("");
    if (play) pickScene(SCENES.filter(function (s) { return s.agent === k; })[0].id);
  }
  function pickScene(id) {
    var s = sceneById[id]; if (!s) return;
    if (s.agent !== currentAgent) pickAgent(s.agent, false);
    currentScene = s;
    Array.prototype.forEach.call(funcs.querySelectorAll("button"), function (b) { b.setAttribute("aria-current", String(b.dataset.scene === id)); });
    line.textContent = s.line;
    main.play(s);
  }
  $("#replay").addEventListener("click", function () { if (currentScene) main.play(currentScene); });
  pickAgent("crew", false);
  var stageEl = $("#phone-main");
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es, o) { es.forEach(function (e) { if (e.isIntersecting && !started) { started = true; pickScene("crew-intro"); o.disconnect(); } }); }, { threshold: 0.4 }).observe(stageEl);
  } else pickScene("crew-intro");

  /* ---------- tracks ---------- */
  var tt = $("#track-tabs"), tr = $("#track");
  TRACKS.forEach(function (t) {
    var b = el("button", null, esc(t.name)); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.track = t.id;
    b.addEventListener("click", function () { showTrack(t.id); }); tt.appendChild(b);
  });
  function showTrack(id) {
    var t = TRACKS.filter(function (x) { return x.id === id; })[0];
    Array.prototype.forEach.call(tt.children, function (b) { b.setAttribute("aria-selected", String(b.dataset.track === id)); });
    tr.innerHTML =
      '<div class="track-head"><h3>' + esc(t.head) + '</h3><button class="btn small" type="button" id="see">See it in the thread</button><ul class="apis" aria-label="What we used">' +
      t.apis.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul></div>" +
      '<ul class="points">' + t.points.map(function (p) { return "<li><b>" + esc(p[0]) + "</b><span>" + esc(p[1]) + "</span></li>"; }).join("") + "</ul>";
    $("#see").addEventListener("click", function () {
      started = true; document.getElementById("crew").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
      setTimeout(function () { pickScene(t.scene); }, reduce ? 0 : 450);
    });
  }
  showTrack("photon");

  /* ---------- interview video, night photos, number, repo ---------- */
  var v = $("#video");
  if (SITE.interviewYouTubeId) v.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(SITE.interviewYouTubeId) + '?rel=0&playsinline=1" title="What people told us about moving" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>';
  else v.innerHTML = '<div class="empty"><span class="play"></span><span>Interview Short goes here</span></div>';

  var night = $("#night");
  if (SITE.nightPhotos && SITE.nightPhotos.length) SITE.nightPhotos.forEach(function (src, i) { var f = el("figure"); var im = new Image(); im.src = src; im.alt = "The team coding through the night, photo " + (i + 1); im.loading = "lazy"; f.appendChild(im); night.appendChild(f); });
  else night.appendChild(el("div", "drop", "<b>Photos of us coding through the night go here</b>Drop images into site/assets/night and list them in site/data.js"));

  var num = $("#number");
  if (SITE.number) { num.textContent = SITE.number; } else { num.classList.add("empty"); num.textContent = "The number goes here"; }
  $("#repo").href = SITE.repoUrl;

  /* ---------- reveal on scroll ---------- */
  var rev = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    rev.forEach(function (n) { io.observe(n); });
  } else rev.forEach(function (n) { n.classList.add("in"); });
})();
