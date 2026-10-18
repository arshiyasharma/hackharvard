(function () {
  "use strict";
  var SITE = window.SITE, AGENTS = window.AGENTS, SCENES = window.SCENES, WONT = window.WONT, TRACKS = window.TRACKS;
  var ICONS = window.ICONS, DEAL = window.DEAL, STORY = window.STORY, CHIPS = window.CHIPS, STACK = window.STACK, UNIQUE = window.UNIQUE, FUTURE = window.FUTURE, NIGHT = window.NIGHT;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var el = function (tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var easeInOut = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  var easeBack = function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  var seg = function (p, a, b) { return clamp((p - a) / (b - a), 0, 1); };

  /* ---------- the Elves, drawn: a face and a pointed hat ---------- */
  var TONES = {
    blue: ["#5db0ff", "#0a84ff", "#10243a", "#ffffff", "#3d9bff"],
    red: ["#ffa9a9", "#e5585c", "#3a1517", "#ffffff", "#f27478"],
    amber: ["#ffd96b", "#e9a400", "#3a2a05", "#ffffff", "#f5b82e"],
    green: ["#7fe0ab", "#2a9d63", "#0b4a2a", "#ffffff", "#3fb87c"],
    elfie: ["#ffe3d0", "#0a84ff", "#241a14", "#ffffff", "#3d9bff"],
  };
  function avatar(tone) {
    var c = TONES[tone] || TONES.blue;
    var eyes = tone === "green"
      ? '<text x="38" y="72" text-anchor="middle" font-family="Onest,Inter,Arial,sans-serif" font-size="17" font-weight="800" fill="' + c[2] + '">$</text><text x="62" y="72" text-anchor="middle" font-family="Onest,Inter,Arial,sans-serif" font-size="17" font-weight="800" fill="' + c[2] + '">$</text><circle cx="31.5" cy="58.5" r="1.3" fill="#fff"/><circle cx="68.5" cy="58.5" r="1.3" fill="#fff"/>'
      : '<ellipse cx="38" cy="66" rx="4.6" ry="5.8" fill="' + c[2] + '"/><ellipse cx="62" cy="66" rx="4.6" ry="5.8" fill="' + c[2] + '"/><circle cx="39.7" cy="63.6" r="1.8" fill="' + c[3] + '"/><circle cx="63.7" cy="63.6" r="1.8" fill="' + c[3] + '"/><circle cx="36.8" cy="68.2" r=".9" fill="' + c[3] + '"/><circle cx="60.8" cy="68.2" r=".9" fill="' + c[3] + '"/>';
    return '<svg class="av" viewBox="0 0 100 100" aria-hidden="true">' +
      '<ellipse cx="15" cy="64" rx="8.5" ry="12" transform="rotate(-18 15 64)" fill="' + c[0] + '"/><ellipse cx="85" cy="64" rx="8.5" ry="12" transform="rotate(18 85 64)" fill="' + c[0] + '"/>' +
      '<ellipse cx="16" cy="64" rx="4" ry="7" transform="rotate(-18 16 64)" fill="#ff9db3" opacity=".6"/><ellipse cx="84" cy="64" rx="4" ry="7" transform="rotate(18 84 64)" fill="#ff9db3" opacity=".6"/>' +
      '<circle cx="50" cy="62" r="31" fill="' + c[0] + '"/>' +
      '<path d="M21 49 Q34 20 63 6 Q72 30 79 49 Z" fill="' + c[1] + '"/><path d="M28 45 Q40 24 58 12" stroke="#fff" stroke-opacity=".28" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<rect x="18" y="44" width="64" height="11" rx="5.5" fill="' + c[4] + '"/><circle cx="65" cy="7" r="7.5" fill="#fff"/><circle cx="62.5" cy="5" r="2.4" fill="#eef1f6"/>' +
      eyes +
      '<circle cx="29" cy="75" r="5" fill="#ff8fa8" opacity=".6"/><circle cx="71" cy="75" r="5" fill="#ff8fa8" opacity=".6"/>' +
      '<path d="M44 76 Q47 80 50 76 Q53 80 56 76" stroke="' + c[2] + '" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  /* ---------- pictures sent in the thread (drawn, like the product's own images) ---------- */
  var F = "Onest,Inter,sans-serif";
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
      '<svg viewBox="0 0 280 200" role="img" aria-label="The Ledger card"><rect width="280" height="200" fill="#EAF3FF"/>' +
      '<rect x="14" y="14" width="18" height="18" rx="5" fill="#0E0F0C"/><rect x="18" y="19" width="10" height="2" rx="1" fill="#EAF3FF" opacity=".6"/><rect x="18" y="23" width="7" height="2" rx="1" fill="#2EA8FF"/>' +
      '<text x="38" y="28" font-family="' + F + '" font-size="11" font-weight="600" fill="#0E0F0C">Elfie Ledger</text><text x="266" y="28" text-anchor="end" font-family="' + F + '" font-size="9" fill="#77786F">Live from Nessie</text>' +
      '<text x="14" y="52" font-family="' + F + '" font-size="9.5" fill="#77786F">Net cost so far</text><text x="12" y="88" font-family="' + F + '" font-size="38" font-weight="600" letter-spacing="-1.6" fill="#0E0F0C">$707</text>' +
      '<rect x="14" y="100" width="54" height="16" rx="6" fill="#2EA8FF"/><text x="22" y="111.5" font-family="' + F + '" font-size="9.5" font-weight="600" fill="#0E0F0C">Projected</text><text x="76" y="112" font-family="' + F + '" font-size="11" font-weight="600" fill="#0E0F0C">$114</text><text x="102" y="112" font-family="' + F + '" font-size="9.5" fill="#77786F">net, by Dec 1</text>' +
      '<rect x="14" y="126" width="252" height="60" rx="12" fill="#fff" stroke="#D3E4FB"/><path d="M26 140 H92 V150 H190 V172 H254" fill="none" stroke="#0E0F0C" stroke-width="1.6" stroke-linejoin="round"/><circle cx="26" cy="140" r="3" fill="#0E0F0C"/><circle cx="254" cy="172" r="3.6" fill="#2EA8FF" stroke="#0E0F0C" stroke-width="1.4"/></svg>',
    plans:
      '<svg viewBox="0 0 280 190" role="img" aria-label="Three plans with the odds of each"><rect width="280" height="190" fill="#EAF3FF"/>' +
      '<text x="14" y="26" font-family="' + F + '" font-size="9.5" fill="#77786F">Move plans under $300</text><text x="14" y="50" font-family="' + F + '" font-size="18" font-weight="600" letter-spacing="-.5" fill="#0E0F0C">Three ways to finish</text>' +
      [["A", "Best odds", 92, 74], ["B", "Runner-up", 82, 112], ["C", "Least effort", 56, 150]].map(function (p) {
        return '<rect x="14" y="' + (p[3] - 14) + '" width="252" height="34" rx="10" fill="#fff" stroke="#D3E4FB"/><rect x="22" y="' + (p[3] - 6) + '" width="18" height="18" rx="5" fill="' + (p[0] === "A" ? "#2EA8FF" : "#DCE9FB") + '"/><text x="31" y="' + (p[3] + 7) + '" text-anchor="middle" font-family="' + F + '" font-size="10" font-weight="600" fill="#0E0F0C">' + p[0] + "</text>" +
          '<text x="48" y="' + (p[3] + 2) + '" font-family="' + F + '" font-size="10.5" font-weight="500" fill="#0E0F0C">' + p[1] + '</text><rect x="48" y="' + (p[3] + 9) + '" width="150" height="3" rx="1.5" fill="#D9E6F9"/><rect x="48" y="' + (p[3] + 9) + '" width="' + (150 * p[2] / 100) + '" height="3" rx="1.5" fill="#0E0F0C"/>' +
          '<text x="256" y="' + (p[3] + 8) + '" text-anchor="end" font-family="' + F + '" font-size="14" font-weight="600" fill="#0E0F0C">' + p[2] + "%</text>";
      }).join("") + "</svg>",
  };

  /* ---------- phone ---------- */
  function Phone(root) {
    this.root = root;
    root.innerHTML =
      '<div class="ph-top"><div class="ph-av" aria-hidden="true">' + avatar("elfie") + '</div><div class="ph-name"><b>Elfie</b> · iMessage</div></div>' +
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
  Phone.prototype.play = async function (scene) {
    this.clear();
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

  /* ================= the story: chaos converges on one Crew Lead, which branches into three Elves ================= */
  var story = $("#story"), stage = $("#stage");
  var heroTitle = $("#heroTitle"), problemLine = $("#problemLine"), chipsEl = $("#chips"), treeEl = $("#tree");
  var capEl = $("#caption"), capHead = $("#capHead"), capSub = $("#capSub"), mtasks = $("#mtasks"), hint = $("#scrollHint");
  var TN_COL = ["#0A84FF", "#2FB36B", "#F0A02B", "#E5484D"];
  var NODE = { crew: $("#n-crew"), home: $("#n-home"), stuff: $("#n-stuff"), money: $("#n-money") };
  var WIRE = { home: $("#w-home"), stuff: $("#w-stuff"), money: $("#w-money") };
  var TONE = { crew: "blue", home: "red", stuff: "amber", money: "green" };
  ["crew", "home", "stuff", "money"].forEach(function (k) {
    NODE[k].innerHTML = avatar(TONE[k]) + '<div class="nm">' + esc(STORY[k].name) + "</div>" + "<ul>" + STORY[k].tasks.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>";
  });
  var STARTS = [[9, 27], [24, 11], [75, 11], [91, 31], [8, 73], [89, 70], [26, 87], [70, 88], [46, 6], [47, 93], [14, 51], [86, 52],
    [18, 39], [36, 9], [62, 6], [3, 57], [97, 45], [34, 93], [58, 95], [12, 91], [84, 91], [94, 11], [20, 21], [78, 25], [7, 12], [95, 73], [3, 83], [22, 67], [79, 38], [60, 82]];
  var MU = {
    craigslist: '<div class="cl-h">craigslist <b>boston</b> &rsaquo; apts</div><ul class="cl"><li><a>$1,150</a> Room in Allston, sunny <u>no pics</u></li><li><a>$900</a> Sublet Jun to Aug <u class="warn">wire deposit?</u></li><li><a>$1,300</a> Studio near Harvard Ave</li><li><a>$700</a> amazing deal!!! <u class="warn">abroad</u></li><li><a>$1,050</a> 3 bed, 1 room open</li></ul>',
    airbnb: '<div class="ab"><div><i style="--g:#f7cdbd"></i><b>$1,480</b><span>Allston · 4.9</span></div><div><i style="--g:#c8def7"></i><b>$1,310</b><span>Somerville · 4.7</span></div><div><i style="--g:#d7efd2"></i><b>$1,620</b><span>Cambridge · 4.8</span></div><div><i style="--g:#f5e4b8"></i><b>$990</b><span>Brighton · 4.2</span></div></div>',
    zillow: '<div class="zl"><em style="left:14%;top:26%">$2.1k</em><em style="left:52%;top:16%">$1.8k</em><em style="left:30%;top:58%">$2.4k</em><em style="left:70%;top:52%">$1.6k</em><em style="left:84%;top:20%">$2.9k</em><em style="left:44%;top:78%">$2.0k</em></div>',
    gmail: '<ul class="gm"><li class="u"><b>Landlord</b><span>Re: Re: Re: lease?</span></li><li class="u"><b>U-Haul</b><span>Your quote expires today</span></li><li><b>Priya</b><span>can I get the lamp?</span></li><li class="u"><b>Craigslist</b><span>3 new replies</span></li><li><b>Mom</b><span>did you find a place</span></li></ul>',
    sheet: '<table class="sh"><tr><th></th><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>item</td><td>cost</td><td>paid?</td></tr><tr><td>2</td><td>truck</td><td>240</td><td>??</td></tr><tr><td>3</td><td>deposit</td><td>400</td><td>yes</td></tr><tr><td>4</td><td>gas</td><td>?</td><td>no</td></tr><tr><td>5</td><td>movers</td><td>???</td><td></td></tr></table>',
    venmo: '<ul class="vm"><li><i></i><b>Priya</b><span>$33.33</span></li><li><i></i><b>Sam</b><span>pay me back!!</span></li><li><i></i><b>U-Haul</b><span>-$240.00</span></li><li><i></i><b>Landlord</b><span>-$400.00</span></li></ul>',
    uhaul: '<div class="uh"><b>15 ft truck</b><span>Saturday, Allston</span><span>$129 + mileage</span><em>Sold out</em></div>',
    chat: '<div class="ch"><p class="l">who has the car</p><p class="r">not me</p><p class="l">can\'t saturday</p><p class="r">??</p><p class="l">who is paying for the truck</p></div>',
    notes: '<ul class="nt"><li>call landlord</li><li>sell couch??</li><li>utilities!!</li><li>keys??</li><li>boxes</li></ul>',
    calendar: '<div class="cal">' + Array.apply(null, Array(28)).map(function (_, i) { return "<span" + ([3, 9, 10, 17, 22].indexOf(i) >= 0 ? ' class="e"' : "") + ">" + (i + 1) + "</span>"; }).join("") + "</div>",
    booking: '<div class="bk"><div><i style="--g:#cfe0ff"></i><div><b>Hotel near Harvard</b><span>2 nights · $238</span><em>Free cancellation</em></div></div><div><i style="--g:#ffe3cf"></i><div><b>Inn at Somerville</b><span>2 nights · $196</span><em>1 room left</em></div></div></div>',
    market: '<div class="mk"><i></i><b>Couch · $50</b><span>is this still available?</span><span>would you take $30</span><span>can you do $20 tmrw</span></div>',
  };
  var PIN = '<svg viewBox="0 0 64 56"><path d="M2 8a6 6 0 0 1 6-6h14l6 7h28a6 6 0 0 1 6 6v33a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6z" fill="#7cc4ff"/><path d="M2 18h60v29a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6z" fill="#5ab1fb"/></svg>';
  var STK = {
    folder: PIN,
    trash: '<svg viewBox="0 0 48 56"><path d="M8 14h32l-3 36a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4z" fill="#dfe3ea"/><path d="M14 20l2 28M24 20v28M34 20l-2 28" stroke="#c4cad6" stroke-width="2"/><rect x="5" y="8" width="38" height="6" rx="3" fill="#c9cfdb"/><rect x="18" y="3" width="12" height="6" rx="2" fill="#b3bac8"/></svg>',
    cursor: '<svg viewBox="0 0 28 36"><path d="M3 2l20 16-9 1.5L18 31l-4 2-4-11-7 6z" fill="#fff" stroke="#0b0c10" stroke-width="2" stroke-linejoin="round"/></svg>',
  };
  var chipNodes = CHIPS.map(function (c, i) {
    var node = el("div", "chip" + (window.innerWidth < 700 && (i === 8 || i === 9 || i === 10 || i === 11 || i > 23) ? " lesser" : ""));
    var rot = ((i * 37) % 13) - 6, dur = 4 + ((i * 7) % 9) * 0.5, inner;
    if (c.w) {
      inner = el("div", "mwrap", '<div class="mw"><div class="mbar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>' + esc(c.t) + '</span></div><div class="mbody mu-' + c.w + '">' + MU[c.w] + '</div></div><div class="mcap">' + esc(c.cap) + "</div>");
      inner.style.setProperty("--w", Math.round(c.wd * 0.86) + "px");
    } else if (c.s === "kaomoji") inner = el("div", "kao", esc(c.x));
    else if (c.s === "note") inner = el("div", "postit", esc(c.x));
    else if (c.s === "tag") inner = el("div", "nametag", "<small>HELLO</small><small>my name is</small><b>" + esc(c.x) + "</b>");
    else if (c.s === "pill") inner = el("div", "npill", '<i style="background:' + TN_COL[i % 4] + '"></i><span>' + esc(c.x) + "</span>");
    else if (c.s === "badge") inner = el("div", "nbadge", esc(c.x));
    else inner = el("div", "stk " + c.s, STK[c.s]);
    inner.style.setProperty("--rot", rot + "deg"); inner.style.setProperty("--dur", dur + "s"); inner.style.setProperty("--dl", (-(i % 9) * 0.6) + "s");
    var pop = el("div", "pop"); pop.style.setProperty("--pd", (0.25 + ((i * 11) % 30) * 0.11).toFixed(2) + "s"); pop.appendChild(inner); node.appendChild(pop); chipsEl.appendChild(node); return node;
  });
  // a browser tab strip across the top: far too many tabs
  var strip = el("div", "tabstrip");
  ["Craigslist", "Airbnb", "Zillow", "U-Haul", "Venmo", "Gmail (47)", "Sheet v3", "Booking", "Marketplace", "Zelle", "Utilities", "311", "SpareFoot", "Notes", "Reddit: sublet?", "Landlord", "Maps", "Quote #4", "Facebook", "Apartments", "more tabs"].forEach(function (t, i) {
    var tb = el("span", "tab", '<i style="background:' + TN_COL[i % 4] + '"></i>' + esc(t)); tb.style.setProperty("--i", i); strip.appendChild(tb);
  });
  chipsEl.appendChild(strip);

  var W = 0, H = 0, target = { x: 0, y: 0 };
  function measure() {
    var sr = stage.getBoundingClientRect(); W = sr.width; H = sr.height;
    var cr = NODE.crew.getBoundingClientRect();
    target.x = cr.left - sr.left + cr.width / 2; target.y = cr.top - sr.top + cr.height / 2;
    if (!cr.width) { target.x = W / 2; target.y = H * 0.3; }
  }
  var PH = [
    { k: "crew", at: 0.30 }, { k: "home", at: 0.40 }, { k: "stuff", at: 0.54 }, { k: "money", at: 0.68 }, { k: "end", at: 0.84 },
  ];
  var phaseNow = null;
  function setPhase(k) {
    if (k === phaseNow) return; phaseNow = k;
    var d = STORY[k] || STORY.end;
    capHead.textContent = k === "crew" ? STORY.crew.head : d.head; capSub.textContent = d.sub;
    capHead.style.animation = "none"; capSub.style.animation = "none"; void capHead.offsetWidth;
    capHead.style.animation = "arrive .5s var(--ease) both"; capSub.style.animation = "arrive .6s .06s var(--ease) both";
    Object.keys(NODE).forEach(function (n) { NODE[n].classList.toggle("on", n === k); });
    mtasks.innerHTML = STORY[k] && STORY[k].tasks ? STORY[k].tasks.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") : "";
  }
  function draw() {
    var r = story.getBoundingClientRect(), total = r.height - window.innerHeight;
    var p = clamp(-r.top / Math.max(1, total), 0, 1);
    // title screen: shrinks and fades as the chaos arrives
    var t = easeInOut(seg(p, 0.1, 0.28));
    heroTitle.style.opacity = String(1 - t);
    heroTitle.style.transform = "translateY(" + (-t * 7) + "vh) scale(" + (1 - t * 0.5) + ")";
    problemLine.style.opacity = String(1 - seg(p, 0.05, 0.16));
    hint.style.setProperty("--sh", String(1 - seg(p, 0.02, 0.08)));
    // chips drift, then converge
    var conv = seg(p, 0.13, 0.31);
    chipNodes.forEach(function (c, i) {
      var s = STARTS[i % STARTS.length], sx = s[0] / 100 * W, sy = s[1] / 100 * H;
      var tt = easeInOut(clamp(conv * 1.5 - (i / chipNodes.length) * 0.5, 0, 1));
      var x = lerp(sx, target.x, tt), y = lerp(sy, target.y, tt) - p * 40 * (1 - tt);
      var sc = lerp(1, 0.25, tt), o = tt > 0.8 ? 1 - (tt - 0.8) / 0.2 : 1;
      c.style.opacity = String(o);
      c.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%,-50%) scale(" + sc.toFixed(3) + ")";
    });
    strip.style.opacity = String(1 - seg(p, 0.1, 0.22)); strip.style.transform = "translateY(" + (-seg(p, 0.1, 0.22) * 30) + "px)";
    // Crew Lead pops in, then the three Elves branch out one by one
    var crew = seg(p, 0.29, 0.37);
    NODE.crew.style.setProperty("--s", String(crew ? Math.max(0, easeBack(crew)) : 0)); NODE.crew.style.setProperty("--o", String(crew > 0 ? 1 : 0));
    $$("li", NODE.crew).forEach(function (li, i) { li.style.setProperty("--lo", String(seg(p, 0.34 + i * 0.018, 0.375 + i * 0.018))); });
    var plan = { home: [0.38, 0.46], stuff: [0.52, 0.60], money: [0.66, 0.74] };
    Object.keys(plan).forEach(function (k) {
      var a = plan[k][0], b = plan[k][1];
      WIRE[k].style.setProperty("--d", String(1 - seg(p, a, b)));
      var n = seg(p, b - 0.03, b + 0.04);
      NODE[k].style.setProperty("--s", String(n ? Math.max(0, easeBack(n)) : 0)); NODE[k].style.setProperty("--o", String(n > 0 ? 1 : 0));
      $$("li", NODE[k]).forEach(function (li, i) { li.style.setProperty("--lo", String(seg(p, b + 0.03 + i * 0.016, b + 0.06 + i * 0.016))); });
    });
    // caption follows the story
    var cur = null; PH.forEach(function (ph) { if (p >= ph.at) cur = ph.k; });
    if (cur) { setPhase(cur); capEl.style.setProperty("--co", "1"); } else { capEl.style.setProperty("--co", "0"); phaseNow = null; }
  }
  function staticStory() {
    story.classList.add("static");
    heroTitle.style.opacity = "1"; problemLine.style.opacity = "1";
    Object.keys(NODE).forEach(function (k) { NODE[k].style.setProperty("--s", "1"); NODE[k].style.setProperty("--o", "1"); NODE[k].style.position = ""; $$("li", NODE[k]).forEach(function (li) { li.style.setProperty("--lo", "1"); }); });
    Object.keys(WIRE).forEach(function (k) { WIRE[k].style.setProperty("--d", "0"); });
    capEl.style.setProperty("--co", "1"); capHead.textContent = STORY.end.head; capSub.textContent = STORY.end.sub;
  }
  if (reduce) staticStory();
  else {
    var ticking = false;
    var onScroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; draw(); }); } };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", function () { measure(); draw(); });
    measure(); draw();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); draw(); });
  }

  /* ---------- why: video and numbers ---------- */
  var v = $("#video");
  if (SITE.interviewYouTubeId) v.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(SITE.interviewYouTubeId) + '?rel=0&playsinline=1" title="What people told us about moving" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>';
  else v.innerHTML = '<div class="empty"><span class="play"></span><span>Interview Short goes here</span></div>';
  $("#waitNum").textContent = SITE.waitlist; $("#interNum").textContent = String(SITE.interviews);
  function countUp(node, to, suffix) {
    if (reduce) { node.textContent = to + (suffix || ""); return; }
    var t0 = null; function step(ts) { if (!t0) t0 = ts; var k = clamp((ts - t0) / 1400, 0, 1); node.textContent = Math.round(to * easeOut(k)) + (suffix || ""); if (k < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  if ("IntersectionObserver" in window) new IntersectionObserver(function (es, o) { es.forEach(function (e) { if (e.isIntersecting) { countUp($("#interNum"), SITE.interviews); var w = parseInt(SITE.waitlist, 10); if (!isNaN(w)) countUp($("#waitNum"), w, String(SITE.waitlist).replace(/^\d+/, "")); o.disconnect(); } }); }, { threshold: 0.4 }).observe($(".bignums"));

  /* ---------- demo number ---------- */
  var dn = $("#demoNum");
  if (SITE.number) dn.textContent = SITE.number; else dn.hidden = true;

  /* ---------- photo strips ---------- */
  var GR = ["#e6eefc", "#efe8fb", "#e5f5ec", "#fdf0dc", "#e9f1f8", "#f6e8ef", "#edf5df", "#e8ecf9"], TN = ["blue", "red", "amber", "green"];
  function tiles(offset) {
    var out = [], n = SITE.nightPhotos && SITE.nightPhotos.length ? SITE.nightPhotos.length : NIGHT.length;
    for (var k = 0; k < n; k++) {
      var i = (k + offset) % n, t = el("figure", "tile"); t.style.setProperty("--r", ((i % 2 ? 1 : -1) * (0.8 + (i % 3) * 0.5)) + "deg");
      if (SITE.nightPhotos && SITE.nightPhotos.length) {
        var im = new Image(); im.src = SITE.nightPhotos[i]; im.alt = "The team building Elfie through the night"; im.loading = "lazy"; t.appendChild(im);
        var cp = (SITE.nightCaptions || [])[i]; if (cp) t.appendChild(el("figcaption", null, esc(cp)));
      } else {
        t.className = "tile ph"; t.style.setProperty("--g", GR[i % GR.length]);
        t.innerHTML = avatar(TN[i % 4]).replace('class="av"', 'class="av" style="width:46%;opacity:.55"') + '<span class="cap">' + esc(NIGHT[i % NIGHT.length]) + "</span>";
      }
      out.push(t);
    }
    return out;
  }
  function fillStrip(s, offset) {
    offset = offset || 0; var track = el("div", "strip-track");
    tiles(offset).concat(tiles(offset)).forEach(function (t, i) { track.appendChild(i >= tiles(offset).length ? t.cloneNode(true) : t); });
    s.appendChild(track);
    if (reduce) $$("figure", track).slice(Math.floor(track.children.length / 2)).forEach(function (n) { n.remove(); });
  }
  if (SITE.nightPhotos && SITE.nightPhotos.length) {
    var ps = el("div", "strip"); ps.setAttribute("aria-label", "Photos from the build"); $("#demo").after(ps); fillStrip(ps);
  }

  /* ---------- the crew emulator ---------- */
  var main = new Phone($("#phone-main"));
  var tabs = $("#agent-tabs"), funcs = $("#funcs"), blurb = $("#agent-blurb"), wont = $("#wont"), line = $("#scene-line"), jump = $("#jumpLedger");
  var currentAgent = "crew", currentScene = null, started = false;
  var panel = $("#crewPanel"), mascot = $("#mascot");
  var SAYS = { crew: "Ask me anything about the move.", home: "I'll find you a place.", stuff: "Send me a photo.", money: "Every dollar, on the ledger." };
  function paintAgent(k) { panel.dataset.tone = k; mascot.innerHTML = avatar(TONE[k]) + '<div class="say">' + esc(SAYS[k]) + "</div>"; }
  Object.keys(AGENTS).forEach(function (k) {
    var b = el("button", null, esc(AGENTS[k].name)); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.agent = k;
    b.addEventListener("click", function () { pickAgent(k, true); }); tabs.appendChild(b);
  });
  function pickAgent(k, play) {
    currentAgent = k;
    $$("button", tabs).forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.agent === k)); });
    blurb.textContent = AGENTS[k].blurb; jump.hidden = k !== "money"; paintAgent(k);
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
    var s = sceneById[id]; if (!s) return; started = true;
    if (s.agent !== currentAgent) pickAgent(s.agent, false);
    currentScene = s;
    $$("button", funcs).forEach(function (b) { b.setAttribute("aria-current", String(b.dataset.scene === id)); });
    line.textContent = s.line;
    main.play(s);
  }
  $("#replay").addEventListener("click", function () { if (currentScene) main.play(currentScene); });
  pickAgent("crew", false);
  if ("IntersectionObserver" in window) new IntersectionObserver(function (es, o) { es.forEach(function (e) { if (e.isIntersecting && !started) { started = true; pickScene("crew-intro"); o.disconnect(); } }); }, { threshold: 0.4 }).observe($("#phone-main"));
  else pickScene("crew-intro");

  /* ================= the ledger and Smart Plan simulator ================= */
  (function () {
    var root = $("#led"); if (!root) return;
    var OUT = 740, BACK = 33, NET = OUT - BACK;
    var EXPECT = [{ id: "sam", who: "Sam's share", d: "Nov 3", late: "Nov 17", a: 80 }, { id: "priya", who: "Priya's share", d: "Nov 10", late: "Nov 24", a: 113 }, { id: "dep", who: "Sublet deposit back", d: "Dec 1", late: "Dec 15", a: 400 }];
    var PLANS = {
      A: { name: "Best odds", mean: 190, sd: 80, effort: "movers do the lifting", recs: [["Nov 1", "10 ft truck (expected)", -90], ["Nov 2", "Couch sale (expected)", 120], ["Nov 5", "Desk sale (expected)", 70], ["Nov 8", "Movers (expected)", -300]] },
      B: { name: "Runner-up", mean: 235, sd: 70, effort: "some lifting", recs: [["Nov 1", "10 ft truck (expected)", -90], ["Nov 3", "Couch sale (expected)", 80], ["Nov 6", "Desk sale (expected)", 80], ["Nov 9", "Lamp sale (expected)", 25]] },
      C: { name: "Least effort", mean: 285, sd: 100, effort: "light lift", recs: [["Nov 1", "10 ft truck (expected)", -90], ["Nov 1", "Donate the couch and desk", 0], ["Nov 4", "Lamp sale (expected)", 25]] },
    };
    var st = { tab: "ov", plan: "B", budget: 300, on: { sam: true, priya: true, dep: true }, late: false, toast: "" };
    var erf = function (x) { var s = x < 0 ? -1 : 1; x = Math.abs(x); var t = 1 / (1 + 0.3275911 * x), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
    var odds = function (k) { var p = PLANS[k]; return Math.round(0.5 * (1 + erf((st.budget - p.mean) / (p.sd * Math.SQRT2))) * 100); };
    var usd = function (n) { return (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)); };
    var expectedSum = function () { return EXPECT.reduce(function (s, e) { return s + (st.on[e.id] ? e.a : 0); }, 0); };
    var projected = function () { return NET - expectedSum(); };
    var settleBy = function () { var last = null; EXPECT.forEach(function (e) { if (st.on[e.id]) last = st.late ? e.late : e.d; }); return last || "now"; };
    var ease = function (t) { return 1 - Math.pow(1 - t, 2); };
    function stepChart() {
      var x = { sam: 100, priya: 170, dep: 290 }, y = function (v) { return 14 + (1 - clamp(v / NET, 0, 1)) * 62; };
      var cur = NET, d = "M8 " + y(cur), pts = '<circle cx="8" cy="' + y(cur) + '" r="4" fill="#0E0F0C"/>';
      EXPECT.forEach(function (e) { if (!st.on[e.id]) return; d += " H" + x[e.id] + " V" + y(cur - e.a); cur -= e.a; pts += '<circle cx="' + x[e.id] + '" cy="' + y(cur + e.a) + '" r="3.8" fill="#fff" stroke="#0E0F0C" stroke-width="1.6"/>'; });
      d += " H312"; pts += '<circle cx="312" cy="' + y(cur) + '" r="5" fill="#2EA8FF" stroke="#0E0F0C" stroke-width="1.8"/>';
      return '<svg class="lchart" viewBox="0 0 320 92" role="img" aria-label="Net cost stepping down as expected payments arrive"><line x1="8" y1="78" x2="312" y2="78" stroke="#9A9B93" stroke-dasharray="3 4"/><text x="10" y="90" font-size="8.5" fill="#77786F" font-family="' + F + '">break even</text><path d="' + d + '" fill="none" stroke="#0E0F0C" stroke-width="2" stroke-linejoin="round"/>' + pts + "</svg>";
    }
    function bandChart() {
      var p = PLANS[st.plan], X = function (t) { return 22 + t * 296; }, Y = function (v) { return 126 - clamp(v / 760, 0, 1) * 112; }, N = 12, up = "", lo = "", mid = "";
      for (var i = 0; i <= N; i++) {
        var t = i / N, e = ease(t), m = NET - (NET - p.mean) * e, w = 1.28 * p.sd * Math.pow(e, 0.9);
        up += (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(m + w).toFixed(1); mid += (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(m).toFixed(1);
      }
      for (i = N; i >= 0; i--) { t = i / N; e = ease(t); m = NET - (NET - p.mean) * e; w = 1.28 * p.sd * Math.pow(e, 0.9); lo += "L" + X(t).toFixed(1) + " " + Y(m - w).toFixed(1); }
      var by = Y(st.budget), real = [0, 0.05, 0.1].map(function (t) { return '<circle cx="' + X(t) + '" cy="' + Y(NET) + '" r="3.4" fill="#0E0F0C"/>'; }).join("");
      return '<svg class="lchart" viewBox="0 0 340 150" role="img" aria-label="Plan ' + st.plan + ' likely cost with a 10 to 90 percent band"><path d="' + up + lo + 'Z" fill="#0E0F0C" opacity=".08"/><path d="' + mid + '" fill="none" stroke="#0E0F0C" stroke-width="2"/><line x1="22" x2="318" y1="' + by + '" y2="' + by + '" stroke="#137A47" stroke-dasharray="4 4"/><text x="318" y="' + (by - 4) + '" text-anchor="end" font-size="9" fill="#137A47" font-weight="600" font-family="' + F + '">Budget ' + usd(st.budget) + "</text>" + real + '<circle cx="318" cy="' + Y(p.mean) + '" r="5" fill="#2EA8FF" stroke="#0E0F0C" stroke-width="1.8"/><text x="22" y="146" font-size="8.5" fill="#77786F" font-family="' + F + '">Today</text><text x="318" y="146" text-anchor="end" font-size="8.5" fill="#77786F" font-family="' + F + '">Move-out</text></svg>';
    }
    function planRows(buttons) {
      return Object.keys(PLANS).map(function (k) {
        return '<button type="button" class="ds-row" data-plan="' + k + '" aria-pressed="' + (st.plan === k) + '"><i>' + k + "</i><span>" + PLANS[k].name + "</span><b>" + odds(k) + '%</b><u style="--k:' + (odds(k) / 100) + '"></u></button>';
      }).join("");
    }
    function render() {
      var p = PLANS[st.plan], tabs = [["ov", "Overview"], ["sp", "Smart Plan"], ["cb", "Coming back"], ["ac", "Activity"]];
      var html = '<div class="led-top"><span class="mini-mark" aria-hidden="true"></span>Elfie Ledger<span class="live"><i></i>Live from Nessie</span></div>' +
        '<div class="lseg" role="tablist">' + tabs.map(function (t) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (st.tab === t[0]) + '">' + t[1] + "</button>"; }).join("") + "</div>";
      html += '<div class="lpanel' + (st.tab === "ov" ? " on" : "") + '"><div><div class="l-num">' + usd(NET) + '</div><div class="l-sub">Net cost so far · ' + usd(OUT) + " out · " + usd(BACK) + ' back</div></div>' +
        '<div class="l-land"><span class="tag">Projected</span><b>' + usd(projected()) + "</b><span>net, by " + settleBy() + '</span></div><div class="lbox">' + stepChart() + "</div>" +
        '<div class="l-smart"><div class="ds-top"><span>Beyond the ledger</span><em>Smart Plan</em></div><div class="ds-big"><b>' + odds(st.plan) + "%</b><span>chance of finishing under " + usd(st.budget) + "</span></div>" + planRows() + "</div>" +
        '<div class="lbox lgrid"><div><span>Moving Fund</span><b>$33</b></div><div><span>Owed to you</span><b>' + usd((st.on.sam ? 80 : 0) + (st.on.priya ? 113 : 0)) + "</b></div><div><span>In escrow</span><b>$60</b></div><div><span>Deposits out</span><b>$400</b></div></div></div>";
      html += '<div class="lpanel' + (st.tab === "sp" ? " on" : "") + '"><div class="lhero"><div class="eyebrow-less">Plan ' + st.plan + " · " + p.name + '</div><b class="fig">' + usd(p.mean) + '</b><div class="l-sub">likely final cost · ' + usd(p.mean - 1.28 * p.sd) + " to " + usd(p.mean + 1.28 * p.sd) + " in 9 of 10 moves</div></div>" +
        '<div class="l-land"><span class="tag">' + odds(st.plan) + "%</span><span>chance under " + usd(st.budget) + " · " + p.effort + '</span></div><div class="lbox">' + bandChart() + "</div>" +
        '<div class="lcards">' + Object.keys(PLANS).map(function (k) { var on = st.plan === k; return '<button type="button" class="lcard" data-plan="' + k + '" aria-pressed="' + on + '"><i>' + k + "</i><b>" + PLANS[k].name + "</b><span>" + usd(PLANS[k].mean) + " likely · " + odds(k) + "% under budget</span><em>" + (on ? "Your plan" : "Switch") + "</em></button>"; }).join("") + "</div>" +
        '<div class="lbox"><div class="lchips" role="group" aria-label="Budget">' + [200, 300, 400, 500].map(function (b) { return '<button type="button" class="lchip" data-budget="' + b + '" aria-pressed="' + (st.budget === b) + '">' + usd(b) + "</button>"; }).join("") + "</div></div>" +
        '<div class="lbox"><ul class="lrec">' + p.recs.map(function (r) { return '<li><span class="d">' + r[0] + '</span><span class="g">' + r[1] + '<small>Written to Nessie as a future-dated record</small></span><span class="pend">pending</span><span class="a ' + (r[2] > 0 ? "in" : "") + '">' + (r[2] === 0 ? "" : (r[2] > 0 ? "+" : "-") + usd(Math.abs(r[2]))) + "</span></li>"; }).join("") + "</ul></div>" +
        '<div class="toastl" aria-live="polite">' + esc(st.toast) + "</div></div>";
      html += '<div class="lpanel' + (st.tab === "cb" ? " on" : "") + '"><div class="lhero"><div class="eyebrow-less">Projected net cost</div><b class="fig">' + usd(projected()) + '</b><div class="l-sub">settles by ' + settleBy() + (st.late ? " (everyone two weeks late)" : "") + '</div></div><div class="lbox">' +
        EXPECT.map(function (e) { return '<button type="button" class="sw" data-sw="' + e.id + '" aria-pressed="' + st.on[e.id] + '"><span class="t">' + e.who + "<small>expected " + (st.late ? e.late : e.d) + '</small></span><span class="a">' + usd(e.a) + '</span><span class="knob"></span></button>'; }).join("") +
        '<button type="button" class="sw" data-sw="late" aria-pressed="' + st.late + '"><span class="t">Everyone pays two weeks late<small>a stress test</small></span><span class="knob"></span></button></div><p class="lnote">Switch off anything you are not counting on. The projection updates.</p></div>';
      html += '<div class="lpanel' + (st.tab === "ac" ? " on" : "") + '"><div class="lbox"><ul class="lrec">' + [["Oct 16", "Deposit: sublet", -400, "wd_3"], ["Oct 16", "Cleaning split", -100, "pu_7"], ["Oct 17", "Truck split", -240, "pu_8"], ["Oct 17", "Sam paid for the cleaning", 33, "dp_4"], ["Oct 18", "Couch in escrow", 60, "es_2"]].map(function (r) { return '<li><span class="d">' + r[0] + '</span><span class="g">' + r[1] + "<small>Nessie record " + r[3] + '</small></span><span class="a ' + (r[2] > 0 ? "in" : "") + '">' + (r[2] > 0 ? "+" : "-") + usd(Math.abs(r[2])) + "</span></li>"; }).join("") + '</ul></div><p class="lnote">Every movement is a Nessie record. Tap any one in the real app to see its id.</p></div>';
      root.innerHTML = html;
    }
    root.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.dataset.tab) st.tab = b.dataset.tab;
      else if (b.dataset.plan) { var was = st.plan; st.plan = b.dataset.plan; if (b.classList.contains("lcard") && was !== st.plan) st.toast = "From your dashboard: switched to Plan " + st.plan + ". Your chat gets a note."; }
      else if (b.dataset.budget) { st.budget = Number(b.dataset.budget); st.toast = "Odds redone for a " + usd(st.budget) + " budget."; }
      else if (b.dataset.sw) { if (b.dataset.sw === "late") st.late = !st.late; else st.on[b.dataset.sw] = !st.on[b.dataset.sw]; }
      render();
    });
    render();
  })();

  /* ---------- quick words: the texts that open everything ---------- */
  var KEYS = [["HELP", "See all your options", "crew-intro"], ["STATUS", "Move-day checklist and where everything stands", "crew-status"], ["DASHBOARD", "Live ledger, picture and link", "money-ledger"], ["SMART PLAN", "Three plans with your odds", "money-plan"]];
  $$("[data-keys]").forEach(function (box) {
    KEYS.forEach(function (k) {
      var b = el("button", "key", "<b>" + esc(k[0]) + "</b><span>" + esc(k[1]) + "</span>"); b.type = "button";
      b.title = 'Text "' + k[0] + '" to Elfie';
      b.addEventListener("click", function () { started = true; $("#crew").scrollIntoView({ behavior: reduce ? "auto" : "smooth" }); setTimeout(function () { pickScene(k[2]); }, reduce ? 0 : 450); });
      box.appendChild(b);
    });
  });

  /* ---------- tracks: one at a time ---------- */
  var sel = $("#trackSelect"), trEl = $("#track");
  TRACKS.forEach(function (t) { sel.appendChild(new Option(t.name, t.id)); });
  var ACC = { photon: ["#0a84ff", "#e7f1ff", "Photon"], nessie: ["#0e0f0c", "#eef7c4", "Nessie"], sustain: ["#2fb36b", "#dcf2e5", "Green"], cyber: ["#e08a00", "#fdeccd", "Safe"] };
  function showTrack(id) {
    var t = TRACKS.filter(function (x) { return x.id === id; })[0];
    var ac = ACC[id], tp = $("#trackPanel"); tp.style.setProperty("--tk", ac[0]); tp.style.setProperty("--tk-soft", ac[1]); $("#trackGhost").textContent = ac[2];
    trEl.innerHTML =
      '<p class="why-track"><small>Why ' + esc(t.name) + "</small>" + esc(t.why) + "</p>" +
      '<div class="track-actions"><button class="btn small primary" type="button" id="see">See it in the thread</button><ul class="apis" aria-label="What we used">' + t.apis.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul></div>" +
      '<div class="tiles">' + t.tiles.map(function (x) { return '<details class="tilex' + (x.own ? " ours" : "") + '"><summary><span class="k' + (x.own ? " own" : "") + '">' + esc(x.own ? "Built by us" : x.k) + '</span><span class="tt">' + esc(x.t) + '</span><span class="ss">' + esc(x.s) + '</span><span class="plus" aria-hidden="true"></span></summary><p class="more">' + esc(x.more) + "</p></details>"; }).join("") + "</div>";
    $("#see").addEventListener("click", function () {
      started = true; $("#crew").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
      setTimeout(function () { pickScene(t.scene); }, reduce ? 0 : 500);
    });
  }
  sel.addEventListener("change", function () { showTrack(sel.value); });
  showTrack(TRACKS[0].id);

  /* ---------- unique, future ---------- */
  $("#uFeature").innerHTML = '<div class="uf-badge">Our unique discovery</div><div class="uf-t">The Deal Engine</div><p>One state machine for every stranger you never met: it holds your floor, counters buyers, books slots, runs Last Call and feeds the ledger. Built by Yashashri.</p>';
  $("#uniq").innerHTML = UNIQUE.map(function (u) { return "<li><b>" + esc(u[0]) + "</b><span>" + esc(u[1]) + "</span></li>"; }).join("");
  $("#next").innerHTML = FUTURE.map(function (u) { return "<li><b>" + esc(u[0]) + "</b><span>" + esc(u[1]) + "</span></li>"; }).join("");

  /* ---------- stack search ---------- */
  var cats = ["All"]; STACK.forEach(function (s) { if (cats.indexOf(s.c) < 0) cats.push(s.c); });
  var q = $("#stackQ"), catBox = $("#stackCats"), list = $("#stackList"), count = $("#stackCount"), cat = "All";
  cats.forEach(function (c) { var b = el("button", null, esc(c)); b.type = "button"; b.setAttribute("aria-pressed", String(c === "All")); b.addEventListener("click", function () { cat = c; $$("button", catBox).forEach(function (x) { x.setAttribute("aria-pressed", String(x.textContent === c)); }); renderStack(); }); catBox.appendChild(b); });
  function hl(s, terms) { var out = esc(s); terms.forEach(function (t) { if (t) out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>"); }); return out; }
  function renderStack() {
    var terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var rows = STACK.filter(function (s) { if (cat !== "All" && s.c !== cat) return false; var hay = (s.n + " " + s.c + " " + s.w + " " + s.p).toLowerCase(); return terms.every(function (t) { return hay.indexOf(t) >= 0; }); });
    list.innerHTML = rows.length ? rows.map(function (s) { return '<li>' + icon(s.n) + '<span class="cat">' + esc(s.c) + "</span><b>" + hl(s.n, terms) + "</b><span>" + hl(s.w, terms) + "</span><small>" + hl(s.p, terms) + "</small></li>"; }).join("") : '<li class="empty-find">Nothing matches that. Try "Nessie", "voice" or "Postgres".</li>';
    count.textContent = rows.length + " of " + STACK.length;
  }
  q.addEventListener("input", renderStack); renderStack();

  /* ---------- number, repo ---------- */
  var num = $("#number");
  if (SITE.number) num.textContent = SITE.number; else num.hidden = true;
  $("#repo").href = SITE.repoUrl;


  /* ---------- icons: brand marks from assets/icons, drawn monograms, or an elf face ---------- */
  function icon(name) {
    var d = ICONS[name] || ["mono:" + name.charAt(0), "#14151a"], k = d[0];
    if (k.indexOf("mono:") === 0) return '<i class="ico mono" style="--c:' + d[1] + '" aria-hidden="true">' + esc(k.slice(5)) + "</i>";
    if (k.indexOf("elf:") === 0) return '<i class="ico elfi" aria-hidden="true">' + avatar(k.slice(4)) + "</i>";
    return '<i class="ico" style="--c:' + d[1] + ";--u:url(assets/icons/" + k + '.svg)" aria-hidden="true"></i>';
  }
  var rail = $("#rail"), seen = {}, rtrack = el("div", "rail-track");
  STACK.forEach(function (s) {
    var d = ICONS[s.n]; if (!d) return; var key = d[0] + d[1]; if (seen[key]) return; seen[key] = 1;
    rtrack.appendChild(el("div", "rtile", icon(s.n) + "<span>" + esc(s.n.replace(/ \(.*/, "").replace(" API", "")) + "</span>"));
  });
  Array.prototype.slice.call(rtrack.children).forEach(function (n) { rtrack.appendChild(n.cloneNode(true)); });
  rail.appendChild(rtrack);

  /* ---------- the Deal Engine, step by step ---------- */
  (function () {
    var modes = $("#engModes"), line = $("#engLine"), card = $("#engCard"), mode = 0, step = 1;
    var note = el("p", "modes-note"); modes.after(note);
    DEAL.modes.forEach(function (m, i) { var b = el("button", null, esc(m[1])); b.type = "button"; b.setAttribute("aria-pressed", String(i === 0)); b.addEventListener("click", function () { mode = i; $$("button", modes).forEach(function (x, k) { x.setAttribute("aria-pressed", String(k === i)); }); note.textContent = "Mode " + m[0] + ": " + m[2]; }); modes.appendChild(b); });
    note.textContent = "Mode " + DEAL.modes[0][0] + ": " + DEAL.modes[0][2];
    DEAL.steps.forEach(function (s, i) { var li = el("li"), b = el("button", null, "<div><b>" + esc(s.k) + "</b><span>" + esc(s.t) + "</span></div>"); b.type = "button"; b.addEventListener("click", function () { show(i); }); li.appendChild(b); line.appendChild(li); });
    function show(i) {
      step = i; var s = DEAL.steps[i];
      $$("button", line).forEach(function (b, k) { b.setAttribute("aria-current", String(k === i)); b.classList.toggle("past", k < i); });
      card.innerHTML = '<span class="ev">' + esc(s.ev) + "</span><h3>" + esc(s.t) + "</h3><ul>" + s.p.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
    }
    show(0);
    if ("IntersectionObserver" in window && !reduce) new IntersectionObserver(function (es, o) { es.forEach(function (e) { if (e.isIntersecting) { o.disconnect(); var i = 0; (function adv() { show(i); if (++i < DEAL.steps.length) setTimeout(adv, 1100); else setTimeout(function () { show(0); }, 1400); })(); } }); }, { threshold: 0.5 }).observe(line);
  })();

  /* ---------- demo time: a call you can place ---------- */
  (function () {
    var call = $("#call"), go = $("#callGo"), end = $("#callEnd"), caps = $("#caps"), stat = $("#callStatus"), tm = $("#callTime"), steps = $$("#demoSteps li"), wave = $("#wave");
    var phoneD = new Phone($("#phone-demo")), stageD = $(".demo-stage");
    $$("i", wave).forEach(function (b, i) { b.style.setProperty("--n", i); b.style.setProperty("--h", 14 + ((i * 29) % 38)); });
    $(".call-av").innerHTML = avatar("blue");
    var SCRIPT = [
      ["elf", "Hey, this is the Crew Lead at Elfie, your moving crew. So, walk me through the move: when you're out, where you're going, and what's coming with you."],
      ["you", "Out of my Allston place November first. Into Somerville, nothing found yet. Selling the couch and desk, keeping the bed."],
      ["elf", "Out of Allston November first, hard date? Into Somerville, nothing found yet. Couch and desk go, bed stays. Is it a truck or Sam's car, and what's happening with the lease?"],
      ["you", "Hard date. Sam's car. Lease ends the same day."],
      ["elf", "Here's what I've got: out of Allston November first, hard date, into Somerville. Couch and desk sell, bed stays, Sam drives, lease ends that day. Still open: your budget. Does that all sound right, or is there anything to change?"],
      ["you", "Yes."],
      ["elf", "Locked in. The crew gets started now, and you'll get a text with the plan and your crew board link."],
    ];
    var token = 0, secs = 0, timer = null;
    var fmt = function (n) { return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); };
    function mark(n) { steps.forEach(function (li, i) { li.classList.toggle("on", i === n); li.classList.toggle("done", i < n); }); }
    function reset() { token++; clearInterval(timer); call.dataset.state = "idle"; call.classList.remove("you"); caps.innerHTML = ""; stat.textContent = "Elfie · tap to call"; tm.textContent = "0:00"; go.hidden = false; end.hidden = true; stageD.classList.remove("recap"); mark(-1); phoneD.clear(); }
    async function run() {
      reset(); var t = token; go.hidden = true; end.hidden = false; call.dataset.state = "ringing"; stat.textContent = "Ringing…"; mark(0);
      await sleep(reduce ? 0 : 1600); if (t !== token) return;
      call.dataset.state = "live"; secs = 0; tm.textContent = "0:00"; timer = setInterval(function () { secs++; tm.textContent = fmt(secs); }, 1000);
      for (var i = 0; i < SCRIPT.length; i++) {
        var line = SCRIPT[i]; call.classList.toggle("you", line[0] === "you"); stat.textContent = line[0] === "elf" ? "Crew Lead is talking" : "You are talking";
        if (i === 4) mark(1);
        var c = el("div", "cap " + line[0], esc(line[1])); caps.appendChild(c); while (caps.children.length > 4) caps.firstChild.remove();
        await sleep(reduce ? 0 : Math.min(5200, 1100 + line[1].length * 38)); if (t !== token) return;
      }
      clearInterval(timer); call.dataset.state = "idle"; call.classList.remove("you"); stat.textContent = "Call ended · " + fmt(secs); end.hidden = true; go.hidden = false; go.firstChild.textContent = "Call again";
      mark(2); stageD.classList.add("recap");
      await phoneD.play({ msgs: [
        { from: "elf", agent: "crew", text: "✅ Locked in. Here's who's on what:\n\n🏠 Home: find you a place in Somerville\n📦 Stuff: price the couch and desk\n💸 Money: keep the ledger" },
        { from: "elf", agent: "money", text: "I've set up your Moving Ledger in Nessie. Every dollar of the move goes on it, and nothing moves without your yes.\n\nWhat's your budget for the rest of the move?" },
      ] });
      if (t === token) mark(3);
    }
    go.addEventListener("click", run); end.addEventListener("click", reset);
    phoneD.clear();
  })();

  /* ---------- future: a road that fills as you walk down it ---------- */
  var road = $("#next");
  if ("IntersectionObserver" in window && !reduce) {
    var ro = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); ro.unobserve(e.target); } }); }, { rootMargin: "0px 0px -15% 0px" });
    $$("li", road).forEach(function (n) { ro.observe(n); });
    var rp = function () { var r = road.getBoundingClientRect(); road.style.setProperty("--p", String(clamp((innerHeight * 0.6 - r.top) / r.height, 0, 1))); };
    window.addEventListener("scroll", rp, { passive: true }); rp();
  } else { $$("li", road).forEach(function (n) { n.classList.add("in"); }); road.style.setProperty("--p", "1"); }

  /* ---------- team polaroids ---------- */
  var teamEl = $("#team"), TG = ["#e6eefc", "#efe8fb", "#e5f5ec", "#fdf0dc"];
  (SITE.team || []).forEach(function (m, i) {
    var li = el("li"); li.style.setProperty("--r", ((i % 2 ? 1 : -1) * (1.2 + i * 0.5)) + "deg");
    var pic = el("div", "pic"); pic.style.setProperty("--g", TG[i % 4]);
    if (m.photo) { var im = new Image(); im.src = m.photo; im.alt = m.name; im.loading = "lazy"; pic.appendChild(im); } else pic.innerHTML = avatar(["blue", "red", "amber", "green"][i % 4]);
    li.appendChild(pic); li.appendChild(el("div", null, esc(m.name) + (m.role ? "<small>" + esc(m.role) + "</small>" : ""))); teamEl.appendChild(li);
  });

  /* ---------- reveal ---------- */
  var rev = $$(".reveal");
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    rev.forEach(function (n) { io.observe(n); });
  } else rev.forEach(function (n) { n.classList.add("in"); });
})();
