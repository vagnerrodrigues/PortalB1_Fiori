sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter"
], function (BaseController, JSONModel, Filter, FilterOperator, Sorter) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Contracts", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.setModel(new JSONModel({ sort: "agreementNo", dir: "Descending" }), "view");
      this.getRouter().getRoute("compras.contracts").attachPatternMatched(this.onRefresh, this);
    },

    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/compras/agreements")).then(function (a) {
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },

    /**
     * Ordenação por coluna: 1º clique = maior primeiro (valores, consumo, datas) ou A-Z (textos);
     * clicar de novo na mesma coluna inverte.
     */
    onSort: function (sKey) {
      var oView = this.getModel("view");
      var bText = sKey === "cardName" || sKey === "status";
      var bDesc = oView.getProperty("/sort") === sKey ? oView.getProperty("/dir") !== "Descending" : !bText;
      oView.setProperty("/sort", sKey);
      oView.setProperty("/dir", bDesc ? "Descending" : "Ascending");
      var fnNum = function (a, b) { return (Number(a) || 0) - (Number(b) || 0); };
      var fnText = function (a, b) { return String(a || "").localeCompare(String(b || ""), "pt-BR"); };
      this.byId("list").getBinding("items").sort(new Sorter(sKey, bDesc, false,
        sKey === "plannedAmount" || sKey === "consumption" || sKey === "agreementNo" ? fnNum : fnText));
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
