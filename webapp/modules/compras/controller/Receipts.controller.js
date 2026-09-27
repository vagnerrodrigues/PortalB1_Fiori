sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (BaseController, JSONModel, Filter, FilterOperator) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Receipts", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.getRouter().getRoute("compras.receipts").attachPatternMatched(this.onRefresh, this);
    },

    /** Pedidos em aberto: atrasados primeiro, depois pela entrega mais próxima. */
    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/compras/receipts/pending")).then(function (a) {
        a.sort(function (x, y) { return (y.late - x.late) || String(x.dueDate || "9").localeCompare(String(y.dueDate || "9")); });
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },

    onSearch: function (oEvent) {
      var s = oEvent.getParameter("newValue");
      this.byId("list").getBinding("items").filter(s ? [new Filter({ filters: [
        new Filter("cardName", FilterOperator.Contains, s), new Filter("cardCode", FilterOperator.Contains, s),
        new Filter({ path: "docNum", test: function (v) { return String(v).indexOf(s) >= 0; } })
      ], and: false })] : []);
    },

    onOpen: function (oEvent) {
      this.getRouter().navTo("compras.receive", { entry: oEvent.getSource().getBindingContext("list").getProperty("entry") });
    }
  });
});
