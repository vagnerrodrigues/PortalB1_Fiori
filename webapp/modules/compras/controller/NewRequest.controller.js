sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  function emptyLine() {
    return { itemCode: "", itemLabel: "", uom: "", quantity: 1, unitPrice: null, costCenter: "", warehouse: "", vendor: "", vendorLabel: "" };
  }
  function isoDate(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

  return BaseController.extend("portal.b1.modules.compras.controller.NewRequest", {
    onInit: function () {
      this.setModel(new JSONModel({ costCenters: [], warehouses: [], whFiltered: [], branches: [], itemSuggest: [], vendorSuggest: [] }), "md");
      this.setModel(new JSONModel(), "req");
      this.initAttachments();
      this.getRouter().getRoute("compras.new").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      if (!this.routeOk()) { return; }
      this.resetAttachments();
      var dNext = new Date(); dNext.setDate(dNext.getDate() + 7);
      this.getModel("req").setData({ branch: "", requiredDate: isoDate(dNext), minDate: new Date(), comments: "", lines: [emptyLine()], total: 0 });
      var oMd = this.getModel("md");
      var oReq = this.getModel("req");
      Promise.all([
        this.api.get("/api/m/compras/cost-centers"),
        this.api.get("/api/m/compras/warehouses"),
        this.api.get("/api/m/compras/branches")
      ]).then(function (a) {
        oMd.setProperty("/costCenters", a[0]);
        oMd.setProperty("/warehouses", a[1]);
        oMd.setProperty("/branches", a[2]);
        if (a[2].length === 1) { oReq.setProperty("/branch", String(a[2][0].id)); }
        this._filterWarehouses();
      }.bind(this)).catch(function () {});
    },

    // ---- filial: depósitos pertencem à filial (multi-filial do B1) ----
    onBranchChange: function () {
      this._filterWarehouses();
      var oModel = this.getModel("req");
      var aCodes = this.getModel("md").getProperty("/whFiltered").map(function (w) { return w.code; });
      oModel.getProperty("/lines").forEach(function (l, i) {
        if (l.warehouse && aCodes.indexOf(l.warehouse) < 0) { oModel.setProperty("/lines/" + i + "/warehouse", ""); }
      });
    },

    _filterWarehouses: function () {
      var oMd = this.getModel("md");
      var sBranch = this.getModel("req").getProperty("/branch");
      var aAll = oMd.getProperty("/warehouses") || [];
      oMd.setProperty("/whFiltered", aAll.filter(function (w) {
        return !sBranch || w.branch === null || w.branch === undefined || String(w.branch) === String(sBranch);
      }));
    },

    // ---- linhas ----
    onAddLine: function () {
      var oModel = this.getModel("req");
      var aLines = oModel.getProperty("/lines");
      var oLast = aLines[aLines.length - 1] || {};
      var oNew = emptyLine();
      oNew.costCenter = oLast.costCenter || ""; // herda da linha anterior (menos digitação)
      oModel.setProperty("/lines", aLines.concat([oNew]));
    },

    onRemoveLine: function (oEvent) {
      var oModel = this.getModel("req");
      var iIdx = Number(oEvent.getSource().getBindingContext("req").getPath().split("/").pop());
      var aLines = oModel.getProperty("/lines").slice();
      aLines.splice(iIdx, 1);
      oModel.setProperty("/lines", aLines);
      this.onRecalc();
    },

    onRecalc: function () {
      var oModel = this.getModel("req");
      var fTotal = (oModel.getProperty("/lines") || []).reduce(function (s, l) {
        return s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
      }, 0);
      oModel.setProperty("/total", Math.round(fTotal * 100) / 100);
    },

    // ---- sugestões (busca no B1 via BFF) ----
    onItemSuggest: function (oEvent) {
      var sTerm = oEvent.getParameter("suggestValue");
      var oMd = this.getModel("md");
      clearTimeout(this._tItem);
      this._tItem = setTimeout(function () {
        this.api.get("/api/m/compras/items?q=" + encodeURIComponent(sTerm)).then(function (a) {
          oMd.setProperty("/itemSuggest", a);
        }).catch(function () {});
      }.bind(this), 250);
    },

    onItemSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var oCtx = oEvent.getSource().getBindingContext("req");
      var oData = oItem.getBindingContext("md").getObject();
      var oModel = this.getModel("req");
      oModel.setProperty("itemCode", oData.itemCode, oCtx);
      oModel.setProperty("itemLabel", oData.itemCode + " - " + oData.itemName, oCtx);
      oModel.setProperty("uom", oData.uom, oCtx);
      var bInBranch = (this.getModel("md").getProperty("/whFiltered") || []).some(function (w) { return w.code === oData.defaultWarehouse; });
      if (!oCtx.getProperty("warehouse") && oData.defaultWarehouse && bInBranch) {
        oModel.setProperty("warehouse", oData.defaultWarehouse, oCtx);
      }
    },

    onItemTyped: function (oEvent) { // digitou sem escolher da lista: invalida o código
      var oCtx = oEvent.getSource().getBindingContext("req");
      this.getModel("req").setProperty("itemCode", "", oCtx);
      this.getModel("req").setProperty("uom", "", oCtx);
    },

    onVendorTyped: function (oEvent) {
      this.getModel("req").setProperty("vendor", "", oEvent.getSource().getBindingContext("req"));
    },

    onVendorSuggest: function (oEvent) {
      var sTerm = oEvent.getParameter("suggestValue");
      var oMd = this.getModel("md");
      clearTimeout(this._tVendor);
      this._tVendor = setTimeout(function () {
        this.api.get("/api/m/compras/vendors?q=" + encodeURIComponent(sTerm)).then(function (a) {
          oMd.setProperty("/vendorSuggest", a);
        }).catch(function () {});
      }.bind(this), 250);
    },

    onVendorSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var oCtx = oEvent.getSource().getBindingContext("req");
      var oData = oItem.getBindingContext("md").getObject();
      this.getModel("req").setProperty("vendor", oData.cardCode, oCtx);
      this.getModel("req").setProperty("vendorLabel", oData.cardCode + " - " + oData.cardName, oCtx);
    },

    // ---- envio ----
    onSubmit: function () {
      var oData = this.getModel("req").getData();
      var bInvalid = oData.lines.some(function (l) { return l.itemLabel && !l.itemCode; });
      if (bInvalid) { MessageBox.warning(this.text("invalidItem")); return; }
      var aLines = oData.lines.filter(function (l) { return l.itemCode; });
      if (!aLines.length) { MessageBox.warning(this.text("noLines")); return; }

      if (this.getModel("md").getProperty("/branches").length && !oData.branch) {
        MessageBox.warning(this.text("branchRequired"));
        return;
      }
      var oPayload = {
        branch: oData.branch || undefined,
        requiredDate: oData.requiredDate,
        comments: oData.comments,
        lines: aLines.map(function (l) {
          return {
            itemCode: l.itemCode, quantity: l.quantity, unitPrice: l.unitPrice,
            costCenter: l.costCenter, warehouse: l.warehouse, vendor: l.vendor
          };
        })
      };
      this.busy(this.attachmentPayload().then(function (aAtt) {
        oPayload.attachments = aAtt;
        return this.api.post("/api/m/compras/purchase-requests", oPayload);
      }.bind(this))).then(function (oRes) {
        var sKey = oRes.source === "draft" ? "submittedPending" : "submitted";
        this.toast(this.text(sKey, [oRes.docNum]));
        this.navToDoc("pr", oRes.source, oRes.entry, null, true);
      }.bind(this)).catch(function () {});
    }
  });
});
