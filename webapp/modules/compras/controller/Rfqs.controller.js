sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (BaseController, JSONModel, Filter, FilterOperator) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Rfqs", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.getRouter().getRoute("compras.rfqs").attachPatternMatched(this.onRefresh, this);
    },

    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/compras/rfq")).then(function (a) {
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },

    onSearch: function (oEvent) {
      var s = oEvent.getParameter("newValue");
      var aFilters = s ? [new Filter({ filters: [
        new Filter("title", FilterOperator.Contains, s),
        new Filter({ path: "id", test: function (v) { return String(v).indexOf(s) >= 0; } })
      ], and: false })] : [];
      this.byId("list").getBinding("items").filter(aFilters);
    },

    onOpen: function (oEvent) {
      this.getRouter().navTo("compras.rfq", { id: oEvent.getSource().getBindingContext("list").getProperty("id") });
    },

    onNew: function () { this.getRouter().navTo("compras.rfqNew"); }
  });
});
