sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (BaseController, JSONModel, Filter, FilterOperator) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Offers", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.setModel(new JSONModel({ status: "open" }), "view");
      this.getRouter().getRoute("compras.offers").attachPatternMatched(this.onRefresh, this);
    },

    onRefresh: function () {
      if (!this.routeOk()) { return; }
      var sStatus = this.getModel("view").getProperty("/status");
      this.busy(this.api.get("/api/m/compras/offers?status=" + sStatus)).then(function (a) {
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },

    onSearch: function (oEvent) {
      var s = oEvent.getParameter("newValue");
      var aFilters = s ? [new Filter({ filters: [
        new Filter("cardName", FilterOperator.Contains, s),
        new Filter("cardCode", FilterOperator.Contains, s),
        new Filter("comments", FilterOperator.Contains, s),
        new Filter({ path: "docNum", test: function (v) { return String(v).indexOf(s) >= 0; } })
      ], and: false })] : [];
      this.byId("list").getBinding("items").filter(aFilters);
    },

    onOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("list").getObject();
      this.navToDoc("pq", o.source, o.entry);
    }
  });
});
