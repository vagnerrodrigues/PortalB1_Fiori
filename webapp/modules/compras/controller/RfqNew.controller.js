sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, Filter, FilterOperator, MessageBox) {
  "use strict";

  return BaseController.extend("portal.b1.modules.compras.controller.RfqNew", {
    onInit: function () {
      this.setModel(new JSONModel({ branches: [], itemSuggest: [], vendorSuggest: [] }), "md");
      this.setModel(new JSONModel(), "rfq");
      this.setModel(new JSONModel([]), "src");
      this.getRouter().getRoute("compras.rfqNew").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      if (!this.routeOk()) { return; }
      var dDeadline = new Date(); dDeadline.setDate(dDeadline.getDate() + 3);
      this._defaultDate = new Date(); this._defaultDate.setDate(this._defaultDate.getDate() + 10);
      this.getModel("rfq").setData({ title: "", branch: "", deadline: this.isoDate(dDeadline), minDate: new Date(), message: "", lines: [], suppliers: [] });
      this.api.get("/api/m/compras/branches").then(function (a) {
        this.getModel("md").setProperty("/branches", a);
        if (a.length === 1) { this.getModel("rfq").setProperty("/branch", String(a[0].id)); }
      }.bind(this)).catch(function () {});
    },

    // ---------- itens das solicitações ----------
    onFromRequests: function () {
      var sBranch = this.getModel("rfq").getProperty("/branch");
      var p = this._dialog ? Promise.resolve(this._dialog) : this.loadFragment({ name: "portal.b1.modules.compras.view.fragments.RfqSources" })
        .then(function (d) { this._dialog = d; return d; }.bind(this));
      this.busy(Promise.all([p, this.api.get("/api/m/compras/rfq/sources" + (sBranch ? "?branch=" + encodeURIComponent(sBranch) : ""))]))
        .then(function (a) {
          var aChosen = this.getModel("rfq").getProperty("/lines");
          this.getModel("src").setData(a[1].filter(function (l) {
            return !aChosen.some(function (c) { return c.prEntry === l.prEntry && c.prLine === l.prLine; });
          }));
          this.byId("sourcesTable").removeSelections(true);
          a[0].open();
        }.bind(this)).catch(function () {});
    },

    onSourcesSearch: function (oEvent) {
      var s = oEvent.getParameter("newValue");
      this.byId("sourcesTable").getBinding("items").filter(s ? [new Filter({ filters: [
        new Filter("itemCode", FilterOperator.Contains, s), new Filter("itemName", FilterOperator.Contains, s),
        new Filter("requester", FilterOperator.Contains, s),
        new Filter({ path: "prDocNum", test: function (v) { return String(v).indexOf(s) >= 0; } })
      ], and: false })] : []);
    },

    onSourcesConfirm: function () {
      var oModel = this.getModel("rfq");
      var aSel = this.byId("sourcesTable").getSelectedContexts().map(function (c) { return c.getObject(); });
      var aLines = oModel.getProperty("/lines").concat(aSel.map(function (l) { return Object.assign({ manual: false }, l); }));
      oModel.setProperty("/lines", aLines);
      if (!oModel.getProperty("/branch") && aSel.length && aSel[0].branch) { oModel.setProperty("/branch", String(aSel[0].branch)); }
      this._dialog.close();
    },

    onSourcesClose: function () { this._dialog.close(); },

    // ---------- item avulso ----------
    onAddManual: function () {
      var oModel = this.getModel("rfq");
      oModel.setProperty("/lines", oModel.getProperty("/lines").concat([{
        manual: true, itemCode: "", itemLabel: "", itemName: "", uom: "", quantity: 1, requiredDate: this.isoDate(this._defaultDate)
      }]));
    },

    onItemSuggest: function (oEvent) {
      this.suggest("/api/m/compras/items?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/itemSuggest");
    },

    onItemSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var oCtx = oEvent.getSource().getBindingContext("rfq");
      var d = oItem.getBindingContext("md").getObject();
      var oModel = this.getModel("rfq");
      oModel.setProperty("itemCode", d.itemCode, oCtx);
      oModel.setProperty("itemName", d.itemName, oCtx);
      oModel.setProperty("itemLabel", d.itemCode + " - " + d.itemName, oCtx);
      oModel.setProperty("uom", d.uom, oCtx);
    },

    onItemTyped: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("rfq");
      this.getModel("rfq").setProperty("itemCode", "", oCtx);
    },

    onRemoveLine: function (oEvent) {
      this._removeAt("/lines", oEvent.getSource().getBindingContext("rfq"));
    },

    _removeAt: function (sPath, oCtx) {
      var oModel = this.getModel("rfq");
      var i = Number(oCtx.getPath().split("/").pop());
      var a = oModel.getProperty(sPath).slice();
      a.splice(i, 1);
      oModel.setProperty(sPath, a);
    },

    // ---------- fornecedores ----------
    onSupplierSuggest: function (oEvent) {
      this.suggest("/api/m/compras/vendors?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/vendorSuggest");
    },

    onSupplierPick: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      var oInput = this.byId("supplierInput");
      if (!oItem) { return; }
      var d = oItem.getBindingContext("md").getObject();
      var oModel = this.getModel("rfq");
      setTimeout(function () { oInput.setValue(""); }, 0);
      if (oModel.getProperty("/suppliers").some(function (s) { return s.cardCode === d.cardCode; })) { return; }
      var aSup = oModel.getProperty("/suppliers").concat([{ cardCode: d.cardCode, cardName: d.cardName, email: "" }]);
      oModel.setProperty("/suppliers", aSup);
      var iIdx = aSup.length - 1;
      this.api.get("/api/m/compras/vendors/" + encodeURIComponent(d.cardCode) + "/contact").then(function (c) {
        if (c.email && !oModel.getProperty("/suppliers/" + iIdx + "/email")) { oModel.setProperty("/suppliers/" + iIdx + "/email", c.email); }
      }).catch(function () {});
    },

    onRemoveSupplier: function (oEvent) {
      this._removeAt("/suppliers", oEvent.getSource().getBindingContext("rfq"));
    },

    // ---------- envio ----------
    onSubmit: function () {
      var d = this.getModel("rfq").getData();
      if (d.lines.some(function (l) { return l.manual && !l.itemCode; })) { MessageBox.warning(this.text("invalidItem")); return; }
      if (!d.lines.length) { MessageBox.warning(this.text("rfqNeedLines")); return; }
      if (!d.suppliers.length) { MessageBox.warning(this.text("rfqNeedSuppliers")); return; }
      if (this.getModel("md").getProperty("/branches").length && !d.branch) { MessageBox.warning(this.text("branchRequired")); return; }
      var oPayload = {
        title: d.title, deadline: d.deadline, message: d.message, branch: d.branch || undefined,
        lines: d.lines.map(function (l) {
          return l.manual
            ? { itemCode: l.itemCode, itemName: l.itemName, uom: l.uom, quantity: l.quantity, requiredDate: l.requiredDate }
            : { prEntry: l.prEntry, prDocNum: l.prDocNum, prLine: l.prLine, itemCode: l.itemCode, itemName: l.itemName, uom: l.uom,
              quantity: l.quantity, requiredDate: l.requiredDate, warehouse: l.warehouse, costCenter: l.costCenter, freeText: l.freeText };
        }),
        suppliers: d.suppliers.map(function (s) { return { cardCode: s.cardCode, email: (s.email || "").trim() || undefined }; })
      };
      this.busy(this.api.post("/api/m/compras/rfq", oPayload)).then(function (o) {
        this.toast(this.text("rfqSent", [o.id, o.suppliers.filter(function (s) { return s.pq; }).length]));
        this.getRouter().navTo("compras.rfq", { id: o.id }, true);
      }.bind(this)).catch(function () {});
    }
  });
});
