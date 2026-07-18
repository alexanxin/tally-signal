/* Tally report widget — persistent bug/feedback button on the static site.
   Injects a floating button + panel; posts to /api/report (same-origin).
   Styling references the site's own :root tokens (with fallbacks). */
(function () {
  if (window.__tallyReport) return;
  window.__tallyReport = true;

  var G = "var(--green,#4ade80)";
  var GDIM = "var(--green-dim,rgba(74,222,128,0.09))";
  var CARD = "var(--bg-card,#111820)";
  var INSET = "var(--bg-inset,#0d1520)";
  var BG = "var(--bg,#0b0f14)";
  var BORD = "var(--border,rgba(74,222,128,0.18))";
  var TEXT = "var(--text,#f0f4f8)";
  var META = "var(--text-meta,#78909c)";
  var RED = "var(--red,#f87171)";
  var RAD = "var(--radius,2px)";
  var MONO = "var(--mono,'JetBrains Mono','Fira Code',monospace)";
  var SANS = "var(--sans,'Inter',system-ui,sans-serif)";
  var Z = 2147483000;

  var fld = "background:" + INSET + ";border:1px solid " + BORD + ";border-radius:" + RAD + ";color:" + TEXT + ";padding:9px 10px;font:13px " + SANS + ";";
  var catStyle = "flex:1;padding:7px 0;font:11px " + MONO + ";letter-spacing:1px;text-transform:uppercase;border-radius:" + RAD + ";cursor:pointer;border:1px solid " + BORD + ";background:transparent;color:" + META + ";";

  var wrap = document.createElement("div");
  wrap.innerHTML =
    '<div id="tr-panel" style="display:none;position:fixed;bottom:calc(84px + env(safe-area-inset-bottom));right:20px;z-index:' + Z + ';width:300px;max-width:calc(100vw - 40px);background:' + CARD + ';border:1px solid ' + BORD + ';border-radius:' + RAD + ';padding:16px;box-shadow:0 14px 44px rgba(0,0,0,.6);color:' + TEXT + ';display:flex;flex-direction:column;gap:11px;">' +
      '<div style="font:11px ' + MONO + ';letter-spacing:1.5px;text-transform:uppercase;color:' + META + ';">Report a bug or feedback</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button type="button" data-cat="bug" class="tr-cat" style="' + catStyle + '">Bug</button>' +
        '<button type="button" data-cat="feedback" class="tr-cat" style="' + catStyle + '">Feedback</button>' +
      '</div>' +
      '<textarea id="tr-desc" rows="4" maxlength="4000" placeholder="What happened? Steps, what you expected…" style="' + fld + 'resize:vertical;min-height:84px;"></textarea>' +
      '<input id="tr-contact" maxlength="200" placeholder="Email (optional, to follow up)" style="' + fld + '" />' +
      '<div style="font:11px ' + SANS + ';color:' + META + ';line-height:1.4;">Don\'t include secrets — never share your seed, keys, or passwords.</div>' +
      '<button id="tr-send" type="button" style="background:' + G + ';color:' + BG + ';border:none;border-radius:' + RAD + ';padding:10px 0;font:600 11px ' + MONO + ';letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;">Send report</button>' +
      '<div id="tr-status" style="font:12px ' + SANS + ';"></div>' +
    '</div>' +
    '<button id="tr-fab" type="button" title="Report a bug or send feedback" aria-label="Report a bug or send feedback" style="position:fixed;bottom:calc(20px + env(safe-area-inset-bottom));right:20px;z-index:' + Z + ';width:50px;height:50px;border-radius:' + RAD + ';background:' + CARD + ';border:1px solid ' + BORD + ';color:' + G + ';display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.5);">' +
      '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '</button>';
  document.body.appendChild(wrap);

  var panel = wrap.querySelector("#tr-panel");
  var fab = wrap.querySelector("#tr-fab");
  var desc = wrap.querySelector("#tr-desc");
  var contact = wrap.querySelector("#tr-contact");
  var sendBtn = wrap.querySelector("#tr-send");
  var statusEl = wrap.querySelector("#tr-status");
  var cats = wrap.querySelectorAll(".tr-cat");
  var category = "bug";

  var isOpen = false;
  function setOpen(o) { isOpen = o; panel.style.display = o ? "flex" : "none"; }
  fab.onclick = function () { setOpen(!isOpen); };
  setOpen(false);

  Array.prototype.forEach.call(cats, function (b) {
    b.onclick = function () {
      category = b.getAttribute("data-cat");
      Array.prototype.forEach.call(cats, function (x) {
        var on = x === b;
        x.style.background = on ? GDIM : "transparent";
        x.style.color = on ? G : META;
        x.style.borderColor = on ? G : BORD;
      });
    };
  });
  cats[0].click();

  sendBtn.onclick = function () {
    var text = (desc.value || "").trim();
    if (!text || sendBtn.disabled) return;
    sendBtn.disabled = true; sendBtn.textContent = "Sending…"; statusEl.textContent = "";
    fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: category,
        description: text,
        contact: (contact.value || "").trim() || undefined,
        diagnostics: {
          appVersion: "site", platform: "web", network: "-",
          route: location.pathname, ts: Date.now(), userAgent: navigator.userAgent,
        },
      }),
    }).then(function (r) {
      if (r.ok) {
        statusEl.style.color = G; statusEl.textContent = "Thanks — report sent ✓";
        desc.value = ""; contact.value = "";
        setTimeout(function () { setOpen(false); statusEl.textContent = ""; }, 1600);
      } else {
        statusEl.style.color = RED; statusEl.textContent = "Couldn't send. Please try again.";
      }
    }).catch(function () {
      statusEl.style.color = RED; statusEl.textContent = "Couldn't send. Please try again.";
    }).finally(function () {
      sendBtn.disabled = false; sendBtn.textContent = "Send report";
    });
  };
})();
