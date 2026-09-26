sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function emptyLine() { return { date: iso(new Date()), category: "", description: "", amount: null, costCenter: "", accountCode: "", accountLabel: "" }; }

  return BaseController.extend("portal.b1.modules.despesas.controller.New", {
    onInit: function () {
      this.setModel(new JSONModel({ categories: [], costCenters: [], branches: [], requireAttachment: true, accountSuggest: [] }), "cfg");
      this.setModel(new JSONModel(), "exp");
      this.initAttachments();
      this.getRouter().getRoute("despesas.new").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      if (!this.routeOk()) { return; }
      this.resetAttachments();
      this.getModel("exp").setData({ branch: "", comments: "", lines: [emptyLine()], total: 0, maxDate: new Date() });
      var oCfg = this.getModel("cfg");
      var oExp = this.getModel("exp");
      this.busy(this.api.get("/api/m/despesas/config")).then(function (c) {
        oCfg.setData(Object.assign({ accountSuggest: [] }, c));
        if (c.branches.length === 1) { oExp.setProperty("/branch", String(c.branches[0].id)); }
      }).catch(function () {});
    },

    // Conta contábil só é pedida quando a categoria não tem conta configurada
    needsAccount: function (sCategory, aCats) {
      var c = (aCats || []).filter(function (x) { return x.code === sCategory; })[0];
      return !!c && !c.account;
    },

    onAddLine: function () {
      var oModel = this.getModel("exp");
      var aLines = oModel.getProperty("/lines");
      var oLast = aLines[aLines.length - 1] || {};
      var oNew = emptyLine();
      oNew.date = oLast.date || oNew.date;
      oNew.costCenter = oLast.costCenter || "";
      oModel.setProperty("/lines", aLines.concat([oNew]));
    },

    onRemoveLine: function (oEvent) {
      var oModel = this.getModel("exp");
      var i = Number(oEvent.getSource().getBindingContext("exp").getPath().split("/").pop());
      var a = oModel.getProperty("/lines").slice();
      a.splice(i, 1);
      oModel.setProperty("/lines", a);
      this.onRecalc();
    },

    onRecalc: function () {
      var oModel = this.getModel("exp");
      var f = (oModel.getProperty("/lines") || []).reduce(function (s, l) { return s + (Number(l.amount) || 0); }, 0);
      oModel.setProperty("/total", Math.round(f * 100) / 100);
    },

    onAccountSuggest: function (oEvent) {
      var sTerm = oEvent.getParameter("suggestValue");
      var oCfg = this.getModel("cfg");
      clearTimeout(this._tAcc);
      this._tAcc = setTimeout(function () {
        this.api.get("/api/m/despesas/accounts?q=" + encodeURIComponent(sTerm)).then(function (a) {
          oCfg.setProperty("/accountSuggest", a);
        }).catch(function () {});
      }.bind(this), 250);
    },

    onAccountSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var oCtx = oEvent.getSource().getBindingContext("exp");
      var a = oItem.getBindingContext("cfg").getObject();
      this.getModel("exp").setProperty("accountCode", a.code, oCtx);
      this.getModel("exp").setProperty("accountLabel", a.formatCode + " - " + a.name, oCtx);
    },

    onSubmit: function () {
      var d = this.getModel("exp").getData();
      var oCfg = this.getModel("cfg");
      if (oCfg.getProperty("/branches").length && !d.branch) { MessageBox.warning(this.text("branchRequired")); return; }
      if (oCfg.getProperty("/requireAttachment") && !this.getModel("att").getProperty("/files").length) {
        MessageBox.warning(this.text("expReceiptRequired"));
        return;
      }
      var oPayload = {
        branch: d.branch || undefined,
        comments: d.comments,
        lines: d.lines.map(function (l) {
          return { date: l.date, category: l.category, description: l.description, amount: l.amount, costCenter: l.costCenter, accountCode: l.accountCode };
        })
      };
      this.busy(this.attachmentPayload().then(function (aAtt) {
        oPayload.attachments = aAtt;
        return this.api.post("/api/m/despesas", oPayload);
      }.bind(this))).then(function (oRes) {
        this.toast(this.text(oRes.source === "draft" ? "expSentApproval" : "expSent"));
        this.getRouter().navTo("despesas.detail", { source: oRes.source, entry: oRes.entry }, true);
      }.bind(this)).catch(function () {});
    }
  });
});
