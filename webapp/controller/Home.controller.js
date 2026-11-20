sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/ResponsivePopover",
  "sap/m/Select",
  "sap/m/Label",
  "sap/m/Button",
  "sap/m/VBox",
  "sap/ui/core/Item"
], function (BaseController, JSONModel, ResponsivePopover, Select, Label, Button, VBox, Item) {
  "use strict";

  var MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  // Ações rápidas, na ordem do produto. Só aparecem as liberadas ao usuário; se faltarem, completa com outros tiles.
  var QUICK = [
    { tile: "compras.new", titleKey: "actNew", subKey: "actNewSub", icon: "sap-icon://add-document" },
    { tile: "compras.mine", titleKey: "actMine", subKey: "actMineSub", icon: "sap-icon://search" },
    { tile: "compras.rfq", titleKey: "actRfq", subKey: "actRfqSub", icon: "sap-icon://compare" },
    { tile: "compras.orders", titleKey: "actOrders", subKey: "actOrdersSub", icon: "sap-icon://sales-order" },
    { tile: "compras.receipts", titleKey: "actReceipts", subKey: "actReceiptsSub", icon: "sap-icon://shipping-status" },
    { tile: "parceiros.search", titleKey: "actPartners", subKey: "actPartnersSub", icon: "sap-icon://supplier" }
  ];

  var int = function (n) { return Number(n || 0).toLocaleString("pt-BR"); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]; }); };

  return BaseController.extend("portal.b1.controller.Home", {
    onInit: function () {
      this.setModel(new JSONModel({}), "home");
      this.getRouter().getRoute("home").attachPatternMatched(this._render, this);
      // Cards de indicadores clicáveis (mouse e teclado): abrem a lista correspondente
      [["kpiSpend", "compras.orders"], ["kpiOpen", "compras.orders"], ["kpiSaving", "compras.rfqs"],
        ["kpiContracts", "compras.contracts"], ["kpiVendors", "compras.orders"]].forEach(function (a) {
        var oCard = this.byId(a[0]);
        var go = function () { this.getRouter().navTo(a[1]); }.bind(this);
        oCard.addStyleClass("pbClickable");
        oCard.attachBrowserEvent("click", function (e) { if (!e.target.closest || !e.target.closest(".sapMLnk")) { go(); } });
        oCard.attachBrowserEvent("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        oCard.addEventDelegate({ onAfterRendering: function () {
          var el = oCard.getDomRef();
          if (el) { el.setAttribute("tabindex", "0"); el.setAttribute("role", "link"); }
        } });
      }, this);
    },

    _home: function () { return this.getModel("home"); },

    _render: function () {
      var oSession = this.getModel("session");
      if (!oSession.getProperty("/loggedIn")) { return; }
      var aModules = oSession.getProperty("/modules") || [];
      var oCompras = aModules.filter(function (m) { return m.id === "compras"; })[0];
      var bBuyer = !!(oCompras && oCompras.buyer);
      var sFirst = String(oSession.getProperty("/user/userName") || "").split(" ")[0];
      var cur = new Date().getFullYear();
      this._year = this._year || cur;
      this._counts = {};
      this._dash = null;
      this._prev = null;
      this._home().setData({
        hello: this.text("homeHello", [sFirst]),
        heroImg: this._heroImg(),
        subtitle: this.text("homeSubtitle", [oSession.getProperty("/tenant/name"),
          new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })]),
        buyer: bBuyer,
        year: String(this._year),
        years: [cur - 2, cur - 1, cur].map(function (n) { return { key: String(n) }; }),
        dash: { busy: bBuyer, error: false, vendors: [], consumed: 0, spendDelta: {}, hasContracts: false },
        chart: { mode: (this._chart && this._chart.mode) || "6" },
        alertsBusy: true,
        actions: [],
        modules: []
      });
      this._chart = { mode: this._home().getProperty("/chart/mode"), from: (this._chart && this._chart.from) || 0, to: (this._chart && this._chart.to) || 11 };
      this.byId("middle").toggleStyleClass("pbMiddleSingle", !bBuyer);
      this._buildTiles();

      // Contadores primeiro e o painel depois: a sessão do Service Layer atende uma chamada por vez
      var that = this;
      var aCounted = aModules.filter(function (m) { return (m.tiles || []).some(function (t) { return t.counter; }); });
      aCounted.reduce(function (p, m) {
        return p.then(function () {
          return that.api.get("/api/m/" + m.id + "/counters").then(function (o) {
            Object.keys(o || {}).forEach(function (k) { that._counts[m.id + "." + k] = o[k]; });
          }).catch(function () {});
        });
      }, Promise.resolve()).then(function () {
        that._buildTiles();
        that._buildAlerts();
        if (bBuyer) { that._loadDash(false); } else { that._home().setProperty("/alertsBusy", false); }
      });
    },

    /** Imagem da faixa de boas-vindas: "heroImage" da marca (branding.json); sem imagem, só o fundo. */
    _heroImg: function () {
      var s = this.getModel("brand").getProperty("/heroImage");
      return s ? "<div class=\"pbHeroImg\" style=\"background-image:url(&quot;" + esc(encodeURI(s)) + "&quot;)\"></div>" : "<div class=\"pbHeroImg pbHeroImgNone\"></div>";
    },

    // ---------- Ações rápidas e demais telas ----------
    _buildTiles: function () {
      var aModules = this.getModel("session").getProperty("/modules") || [];
      var tiles = {};
      var that = this;
      aModules.forEach(function (m) { (m.tiles || []).forEach(function (t) { tiles[m.id + "." + t.id] = t; }); });
      var c = this._counts;
      var used = {};
      var aActions = QUICK.filter(function (q) { return tiles[q.tile]; }).map(function (q) {
        used[q.tile] = true;
        var n = c[q.tile];
        var sub = q.subKey === "actNewSub" || q.subKey === "actPartnersSub" || n === undefined
          ? (q.subKey === "actNewSub" || q.subKey === "actPartnersSub" ? that.text(q.subKey) : tiles[q.tile].subtitle)
          : that.text(q.subKey, [int(n)]);
        return { title: that.text(q.titleKey), subtitle: sub, icon: q.icon, route: tiles[q.tile].route };
      });
      // Perfis sem as ações padrão (ex.: só despesas): completa com os tiles que o usuário tem
      Object.keys(tiles).forEach(function (k) {
        if (aActions.length >= 6 || used[k]) { return; }
        used[k] = true;
        aActions.push({ title: tiles[k].title, subtitle: tiles[k].subtitle, icon: tiles[k].icon, route: tiles[k].route });
      });
      var aGroups = aModules.map(function (m) {
        return { title: m.title, tiles: (m.tiles || []).filter(function (t) { return !used[m.id + "." + t.id]; }).map(function (t) {
          var n = c[m.id + "." + t.id];
          return { title: t.title, subtitle: n === undefined ? t.subtitle : int(n) + " · " + t.subtitle, icon: t.icon, route: t.route };
        }) };
      }).filter(function (g) { return g.tiles.length; });
      this._home().setProperty("/actions", aActions);
      this._home().setProperty("/modules", aGroups);
    },

    onTile: function (oEvent) {
      this.getRouter().navTo(oEvent.getSource().getBindingContext("home").getProperty("route"));
    },

    // ---------- Alertas e pendências (também alimentam o sino do cabeçalho) ----------
    _buildAlerts: function () {
      var c = this._counts;
      var d = this._dash;
      var fmt = this.formatter;
      var a = [];
      var TONE = {
        Error: { color: "#E34C55", bg: "#FFF0F0" }, Warning: { color: "#E0861A", bg: "#FFF5E8" }, Information: { color: "#0866E9", bg: "#EDF5FF" }
      };
      var add = function (o) {
        var tone = TONE[o.state];
        o.color = tone.color; o.bg = tone.bg;
        o.html = "<strong style=\"color:" + tone.color + "\">" + esc(o.count) + "</strong> " + esc(o.label);
        o.text = o.count + " " + o.label;
        a.push(o);
      };
      if (c["compras.approvals"] > 0) {
        add({ count: int(c["compras.approvals"]), label: this.text("alertApprovals"), icon: "sap-icon://approvals", state: "Error", route: "compras.approvals" });
      }
      if (d && d.orders && d.orders.late.count > 0) {
        add({ count: int(d.orders.late.count), label: this.text("alertLate"), detail: this.text("alertLateDetail", [fmt.money(d.orders.late.total), d.year]),
          icon: "sap-icon://message-error", state: "Error", route: "compras.orders" });
      }
      if (c["compras.rfq"] > 0) {
        add({ count: int(c["compras.rfq"]), label: this.text("alertRfq"), detail: this.text("alertRfqDetail"), icon: "sap-icon://history", state: "Warning", route: "compras.rfqs" });
      }
      if (c["compras.receipts"] > 0) {
        add({ count: int(c["compras.receipts"]), label: this.text("alertReceipts"), icon: "sap-icon://message-information", state: "Information", route: "compras.receipts" });
      }
      if (d && d.agreements && d.agreements.expiring > 0) {
        add({ count: int(d.agreements.expiring), label: this.text("alertContracts"), icon: "sap-icon://appointment-2", state: "Warning", route: "compras.contracts" });
      }
      if (c["beto.inbox"] > 0) {
        add({ count: int(c["beto.inbox"]), label: this.text("alertBeto"), detail: this.text("alertBetoDetail"), icon: "sap-icon://lightbulb", state: "Information", route: "beto.inbox" });
      }
      this.getModel("alerts").setData({ items: a, total: a.length, totalText: a.length ? this.text(a.length === 1 ? "alertsOne" : "alertsMany", [a.length]) : "" });
    },

    onAlert: function (oEvent) {
      this.getRouter().navTo(oEvent.getSource().getBindingContext("alerts").getProperty("route"));
    },

    // ---------- Painel do comprador ----------
    onYear: function (oEvent) {
      this._year = Number(oEvent.getParameter("item").getKey());
      this._loadDash(false);
    },

    onRefresh: function () { this._loadDash(true); },

    onOrders: function () { this.getRouter().navTo("compras.orders"); },

    _loadDash: function (bRefresh) {
      var oHome = this._home();
      var y = this._year;
      var that = this;
      oHome.setProperty("/dash/busy", true);
      oHome.setProperty("/dash/error", false);
      this._prev = null;
      this.api.get("/api/m/compras/dashboard?year=" + y + (bRefresh ? "&refresh=1" : "")).then(function (d) {
        that._dash = d;
        that._applyDash();
        that._buildAlerts();
        oHome.setProperty("/dash/busy", false);
        oHome.setProperty("/alertsBusy", false);
        // Ano anterior (comparativos): depois, em sequência, com cache de 10 min no servidor
        return that.api.get("/api/m/compras/dashboard?year=" + (y - 1)).then(function (p) {
          if (that._year !== y) { return; }
          that._prev = p;
          that._applyDash();
        }).catch(function () {});
      }).catch(function () {
        oHome.setProperty("/dash/error", true);
      }).finally(function () {
        oHome.setProperty("/dash/busy", false);
        oHome.setProperty("/alertsBusy", false);
      });
    },

    /** Último mês com dados do ano exibido (mês atual no ano corrente; dezembro nos anteriores). */
    _lastMonth: function () {
      return this._year === new Date().getFullYear() ? new Date().getMonth() : 11;
    },

    _sum: function (aMonthly, from, to) {
      var s = 0;
      for (var i = from; i <= to; i++) { s += Number((aMonthly || [])[i] || 0); }
      return s;
    },

    /** Variação percentual com seta (alta em verde, queda em vermelho, como no padrão visual do portal). */
    _delta: function (cur, prev) {
      if (!prev) { return { text: "", state: "None", icon: "" }; }
      var pct = ((cur - prev) / prev) * 100;
      var s = (Math.round(Math.abs(pct) * 10) / 10).toFixed(1).replace(".", ",") + "%";
      return { text: s, state: pct >= 0 ? "Success" : "Error", icon: pct >= 0 ? "sap-icon://arrow-top" : "sap-icon://arrow-bottom" };
    },

    /** Valor curto para o resumo do gráfico: R$ 51,29 mi / R$ 230,5 mil. */
    _compact: function (v) {
      var n = Number(v || 0);
      if (Math.abs(n) >= 1e6) { return "R$ " + (n / 1e6).toFixed(2).replace(".", ",") + " mi"; }
      if (Math.abs(n) >= 1e4) { return "R$ " + (n / 1e3).toFixed(1).replace(".", ",") + " mil"; }
      return this.formatter.money(n);
    },

    _applyDash: function () {
      var d = this._dash;
      var p = this._prev;
      var fmt = this.formatter;
      var oHome = this._home();
      var last = this._lastMonth();
      var o = { busy: false, error: false, vendors: [] };

      if (d.orders) {
        var ytdCur = this._sum(d.orders.monthly, 0, last);
        var ytdPrev = p && p.orders ? this._sum(p.orders.monthly, 0, last) : 0;
        o.spendTitle = this.text("dashSpend", [d.year]);
        o.spend = fmt.money(d.orders.total);
        o.spendSub = this.text("dashOrders", [int(d.orders.count)]);
        o.spendDelta = this._delta(ytdCur, ytdPrev);
        if (o.spendDelta.text) {
          o.spendDelta.text += " " + this.text("homeVsYear", [d.year - 1]) + (last < 11 ? " (" + MONTHS[0] + "–" + MONTHS[last] + ")" : "");
        }
        o.spark = this._spark(d.orders.monthly.slice(0, last + 1));
        o.open = int(d.orders.open.count);
        o.openSub = fmt.money(d.orders.open.total);
        o.late = d.orders.late.count;
        o.lateText = d.orders.late.count ? this.text("dashLate", [int(d.orders.late.count), fmt.money(d.orders.late.total)]) : this.text("homeLateNone");
        var lp = d.orders.open.count ? Math.round((d.orders.late.count / d.orders.open.count) * 100) : 0;
        o.lateBar = "<div class=\"pbSplit\" title=\"" + lp + "% atrasados\"><span class=\"pbSplitOk\" style=\"width:" + (100 - lp) + "%\"></span><span class=\"pbSplitLate\" style=\"width:" + lp + "%\"></span></div>";
        var max = (d.orders.topVendors[0] && d.orders.topVendors[0].total) || 1;
        o.vendors = d.orders.topVendors.slice(0, 3).map(function (v, i) {
          return { rank: String(i + 1), cardName: v.cardName || v.cardCode, totalText: fmt.money(v.total),
            bar: "<div class=\"pbVBar\"><span style=\"width:" + Math.max(Math.round((v.total / max) * 100), 2) + "%\"></span></div>" };
        });
      } else {
        o.spendTitle = this.text("dashSpend", [d.year]);
        o.spend = "–"; o.open = "–"; o.lateText = ""; o.spark = ""; o.lateBar = "";
        o.spendDelta = { text: "" };
      }

      o.saving = d.rfq.savingPct === null ? "–" : fmt.money(d.rfq.saving);
      o.savingSub = d.rfq.savingPct === null ? this.text("dashSavingNone")
        : this.text(d.rfq.savingPct >= 0 ? "dashSavingPct" : "dashSavingAbove", [String(Math.abs(d.rfq.savingPct)).replace(".", ",")]);
      o.rfqText = this.text("dashRfq", [d.rfq.count, d.rfq.open, d.rfq.responseRate === null ? "–" : d.rfq.responseRate]);

      o.hasContracts = !!d.agreements;
      if (d.agreements) {
        o.contracts = int(d.agreements.active);
        var cp = Math.min(d.agreements.consumption || 0, 100);
        o.consumedBar = "<div class=\"pbMeter\" title=\"" + fmt.pct(d.agreements.consumption || 0) + "\"><span style=\"width:" + cp + "%\"></span></div>";
        o.consumedText = this.text("homeConsumed", [fmt.pct(d.agreements.consumption || 0)]);
        o.expiring = d.agreements.expiring;
        o.expiringText = this.text("dashExpiring", [int(d.agreements.expiring)]);
      }
      oHome.setProperty("/dash", o);
      this._buildChart();
    },

    _spark: function (aValues) {
      if (aValues.length < 2) { return ""; }
      var max = Math.max.apply(null, aValues.concat([1]));
      var step = 220 / (aValues.length - 1);
      var pts = aValues.map(function (v, i) { return (i * step).toFixed(1) + "," + (32 - (v / max) * 28).toFixed(1); }).join(" ");
      var yEnd = (32 - (aValues[aValues.length - 1] / max) * 28) / 34 * 100;
      return "<div class=\"pbSparkWrap\"><svg class=\"pbSpark\" viewBox=\"0 0 220 34\" preserveAspectRatio=\"none\" aria-hidden=\"true\">" +
        "<defs><linearGradient id=\"pbSparkG\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"currentColor\" stop-opacity=\".22\"/><stop offset=\"1\" stop-color=\"currentColor\" stop-opacity=\"0\"/></linearGradient></defs>" +
        "<polygon points=\"0,34 " + pts + " 220,34\" fill=\"url(#pbSparkG)\"/><polyline points=\"" + pts + "\" class=\"pbSparkLine\"/></svg>" +
        "<i class=\"pbSparkDot\" style=\"top:" + yEnd.toFixed(1) + "%\"></i></div>";
    },

    // ---------- Visão de compras ----------
    _window: function () {
      var last = this._lastMonth();
      if (this._chart.mode === "6") { return { from: Math.max(0, last - 5), to: last }; }
      if (this._chart.mode === "custom") { return { from: this._chart.from, to: this._chart.to }; }
      return { from: 0, to: 11 };
    },

    _buildChart: function () {
      var d = this._dash;
      var p = this._prev;
      var oHome = this._home();
      if (!d || !d.orders) { oHome.setProperty("/chart/bars", ""); oHome.setProperty("/chart/legend", ""); return; }
      var fmt = this.formatter;
      var w = this._window();
      var cur = d.orders.monthly;
      var prev = p && p.orders ? p.orders.monthly : null;
      var max = 1;
      for (var i = w.from; i <= w.to; i++) { max = Math.max(max, cur[i] || 0, prev ? prev[i] || 0 : 0); }
      var n = w.to - w.from + 1;
      var lastShown = Math.min(w.to, this._lastMonth());
      var cols = "", labels = "", pts = [], dots = "";
      for (var m = w.from; m <= w.to; m++) {
        var k = m - w.from;
        var hc = cur[m] ? Math.max(Math.round((cur[m] / max) * 92), 2) : 0;
        var hp = prev && prev[m] ? Math.max(Math.round((prev[m] / max) * 92), 2) : 0;
        var tip = MONTHS[m] + "/" + d.year + ": " + fmt.money(cur[m] || 0) + (prev ? " · " + MONTHS[m] + "/" + (d.year - 1) + ": " + fmt.money(prev[m] || 0) : "");
        cols += "<div class=\"pbB\" title=\"" + esc(tip) + "\"><span class=\"pbBCur\" style=\"height:" + hc + "%\"></span>" +
          (prev ? "<span class=\"pbBPrev\" style=\"height:" + hp + "%\"></span>" : "") + "</div>";
        labels += "<em>" + MONTHS[m] + "</em>";
        if (m <= lastShown) {
          var x = ((k + 0.5) / n) * 100;
          pts.push(x.toFixed(2) + "," + (100 - hc).toFixed(2));
          dots += "<i class=\"pbDot\" style=\"left:" + x.toFixed(2) + "%;bottom:" + hc + "%\"></i>";
        }
      }
      var html = "<div class=\"pbChart\" role=\"img\" aria-label=\"" + esc(this.text("homeChartTitle")) + "\">" +
        "<div class=\"pbPlot\" style=\"grid-template-columns:repeat(" + n + ",minmax(0,1fr))\"><div class=\"pbGrid\"><i></i><i></i><i></i><i></i></div>" + cols +
        (pts.length > 1 ? "<svg class=\"pbLine\" viewBox=\"0 0 100 100\" preserveAspectRatio=\"none\" aria-hidden=\"true\"><polyline points=\"" + pts.join(" ") + "\"/></svg>" : "") +
        dots + "</div><div class=\"pbLabels\" style=\"grid-template-columns:repeat(" + n + ",minmax(0,1fr))\">" + labels + "</div></div>";
      // Comparação justa no ano corrente: só até o mês atual nos dois anos
      var cmpTo = Math.min(w.to, this._lastMonth());
      var sumCur = this._sum(cur, w.from, w.to);
      var sumPrev = prev && cmpTo >= w.from ? this._sum(prev, w.from, cmpTo) : 0;
      var cmpCur = cmpTo >= w.from ? this._sum(cur, w.from, cmpTo) : 0;
      var period = w.from === 0 && w.to === 11 ? this.text("homeChartYear", [d.year]) : MONTHS[w.from] + (w.to !== w.from ? "–" + MONTHS[w.to] : "") + " " + d.year;
      oHome.setProperty("/chart/bars", html);
      oHome.setProperty("/chart/legend", "<div class=\"pbLegend\"><span><i class=\"pbLgCur\"></i>" + esc(this.text("homeLegendCur")) + " " + d.year + "</span>" +
        (prev ? "<span><i class=\"pbLgPrev\"></i>" + esc(this.text("homeLegendPrev")) + " (" + (d.year - 1) + ")</span>" : "") + "</div>");
      oHome.setProperty("/chart/total", this._compact(sumCur));
      oHome.setProperty("/chart/totalFull", fmt.money(sumCur));
      oHome.setProperty("/chart/totalLabel", this.text("homeChartTotal", [period]));
      oHome.setProperty("/chart/delta", this._delta(cmpCur, sumPrev));
      var cmpPeriod = cmpTo < w.to ? " (" + MONTHS[w.from] + "–" + MONTHS[cmpTo] + ")" : "";
      oHome.setProperty("/chart/deltaLabel", !prev ? "" : sumPrev ? this.text("homeChartVs", [d.year - 1]) + cmpPeriod : this.text("homeChartNoPrev", [d.year - 1]));
    },

    onChartMode: function (oEvent) {
      var sKey = oEvent.getParameter("item").getKey();
      if (sKey === "custom") { this._openCustom(); return; }
      this._chart.mode = sKey;
      this._buildChart();
    },

    _openCustom: function () {
      var that = this;
      if (!this._custom) {
        var items = MONTHS.map(function (m, i) { return new Item({ key: String(i), text: m }); });
        this._from = new Select({ width: "100%", items: items });
        this._to = new Select({ width: "100%", items: items.map(function (it) { return it.clone(); }) });
        this._custom = new ResponsivePopover({
          title: this.text("homeCustomTitle"), placement: "Bottom", contentWidth: "16rem",
          content: [new VBox({ items: [
            new Label({ text: this.text("homeFrom"), labelFor: this._from }), this._from,
            new Label({ text: this.text("homeTo"), labelFor: this._to }).addStyleClass("sapUiSmallMarginTop"), this._to
          ] }).addStyleClass("sapUiSmallMargin")],
          endButton: new Button({ text: this.text("homeApply"), type: "Emphasized", press: function () {
            var a = Number(that._from.getSelectedKey());
            var b = Number(that._to.getSelectedKey());
            that._chart = { mode: "custom", from: Math.min(a, b), to: Math.max(a, b) };
            that._custom.close();
            that._buildChart();
          } }),
          afterClose: function () { that._home().setProperty("/chart/mode", that._chart.mode); }
        });
        this.getView().addDependent(this._custom);
      }
      this._from.setSelectedKey(String(this._chart.from));
      this._to.setSelectedKey(String(this._chart.mode === "custom" ? this._chart.to : this._lastMonth()));
      this._custom.openBy(this.byId("chartMode"));
    }
  });
});
