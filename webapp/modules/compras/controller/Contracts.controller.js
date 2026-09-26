sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (BaseController, JSONModel, Filter, FilterOperator) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Contracts", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.getRouter().getRoute("compras.contracts").attachPatternMatched(this.onRefresh, this);
    },

    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/compras/agreements")).then(function (a) {
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },

    onSearch: function (oEvent) {
      var s = oEvent.getParameter("newValue");
      this.byId("list").getBinding("items").filter(s ? [new Filter({ filters: [
        new Filter("description", FilterOperator.Contains, s), new Filter("cardName", FilterOperator.Contains, s),
        new Filter("cardCode", FilterOperator.Contains, s),
        new Filter({ path: "agreementNo", test: function (v) { return String(v).indexOf(s) >= 0; } })
      ], and: false })] : []);
    },

    onOpen: function (oEvent) {
      this.getRouter().navTo("compras.contract", { no: oEvent.getSource().getBindingContext("list").getProperty("agreementNo") });
    },

    onNew: function () { this.getRouter().navTo("compras.contractNew"); }
  });
});
