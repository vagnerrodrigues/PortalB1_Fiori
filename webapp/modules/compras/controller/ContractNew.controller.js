sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  function emptyLine() { return { itemCode: "", itemLabel: "", uom: "", plannedQty: null, unitPrice: null, plannedAmount: null, calcAmount: 0 }; }

  return BaseController.extend("portal.b1.modules.compras.controller.ContractNew", {
    onInit: function () {
      this.setModel(new JSONModel({ itemSuggest: [], vendorSuggest: [] }), "md");
      this.setModel(new JSONModel(), "ag");
      this.getRouter().getRoute("compras.contractNew").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      if (!this.routeOk()) { return; }
      var dEnd = new Date(); dEnd.setFullYear(dEnd.getFullYear() + 1); dEnd.setDate(dEnd.getDate() - 1);
      this.getModel("ag").setData({ cardCode: "", cardLabel: "", description: "", startDate: this.isoDate(new Date()), endDate: this.isoDate(dEnd),
        method: "item", remarks: "", lines: [emptyLine()], total: 0 });
    },

    onVendorSuggest: function (oEvent) {
      this.suggest("/api/m/compras/vendors?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/vendorSuggest");
    },
    onVendorSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var v = oItem.getBindingContext("md").getObject();
      this.getModel("ag").setProperty("/cardCode", v.cardCode);
      this.getModel("ag").setProperty("/cardLabel", v.cardCode + " - " + v.cardName);
    },
    onVendorTyped: function () { this.getModel("ag").setProperty("/cardCode", ""); },

    onItemSuggest: function (oEvent) {
      this.suggest("/api/m/compras/items?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/itemSuggest");
    },
    onItemSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var oCtx = oEvent.getSource().getBindingContext("ag");
      var d = oItem.getBindingContext("md").getObject();
      var oModel = this.getModel("ag");
      oModel.setProperty("itemCode", d.itemCode, oCtx);
      oModel.setProperty("itemLabel", d.itemCode + " - " + d.itemName, oCtx);
      oModel.setProperty("uom", d.uom, oCtx);
    },
    onItemTyped: function (oEvent) { this.getModel("ag").setProperty("itemCode", "", oEvent.getSource().getBindingContext("ag")); },

    onAddLine: function () {
      var oModel = this.getModel("ag");
      oModel.setProperty("/lines", oModel.getProperty("/lines").concat([emptyLine()]));
    },
    onRemoveLine: function (oEvent) {
      var oModel = this.getModel("ag");
      var i = Number(oEvent.getSource().getBindingContext("ag").getPath().split("/").pop());
      var a = oModel.getProperty("/lines").slice();
      a.splice(i, 1);
      oModel.setProperty("/lines", a);
      this.onRecalc();
    },
    onRecalc: function () {
      var oModel = this.getModel("ag");
      var f = 0;
      oModel.getProperty("/lines").forEach(function (l, i) {
        var v = Math.round((Number(l.plannedQty) || 0) * (Number(l.unitPrice) || 0) * 100) / 100;
        oModel.setProperty("/lines/" + i + "/calcAmount", v);
        f += v;
      });
      oModel.setProperty("/total", Math.round(f * 100) / 100);
    },

    onSave: function (sStatus) {
      var d = this.getModel("ag").getData();
      if (!d.cardCode) { MessageBox.warning(this.text("orderNeedVendor")); return; }
      var bMon = d.method === "monetary";
      var aLines = d.lines.filter(function (l) { return bMon ? Number(l.plannedAmount) > 0 : l.itemCode; });
      if (!aLines.length) { MessageBox.warning(this.text("noLines")); return; }
      var oPayload = {
        cardCode: d.cardCode, description: d.description, startDate: d.startDate, endDate: d.endDate, method: d.method,
        remarks: d.remarks, status: sStatus,
        lines: aLines.map(function (l) {
          return bMon ? { itemCode: l.itemCode || undefined, plannedAmount: l.plannedAmount }
            : { itemCode: l.itemCode, plannedQty: l.plannedQty, unitPrice: l.unitPrice };
        })
      };
      this.busy(this.api.post("/api/m/compras/agreements", oPayload)).then(function (r) {
        this.toast(this.text("contractCreated", [r.agreementNo]));
        this.getRouter().navTo("compras.contract", { no: r.agreementNo }, true);
      }.bind(this)).catch(function () {});
    }
  });
});
