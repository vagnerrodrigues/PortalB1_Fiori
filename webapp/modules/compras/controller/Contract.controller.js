sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel"
], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Contract", {
    onInit: function () {
      this.setModel(new JSONModel({}), "ag");
      this.getRouter().getRoute("compras.contract").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      this._no = oEvent.getParameter("arguments").no;
      this.getModel("ag").setData({});
      this.busy(this.api.get("/api/m/compras/agreements/" + this._no)).then(function (o) {
        this.getModel("ag").setData(o);
      }.bind(this)).catch(function () {});
    },

    onStatus: function (sStatus) {
      this.busy(this.api.post("/api/m/compras/agreements/" + this._no + "/status", { status: sStatus })).then(function (o) {
        this.getModel("ag").setData(o);
      }.bind(this)).catch(function () {});
    },

    onNewOrder: function () {
      var o = this.getModel("ag").getData();
      this.getRouter().navTo("compras.orderNew", { "?query": { cardCode: o.cardCode, agreement: String(o.agreementNo) } });
    }
  });
});
