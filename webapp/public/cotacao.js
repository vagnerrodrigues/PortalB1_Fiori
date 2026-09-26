/* Página pública do fornecedor: resposta da cotação online (sem login, link com token). */
(function () {
  "use strict";
  var token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  var api = "/api/public/compras/cotacao/" + encodeURIComponent(token);
  var state = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var brl = function (n) { return Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); };
  var br = function (s) { return s ? String(s).slice(0, 10).split("-").reverse().join("/") : ""; };
  var today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  function parseNum(s) {
    s = String(s || "").trim().replace(/\s|R\$/g, "");
    if (!s) { return null; }
    if (s.indexOf(",") >= 0) { s = s.replace(/\./g, "").replace(",", "."); }
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  var fmtNum = function (n) { return n == null ? "" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }); };

  function request(method, body) {
    return fetch(api, {
      method: method, credentials: "omit",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ("Erro " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  /** Mesmo item vindo de várias solicitações: o fornecedor cota uma vez (quantidade somada). */
  function groupLines(lines) {
    var groups = [], byItem = {};
    lines.forEach(function (l) {
      var id = l.itemCode ? l.itemCode + "|" + (l.uom || "") : "k" + l.key;
      var g = byItem[id];
      if (!g) {
        g = byItem[id] = { gid: groups.length, keys: [], itemCode: l.itemCode, itemName: l.itemName, uom: l.uom, quantity: 0, requiredDate: l.requiredDate, notes: [] };
        groups.push(g);
      }
      g.keys.push(l.key);
      g.quantity = Math.round((g.quantity + Number(l.quantity)) * 1000) / 1000;
      if (l.requiredDate && (!g.requiredDate || l.requiredDate < g.requiredDate)) { g.requiredDate = l.requiredDate; }
      if (l.freeText && g.notes.indexOf(l.freeText) < 0) { g.notes.push(l.freeText); }
    });
    return groups;
  }

  function applyBrand(b) {
    if (!b) { return; }
    var c = b.colors || {}, root = document.documentElement.style;
    ["header", "headerText", "accent", "primary"].forEach(function (k) { if (c[k]) { root.setProperty("--" + k, c[k]); } });
    var logo = b.logoOnDark || b.logo;
    if (logo) { $("logo").src = "/" + String(logo).replace(/^\/+/, ""); $("logo").hidden = false; }
  }

  function render(editing) {
    var d = state;
    document.title = "Cotação nº " + d.number + " — " + d.company;
    $("company").textContent = d.company;
    var a = d.answer || { lines: [] };
    var byKey = {};
    (a.lines || []).forEach(function (l) { byKey[l.key] = l; });
    var answered = d.answeredAt && !d.declined;
    var readOnly = !d.open || (!editing && (answered || d.declined));

    var head = '<h1>Cotação nº ' + esc(d.number) + (d.title ? " — " + esc(d.title) : "") + '</h1>' +
      '<p class="sub">Para <b>' + esc(d.supplier.cardName) + '</b> · solicitada por ' + esc(d.buyer.name) +
      (d.buyer.email ? ' (<a href="mailto:' + esc(d.buyer.email) + '">' + esc(d.buyer.email) + '</a>)' : "") + '</p>' +
      '<div class="chips">' +
        '<span class="chip ' + (d.open ? "warn" : "err") + '">' + (d.open ? "Responder até " + br(d.deadline) : "Prazo encerrado") + '</span>' +
        '<span class="chip">' + groupLines(d.lines).length + (groupLines(d.lines).length === 1 ? " item" : " itens") + '</span>' +
        (answered ? '<span class="chip ok">Resposta enviada em ' + br(d.answeredAt) + '</span>' : "") +
        (d.declined ? '<span class="chip err">Você informou que não vai cotar</span>' : "") +
      '</div>';

    var notice = "";
    if (!d.open) { notice = '<div class="alert info">Esta cotação não recebe mais respostas. Em caso de dúvida, fale com o comprador.</div>'; }
    else if (readOnly && answered) { notice = '<div class="alert ok">Recebemos sua proposta. Você pode alterá-la até ' + br(d.deadline) + '. <button class="ghost" id="btnEdit" type="button" style="margin-left:8px;padding:6px 12px">Alterar resposta</button></div>'; }
    else if (readOnly && d.declined) { notice = '<div class="alert info">Obrigado pelo retorno. Mudou de ideia? <button class="ghost" id="btnEdit" type="button" style="margin-left:8px;padding:6px 12px">Enviar preços</button></div>'; }

    state.groups = groupLines(d.lines);
    var rows = state.groups.map(function (l) {
      var x = byKey[l.keys[0]] || {};
      l.freeText = l.notes.join(" · ");
      var skipped = x.key !== undefined && !x.quoted;
      var dis = readOnly ? " disabled" : "";
      return '<tr data-gid="' + l.gid + '"' + (skipped ? ' class="skipped"' : "") + '>' +
        '<td class="item"><b>' + esc(l.itemName || l.itemCode) + '</b><small>' + esc(l.itemCode || "") + (l.freeText ? " · " + esc(l.freeText) : "") + '</small>' +
          (readOnly ? "" : '<label class="skip"><input type="checkbox" class="skipChk"' + (skipped ? " checked" : "") + '> Não tenho este item</label>') + '</td>' +
        '<td class="num" data-l="Quantidade">' + fmtNum(l.quantity).replace(/,00$/, "") + " " + esc(l.uom || "") +
          (l.requiredDate ? '<br><small style="color:var(--muted)">precisa até ' + br(l.requiredDate) + '</small>' : "") + '</td>' +
        '<td class="num" data-l="Preço unitário (R$)"><input type="text" inputmode="decimal" class="price" placeholder="0,00" value="' + (x.quoted ? fmtNum(x.unitPrice) : "") + '"' + (skipped ? " disabled" : dis) + ' aria-label="Preço unitário"></td>' +
        '<td data-l="Entrega prevista"><input type="date" class="dd" min="' + today + '" value="' + (x.deliveryDate || "") + '"' + (skipped ? " disabled" : dis) + ' aria-label="Entrega prevista"></td>' +
        '<td data-l="Observação"><input type="text" class="nt" maxlength="90" value="' + esc(x.notes || "") + '"' + dis + ' aria-label="Observação" placeholder="marca, modelo…"></td>' +
        '<td class="num lt" data-l="Total">' + (x.quoted ? brl(x.unitPrice * l.quantity) : "—") + '</td>' +
      '</tr>';
    }).join("");

    var dis = readOnly ? " disabled" : "";
    var html = head + notice + '<div id="err"></div>' +
      (d.message ? '<div class="card"><h2>Mensagem do comprador</h2><div class="msg">' + esc(d.message) + '</div></div>' : "") +
      '<div class="card"><h2>Itens</h2><table><thead><tr><th>Item</th><th class="num">Quantidade</th><th class="num">Preço unit. (R$)</th><th>Entrega prevista</th><th>Observação</th><th class="num">Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="card"><h2>Condições da proposta</h2><div class="grid">' +
        '<div><label class="f" for="pay">Condição de pagamento</label><input type="text" id="pay" maxlength="60" placeholder="ex.: 28 dias" value="' + esc(a.paymentTerms || "") + '"' + dis + '></div>' +
        '<div><label class="f" for="frt">Frete</label><select id="frt"' + dis + '><option value="">Selecione</option><option value="CIF"' + (a.freight === "CIF" ? " selected" : "") + '>CIF (por conta do fornecedor)</option><option value="FOB"' + (a.freight === "FOB" ? " selected" : "") + '>FOB (por conta do comprador)</option></select></div>' +
        '<div><label class="f" for="val">Proposta válida até</label><input type="date" id="val" min="' + today + '" value="' + (a.validUntil || "") + '"' + dis + '></div>' +
        '<div><label class="f" for="ref">Nº da sua proposta</label><input type="text" id="ref" maxlength="40" value="' + esc(a.proposalRef || "") + '"' + dis + '></div>' +
      '</div><div style="margin-top:12px"><label class="f" for="obs">Observações gerais</label><textarea id="obs" rows="2" maxlength="120"' + dis + '>' + esc(a.notes || "") + '</textarea></div>' +
      '<div class="decline" id="declineBox"><label class="f" for="reason">Motivo (opcional)</label><input type="text" id="reason" maxlength="120" placeholder="ex.: sem estoque, fora da nossa linha">' +
        '<div style="margin-top:10px;display:flex;gap:8px"><button class="primary" id="btnDeclineOk" type="button">Confirmar: não vou cotar</button><button class="ghost" id="btnDeclineCancel" type="button">Voltar</button></div></div>' +
      '</div>';
    $("app").innerHTML = html;
    $("footer").hidden = readOnly;
    wire(readOnly);
    recalc();
  }

  function collect() {
    var lines = [], errors = 0;
    Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr) {
      var g = state.groups[Number(tr.getAttribute("data-gid"))];
      var skip = tr.querySelector(".skipChk");
      var inp = tr.querySelector(".price");
      var price = parseNum(inp.value);
      var skipped = (skip && skip.checked) || price === null;
      inp.classList.toggle("invalid", !skipped && !(price > 0));
      if (!skipped && !(price > 0)) { errors++; }
      g.keys.forEach(function (key) {
        lines.push({ key: key, quoted: !skipped, unitPrice: skipped ? null : price, deliveryDate: skipped ? null : (tr.querySelector(".dd").value || null), notes: tr.querySelector(".nt").value });
      });
    });
    return { lines: lines, errors: errors };
  }

  function recalc() {
    var total = 0, count = 0;
    Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr) {
      var l = state.groups[Number(tr.getAttribute("data-gid"))];
      var skip = tr.querySelector(".skipChk");
      var p = parseNum(tr.querySelector(".price").value);
      var ok = !(skip && skip.checked) && p > 0;
      tr.querySelector(".lt").textContent = ok ? brl(p * l.quantity) : "—";
      if (ok) { total += p * l.quantity; count++; }
    });
    $("total").textContent = brl(total) + (count ? " · " + count + "/" + state.groups.length + " itens" : "");
  }

  function showError(msg) {
    $("err").innerHTML = msg ? '<div class="alert err" role="alert">' + esc(msg) + '</div>' : "";
    if (msg) { $("err").scrollIntoView({ behavior: "smooth", block: "center" }); }
  }

  function busy(b) { $("btnSend").disabled = b; $("btnDecline").disabled = b; }

  function wire(readOnly) {
    var edit = $("btnEdit");
    if (edit) { edit.onclick = function () { render(true); }; }
    if (readOnly) { return; }
    Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr) {
      var chk = tr.querySelector(".skipChk");
      tr.querySelector(".price").addEventListener("input", recalc);
      tr.querySelector(".price").addEventListener("blur", function (e) {
        var n = parseNum(e.target.value);
        if (n > 0) { e.target.value = fmtNum(n); }
      });
      if (chk) {
        chk.addEventListener("change", function () {
          tr.classList.toggle("skipped", chk.checked);
          tr.querySelector(".price").disabled = chk.checked;
          tr.querySelector(".dd").disabled = chk.checked;
          if (chk.checked) { tr.querySelector(".price").classList.remove("invalid"); }
          recalc();
        });
      }
    });
    $("btnSend").onclick = function () {
      var c = collect();
      if (c.errors) { showError("Confira os preços destacados (use vírgula para centavos) ou marque \"Não tenho este item\"."); return; }
      if (!c.lines.some(function (l) { return l.quoted; })) { showError("Informe o preço de ao menos um item, ou use \"Não vou cotar\"."); return; }
      showError("");
      busy(true);
      request("POST", {
        lines: c.lines, paymentTerms: $("pay").value, freight: $("frt").value, validUntil: $("val").value || null,
        proposalRef: $("ref").value, notes: $("obs").value
      }).then(function (d) {
        state = d; render(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }).catch(function (e) { showError(e.message); }).finally(function () { busy(false); });
    };
    $("btnDecline").onclick = function () { $("declineBox").classList.add("show"); $("reason").focus(); };
    $("btnDeclineCancel").onclick = function () { $("declineBox").classList.remove("show"); };
    $("btnDeclineOk").onclick = function () {
      busy(true);
      request("POST", { decline: true, reason: $("reason").value }).then(function (d) {
        state = d; render(false); window.scrollTo({ top: 0, behavior: "smooth" });
      }).catch(function (e) { showError(e.message); }).finally(function () { busy(false); });
    };
  }

  request("GET").then(function (d) {
    applyBrand(d.branding);
    state = d;
    render(false);
  }).catch(function (e) {
    $("app").innerHTML = '<div class="center"><h1>Link indisponível</h1><p>' + esc(e.message) + '</p></div>';
  });
})();
