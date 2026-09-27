sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/Dialog",
  "sap/m/TextArea",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/MessageBox",
  "sap/ui/core/HTML"
], function (BaseController, JSONModel, Dialog, TextArea, Button, Label, MessageBox, HTML) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Detail", {
    onInit: function () {
      this.setModel(new JSONModel({}), "doc");
      this.setModel(new JSONModel({ count: 0 }), "rel");
      this.setModel(new JSONModel({ mode: "view", approvalCode: null }), "view");
      this.getRouter().getRoute("compras.detail").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      var oArgs = oEvent.getParameter("arguments");
      var oQuery = oArgs["?query"] || {};
      this._source = oArgs.source;
      this._entry = oArgs.entry;
      this._kind = this.SLUG_KIND[oArgs.kind] || "pr";
      this.getModel("view").setData({ mode: oQuery.mode === "approve" ? "approve" : "view", approvalCode: oQuery.code || null });
      this._load();
    },

    _load: function () {
      this.getModel("doc").setData({});
      var sBase = "/api/m/compras/docs/" + this._kind + "/" + this._source + "/" + this._entry;
      return this.busy(this.api.get(sBase)).then(function (o) {
        o.kind = o.kind || this._kind;
        this._kind = o.kind; // rascunho: o tipo real vem do SAP
        o.attachmentBase = sBase + "/attachments";
        this.getModel("doc").setData(o);
        var oCompras = (this.getModel("session").getProperty("/modules") || []).filter(function (m) { return m.id === "compras"; })[0];
        this.getModel("view").setProperty("/canReceive", o.kind === "po" && o.source === "doc" && o.status === "OPEN" &&
          !!(oCompras && oCompras.receiver) && this.getModel("view").getProperty("/mode") !== "approve");
        this.getModel("view").setProperty("/receiptText", this._receiptText(o));
        if (o.docType !== "service") { this.onLoadRelations(); }
      }.bind(this)).catch(function () {});
    },

    /** Situação do recebimento do pedido, lida do SAP (inclui recebimentos lançados direto no SAP). */
    _receiptText: function (o) {
      if (o.kind !== "po" || o.source !== "doc") { return ""; }
      var aL = (o.lines || []).filter(function (l) { return l.openQty !== null && l.openQty !== undefined; });
      if (!aL.length) { return ""; }
      var fOpen = aL.reduce(function (s, l) { return s + Number(l.openQty); }, 0);
      var fQty = aL.reduce(function (s, l) { return s + Number(l.quantity); }, 0);
      if (fOpen <= 0) { return this.text("recStTotal"); }
      return fOpen < fQty ? this.text("recStPartial") : this.text("recStNone");
    },

    onReceive: function () {
      this.getRouter().navTo("compras.receive", { entry: this._entry });
    },

    // ---------- Mapa de relações ----------
    onLoadRelations: function () {
      var oBox = this.byId("relBox");
      oBox.destroyItems();
      oBox.setBusyIndicatorDelay(0).setBusy(true);
      var sUrl = "/api/m/compras/docs/" + this._kind + "/" + this._source + "/" + this._entry + "/relations";
      this.api.get(sUrl).then(this._renderRelations.bind(this)).catch(function () {
        oBox.addItem(new HTML({ content: "<div class=\"pbRelEmpty\">" + this.text("relError") + "</div>" }));
      }.bind(this)).finally(function () { oBox.setBusy(false); });
    },

    /** Desenha os documentos em colunas por etapa, ligados por setas (SVG). */
    _renderRelations: function (g) {
      var oBox = this.byId("relBox");
      var fmt = this.formatter;
      var that = this;
      this.getModel("rel").setProperty("/count", g.nodes.length);
      var esc = function (s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
      var W = 220, H = 90, GX = 64, GY = 16, PAD = 12;
      var stages = [];
      g.nodes.forEach(function (n) { if (stages.indexOf(n.stage) < 0) { stages.push(n.stage); } });
      stages.sort(function (a, b) { return a - b; });
      var cols = stages.map(function (st) {
        return g.nodes.filter(function (n) { return n.stage === st; })
          .sort(function (a, b) { return a.kind.localeCompare(b.kind) || (a.entry - b.entry); });
      });
      var pos = {};
      cols.forEach(function (c, ci) { c.forEach(function (n, ri) { pos[n.key] = { x: PAD + ci * (W + GX), y: PAD + ri * (H + GY) }; }); });
      var maxRows = Math.max.apply(null, cols.map(function (c) { return c.length; }).concat([1]));
      var width = PAD * 2 + cols.length * (W + GX) - GX;
      var height = PAD * 2 + maxRows * (H + GY) - GY;
      var status = function (n) {
        if (!n.status) { return ""; }
        if (n.kind === "rfq") { return fmt.prefixed("rfqSt_", n.status); }
        if (n.kind === "ag") { return fmt.prefixed("agSt_", n.status); }
        return fmt.docStatusText(n.kind === "pr" || n.kind === "pq" ? n.kind : "po", n.status);
      };
      var title = function (n) {
        if (n.source === "draft") { return that.text("relDraft", [n.entry]); }
        return (n.kind === "ag" ? that.text("relAg", [n.docNum]) : n.kind === "rfq" ? that.text("rfqTitle", [n.docNum]) : "N\u00ba " + (n.docNum || n.entry));
      };
      var nav = { pr: 1, pq: 1, po: 1, rfq: 1, ag: 1 };
      var sSvg = "<svg class=\"pbRelSvg\" width=\"" + width + "\" height=\"" + height + "\" aria-hidden=\"true\">" +
        "<defs><marker id=\"pbArrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0,0 L10,5 L0,10 z\" /></marker></defs>" +
        g.edges.map(function (e) {
          var a = pos[e.from], b = pos[e.to];
          if (!a || !b) { return ""; }
          var x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
          if (b.x <= a.x) { x1 = a.x + W / 2; y1 = a.y + H; x2 = b.x + W / 2; y2 = b.y - 2; } // mesma coluna: liga por baixo
          var mx = (x1 + x2) / 2;
          var d = b.x <= a.x ? "M" + x1 + "," + y1 + " L" + x2 + "," + y2 : "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2;
          return "<path d=\"" + d + "\" marker-end=\"url(#pbArrow)\" />" +
            (e.label ? "<text x=\"" + mx + "\" y=\"" + ((y1 + y2) / 2 - 6) + "\" text-anchor=\"middle\">" + esc(e.label) + "</text>" : "");
        }).join("") + "</svg>";
      var sCards = g.nodes.map(function (n) {
        var p = pos[n.key];
        var bNav = nav[n.kind] && !n.error;
        return "<div class=\"pbRelCard pbRel-" + n.kind + (n.current ? " pbRelCurrent" : "") + (bNav ? " pbRelNav" : "") + "\" style=\"left:" + p.x + "px;top:" + p.y + "px;width:" + W + "px;height:" + H + "px\"" +
          (bNav ? " data-kind=\"" + n.kind + "\" data-source=\"" + (n.source || "doc") + "\" data-entry=\"" + n.entry + "\" tabindex=\"0\" role=\"button\"" : "") + ">" +
          "<div class=\"pbRelKind\">" + esc(that.text("kind_" + n.kind)) + (n.current ? "<b>" + esc(that.text("relCurrent")) + "</b>" : "") + "</div>" +
          "<div class=\"pbRelNum\">" + esc(title(n)) + (n.total ? "<span>" + esc(fmt.money(n.total)) + "</span>" : "") + "</div>" +
          "<div class=\"pbRelSub\">" + esc(n.error || n.cardName || "") + "</div>" +
          "<div class=\"pbRelSub\">" + esc([fmt.date(n.date), status(n), n.extra].filter(Boolean).join(" \u00b7 ")) + "</div>" +
          "</div>";
      }).join("");
      var oHtml = new HTML({ content: "<div class=\"pbRelWrap\"><div class=\"pbRelCanvas\" style=\"width:" + width + "px;height:" + height + "px\">" + sSvg + sCards + "</div></div>" });
      oHtml.attachAfterRendering(function () {
        var el = oHtml.getDomRef();
        if (!el) { return; }
        Array.prototype.forEach.call(el.querySelectorAll(".pbRelNav"), function (c) {
          var go = function () { that._openRelated(c.getAttribute("data-kind"), c.getAttribute("data-source"), c.getAttribute("data-entry")); };
          c.addEventListener("click", go);
          c.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { go(); } });
        });
      });
      oBox.addItem(oHtml);
      if (g.truncated) { oBox.addItem(new HTML({ content: "<div class=\"pbRelEmpty\">" + esc(this.text("relTruncated")) + "</div>" })); }
    },

    _openRelated: function (sKind, sSource, sEntry) {
      if (sKind === "rfq") { this.getRouter().navTo("compras.rfq", { id: sEntry }); return; }
      if (sKind === "ag") { this.getRouter().navTo("compras.contract", { no: sEntry }); return; }
      if (sKind === this._kind && sSource === this._source && String(sEntry) === String(this._entry)) { return; }
      this.navToDoc(sKind, sSource, sEntry);
    },

    onOpenGenerated: function () {
      var g = this.getModel("doc").getProperty("/generated");
      if (g) { this.navToDoc(this._kind, "doc", g.entry); }
    },

    // Requisitante efetiva o rascunho aprovado (mesmo comportamento do B1: originador gera o documento)
    onFinalize: function () {
      this.busy(this.api.post("/api/m/compras/docs/" + this._kind + "/draft/" + this._entry + "/finalize")).then(function () {
        this.toast(this.text("finalized"));
        this.getRouter().navTo(({ pr: "compras.mine", pq: "compras.offers", po: "compras.orders" })[this._kind] || "compras.mine", {}, true);
      }.bind(this)).catch(function () {});
    },

    onDecide: function (bApprove) {
      var oText = new TextArea({ width: "100%", rows: 3, maxLength: 254 });
      var oDialog = new Dialog({
        title: this.text(bApprove ? "approve" : "reject"),
        type: "Message",
        content: [new Label({ text: this.text("remarks"), labelFor: oText, required: !bApprove }), oText],
        beginButton: new Button({
          text: this.text("confirm"),
          type: bApprove ? "Accept" : "Reject",
          press: function () {
            var sRemarks = oText.getValue().trim();
            if (!bApprove && !sRemarks) { MessageBox.warning(this.text("rejectReasonRequired")); return; }
            oDialog.close();
            this._sendDecision(bApprove, sRemarks);
          }.bind(this)
        }),
        endButton: new Button({ text: this.text("cancel"), press: function () { oDialog.close(); } }),
        afterClose: function () { oDialog.destroy(); }
      });
      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    _sendDecision: function (bApprove, sRemarks) {
      var sCode = this.getModel("view").getProperty("/approvalCode") || this.getModel("doc").getProperty("/approval/code");
      this.busy(this.api.post("/api/m/compras/approvals/" + sCode + "/decision", { approve: bApprove, remarks: sRemarks })).then(function () {
        this.toast(this.text(bApprove ? "approved" : "rejected"));
        this.getRouter().navTo("compras.approvals", {}, true);
      }.bind(this)).catch(function () {});
    }
  });
});
