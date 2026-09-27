sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  /** Recebimento de mercadorias a partir do pedido de compra (OPDN copiado do OPOR). */
  return BaseController.extend("portal.b1.modules.compras.controller.Receive", {
    onInit: function () {
      this.setModel(new JSONModel({}), "po");
      this.setModel(new JSONModel({ lines: [] }), "rec");
      this.setModel(new JSONModel({ warehouses: [] }), "md");
      this.initAttachments();
      this.getRouter().getRoute("compras.receive").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      this._entry = oEvent.getParameter("arguments").entry;
      this.resetAttachments();
      this.getModel("po").setData({});
      this.getModel("rec").setData({ lines: [] });
      this.busy(Promise.all([
        this.api.get("/api/m/compras/receipts/po/" + this._entry),
        this.api.get("/api/m/compras/warehouses").catch(function () { return []; })
      ])).then(function (a) {
        var po = a[0];
        var aWh = a[1].filter(function (w) { return !po.branch || w.branch === null || w.branch === undefined || String(w.branch) === String(po.branch); });
        this.getModel("md").setProperty("/warehouses", aWh);
        this.getModel("po").setData(po);
        this.getModel("rec").setData({
          date: this.isoDate(new Date()), maxDate: new Date(), numAtCard: "", comments: "",
          lines: po.lines.map(function (l) {
            return Object.assign({}, l, { quantity: l.serial ? 0 : l.open, batchNo: "", expiry: null });
          })
        });
        this.onQty();
      }.bind(this)).catch(function () {});
    },

    onQty: function () {
      var oModel = this.getModel("rec");
      var a = oModel.getProperty("/lines") || [];
      var n = a.filter(function (l) { return Number(l.quantity) > 0; }).length;
      var bAll = a.every(function (l) { return Number(l.quantity) >= l.open; });
      oModel.setProperty("/count", n);
      oModel.setProperty("/summary", this.text(bAll ? "recSummaryTotal" : "recSummaryPartial", [n, a.length]));
    },

    onFillAll: function () {
      var oModel = this.getModel("rec");
      oModel.getProperty("/lines").forEach(function (l, i) { if (!l.serial) { oModel.setProperty("/lines/" + i + "/quantity", l.open); } });
      this.onQty();
    },

    onClearAll: function () {
      var oModel = this.getModel("rec");
      oModel.getProperty("/lines").forEach(function (l, i) { oModel.setProperty("/lines/" + i + "/quantity", 0); });
      this.onQty();
    },

    onOpenPo: function () { this.navToDoc("po", "doc", this._entry); },

    onSubmit: function () {
      var d = this.getModel("rec").getData();
      var aLines = d.lines.filter(function (l) { return Number(l.quantity) > 0; });
      var aErr = [];
      aLines.forEach(function (l) {
        if (Number(l.quantity) > l.open) { aErr.push(this.text("recErrOver", [l.itemName || l.itemCode, l.open])); }
        if (l.batch && !String(l.batchNo || "").trim()) { aErr.push(this.text("recErrBatch", [l.itemName || l.itemCode])); }
      }.bind(this));
      if (aErr.length) { MessageBox.warning(aErr.join("\n")); return; }
      var oPayload = {
        poEntry: Number(this._entry), date: d.date, numAtCard: d.numAtCard, comments: d.comments,
        lines: aLines.map(function (l) {
          return { lineNum: l.lineNum, quantity: l.quantity, warehouse: l.warehouse, batch: l.batch ? l.batchNo : undefined, expiry: l.batch ? l.expiry : undefined };
        })
      };
      this.busy(this.attachmentPayload().then(function (aAtt) {
        oPayload.attachments = aAtt;
        return this.api.post("/api/m/compras/receipts", oPayload);
      }.bind(this))).then(function (r) {
        this.toast(this.text(r.source === "draft" ? "recDonePending" : "recDone", [r.source === "draft" ? r.entry : r.docNum]));
        this.navToDoc("gr", r.source, r.entry, null, true);
      }.bind(this)).catch(function () {});
    }
  });
});
