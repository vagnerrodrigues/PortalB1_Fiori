sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (BaseController, JSONModel, Filter, FilterOperator) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.MyRequests", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.getRouter().getRoute("compras.mine").attachPatternMatched(this.onRefresh, this);
    },

    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/compras/purchase-requests")).then(function (a) {
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },

    onSearch: function (oEvent) {
      var s = oEvent.getParameter("newValue");
      var aFilters = s ? [new Filter({ filters: [
        new Filter("comments", FilterOperator.Contains, s),
        new Filter({ path: "docNum", test: function (v) { return String(v).indexOf(s) >= 0; } }),
        new Filter({ path: "entry", test: function (v) { return String(v).indexOf(s) >= 0; } })
      ], and: false })] : [];
      this.byId("list").getBinding("items").filter(aFilters);
    },

    onOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("list").getObject();
      this.getRouter().navTo("compras.detail", { source: o.source, entry: o.entry });
    },

    onNew: function () { this.getRouter().navTo("compras.new"); }
  });
});
